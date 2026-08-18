import { z } from "zod";
import { audit, uuidv7 } from "@deedwell/database";
import { runAgentTask } from "@deedwell/agent-runtime";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import {
  ExtractedRequirement,
  OrgFact,
  type BudgetOutput,
  type LogicModelOutput,
  type RequirementsExtractionOutput,
  type ReviewPanelOutput,
  type SectionDraftOutput,
  type SectionPlanOutput,
} from "@deedwell/schemas";
import {
  budgetSpecialist,
  eligibilityAnalyst,
  grantWriter,
  melSpecialist,
  programPlanner,
  requirementsAnalyst,
  reviewerPanel,
} from "./agents.js";
import { upsertArtifactVersion } from "./artifacts.js";
import { extractDocumentText } from "./documents.js";
import { verifyClaims } from "./claims.js";
import { deriveEligibilityRules, evaluateEligibility } from "./eligibility.js";
import { computeBidDecision, computeApplicationViability, computeMissionFit } from "./bidnobid.js";
import { evaluateCompliance } from "./compliance.js";
import { passportStatus } from "./passport.js";
import { scanForInjection } from "./injection.js";
import { renderFullExport, budgetCsv } from "./export-full.js";
import { renderFullExportDocx } from "./export-docx.js";
import { renderFullExportPdf } from "./export-pdf.js";
import type { GrantServices } from "./workflow.js";

export const GRANT_FULL_WORKFLOW = "grant-application-full";

const Input = z.object({ opportunityId: z.string().uuid(), fileId: z.string().uuid() });
const PlannedSection = z.object({
  title: z.string(),
  objective: z.string(),
  wordLimit: z.number().int().nullable(),
  requirementLines: z.array(z.number().int()),
});

type Ctx = StepContext<GrantServices>;

async function fetchFacts(ctx: Ctx, agent: typeof grantWriter): Promise<OrgFact[]> {
  const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
    ctx.client,
    { tenantId: ctx.tenantId, userId: null, agentKey: agent.agentKey, runId: ctx.runId },
    agent,
    "fetch_org_facts",
    {}
  );
  return facts;
}

async function recordModelUsage(ctx: Ctx, agentKey: string, tokens: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,$3,'model_tokens',$4,$5)`,
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey })]
  );
}

async function getOpportunity(ctx: Ctx, id: string) {
  const { rows } = await ctx.client.query(
    `SELECT id, title, funder, deadline::text AS deadline, funding_min, funding_max,
            opportunity_number, file_id, source_url, status
     FROM grant_opportunities WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new Error(`Opportunity ${id} not found in tenant scope`);
  return rows[0] as {
    id: string; title: string; funder: string; deadline: string | null;
    funding_min: string | null; funding_max: string | null;
    opportunity_number: string | null; file_id: string | null; source_url: string | null;
    status: string;
  };
}

async function latestApproval(ctx: Ctx, kind: string) {
  const { rows } = await ctx.client.query(
    `SELECT id, status, note FROM approvals WHERE run_id = $1 AND kind = $2
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.runId, kind]
  );
  return rows[0] as { id: string; status: string; note: string | null } | undefined;
}

/** Candidate research URLs: the opportunity's own page plus links found in
 *  the announcement text. Deduped, http(s) only, bounded. */
export function collectResearchUrls(
  sourceUrl: string | null,
  documentText: string,
  max: number
): string[] {
  // First-line SSRF filter: announcement text is untrusted, so internal
  // hosts never even reach the fetcher (which guards again itself).
  const isPublic = (raw: string): boolean => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return false;
      return true;
    } catch { return false; }
  };
  const urls: string[] = [];
  if (sourceUrl?.startsWith("http") && isPublic(sourceUrl)) urls.push(sourceUrl);
  for (const match of documentText.matchAll(/https?:\/\/[^\s<>")\]]+/g)) {
    const cleaned = match[0].replace(/[.,;:]+$/, "");
    if (isPublic(cleaned) && !urls.includes(cleaned)) urls.push(cleaned);
    if (urls.length >= max) break;
  }
  return urls.slice(0, max);
}

export function buildGrantFullWorkflow(): WorkflowDefinition<GrantServices> {
  return {
    name: GRANT_FULL_WORKFLOW,
    version: 1,
    initialStep: "parse_document",
    stepBudget: 60,
    steps: {
      // ------------------------------------------------------------------
      async parse_document(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const { rows } = await ctx.client.query("SELECT storage_key, filename FROM files WHERE id = $1", [
          input.fileId,
        ]);
        if (!rows[0]) throw new Error(`File ${input.fileId} not found in tenant scope`);
        const raw = await ctx.services.storage.get(rows[0].storage_key);
        const { text } = await extractDocumentText(raw, String(rows[0].filename));
        if (!text.trim()) throw new Error("Could not extract any text from the uploaded document");
        const warnings = scanForInjection(text);
        await ctx.client.query(
          "UPDATE grant_opportunities SET injection_warnings = $2 WHERE id = $1",
          [input.opportunityId, JSON.stringify(warnings)]
        );
        if (warnings.length) {
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: requirementsAnalyst.agentKey,
            action: "document.injection_flagged", entityType: "grant_opportunity",
            entityId: input.opportunityId, metadata: { warnings },
          });
        }
        return { state: { ...ctx.state, documentText: text }, next: "research_sources" };
      },

      // ------------------------------------------------------------------
      // Stage 2 (spec §4-5): really read the opportunity's linked pages.
      // Every page visited — or unreachable — becomes a research_sources row
      // and a live timeline event. No fetcher configured → honest skip.
      async research_sources(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const opportunity = await getOpportunity(ctx, input.opportunityId);
        const documentText = z.string().parse(ctx.state.documentText);
        const fetcher = ctx.services.research;

        const candidates = collectResearchUrls(opportunity.source_url, documentText, 4);
        const recordPageEvent = (title: string, status: string, url: string | null, error?: string) =>
          ctx.client.query(
            `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
               status, agent_key, metadata, error, completed_at)
             VALUES ($1,$2,$3,$4,'research:page',$5,'',$6,'grant.opportunity_researcher',$7,$8,now())`,
            [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId, title, status,
             JSON.stringify({ url }), error ?? null]
          );

        if (!fetcher || !candidates.length) {
          await ctx.client.query(
            `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
               status, agent_key, completed_at)
             VALUES ($1,$2,$3,$4,'research:skipped',$5,$6,'completed','grant.opportunity_researcher',now())`,
            [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId,
             "Web research skipped",
             fetcher ? "The announcement contains no researchable links." : "No research fetcher is configured on this server (RESEARCH_FETCH=off)."]
          );
          return { state: { ...ctx.state, researchNotes: [] }, next: "extract_requirements" };
        }

        const notes: string[] = [];
        for (const url of candidates) {
          const page = await fetcher.fetchPage(url);
          const host = ((): string => { try { return new URL(page.finalUrl || url).hostname; } catch { return url; } })();
          await ctx.client.query(
            `INSERT INTO research_sources (id, tenant_id, project_id, url, title, publisher,
               source_type, reliability, fetch_status, excerpt)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [uuidv7(), ctx.tenantId, ctx.projectId, page.finalUrl || url,
             page.title || `${host} (${page.status})`, host,
             url === opportunity.source_url ? "OPPORTUNITY_PAGE" : "LINKED_PAGE",
             page.status !== "retrieved" ? "UNVERIFIED" : host.endsWith(".gov") ? "SECONDARY_OFFICIAL" : "UNVERIFIED",
             page.status, page.text.slice(0, 1200)]
          );
          await recordPageEvent(
            page.status === "retrieved"
              ? `Read ${host} — ${page.title || "untitled page"}`.slice(0, 200)
              : `Could not read ${host}`,
            page.status === "retrieved" ? "completed" : "failed",
            page.finalUrl || url,
            page.error
          );
          if (page.status === "retrieved" && page.text) {
            notes.push(`${page.title || host} <${page.finalUrl || url}>: ${page.text.slice(0, 600)}`);
          }
        }
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: "grant.opportunity_researcher",
          action: "research.pages_fetched", entityType: "grant_opportunity", entityId: input.opportunityId,
          metadata: { attempted: candidates.length, retrieved: notes.length },
        });
        return { state: { ...ctx.state, researchNotes: notes.slice(0, 4) }, next: "extract_requirements" };
      },

      // ------------------------------------------------------------------
      async extract_requirements(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const opportunity = await getOpportunity(ctx, input.opportunityId);
        const text = z.string().parse(ctx.state.documentText);

        const result = await runAgentTask<RequirementsExtractionOutput>(
          ctx.services.provider, requirementsAnalyst,
          "Extract every application requirement from the attached grant announcement.",
          [{ label: "document", content: text }]
        );
        await recordModelUsage(ctx, requirementsAnalyst.agentKey, result.tokensEstimated);

        await ctx.services.gateway.invoke(
          ctx.client,
          { tenantId: ctx.tenantId, userId: null, agentKey: requirementsAnalyst.agentKey, runId: ctx.runId },
          requirementsAnalyst, "record_requirements",
          { opportunityId: input.opportunityId, requirements: result.output.requirements }
        );

        const rules = deriveEligibilityRules(result.output.requirements, opportunity.deadline);
        for (const rule of rules) {
          await ctx.client.query(
            `INSERT INTO eligibility_rules (id, tenant_id, opportunity_id, rule_key, kind, params, source_line)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (opportunity_id, rule_key) DO NOTHING`,
            [uuidv7(), ctx.tenantId, input.opportunityId, rule.ruleKey, rule.kind,
             JSON.stringify(rule.params), rule.sourceLine]
          );
        }

        await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "compliance_matrix", title: `Compliance matrix — ${opportunity.title}`,
          content: { requirements: result.output.requirements, documentSummary: result.output.documentSummary },
          agentKey: requirementsAnalyst.agentKey,
          changeSummary: `Extracted ${result.output.requirements.length} requirements, derived ${rules.length} eligibility rules`,
        });

        return {
          state: { ...ctx.state, requirements: result.output.requirements, eligibilityRules: rules },
          next: "eligibility_check",
        };
      },

      // ------------------------------------------------------------------
      async eligibility_check(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const rules = deriveEligibilityRules(
          z.array(ExtractedRequirement).parse(ctx.state.requirements),
          (await getOpportunity(ctx, input.opportunityId)).deadline
        );
        const facts = await fetchFacts(ctx, eligibilityAnalyst);
        const evaluation = evaluateEligibility(rules, facts);

        // Append-only by design (app role has no DELETE): each evaluation is
        // a new row; readers take the latest per run as the current result.
        await ctx.client.query(
          `INSERT INTO eligibility_results (id, tenant_id, opportunity_id, run_id, overall, rule_findings, missing_facts)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), ctx.tenantId, input.opportunityId, ctx.runId, evaluation.overall,
           JSON.stringify(evaluation.findings), JSON.stringify(evaluation.missingFacts)]
        );
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: eligibilityAnalyst.agentKey,
          action: "eligibility.evaluated", entityType: "grant_opportunity",
          entityId: input.opportunityId,
          metadata: { overall: evaluation.overall, missing: evaluation.missingFacts },
        });

        if (evaluation.overall === "insufficient_information" && evaluation.missingFacts.length) {
          return {
            state: { ...ctx.state, eligibility: evaluation },
            wait: {
              kind: "info",
              payload: { missingFacts: evaluation.missingFacts },
              resumeStep: "eligibility_check",
            },
          };
        }
        return { state: { ...ctx.state, eligibility: evaluation }, next: "bid_no_bid" };
      },

      // ------------------------------------------------------------------
      async bid_no_bid(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const opportunity = await getOpportunity(ctx, input.opportunityId);
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const eligibility = (ctx.state.eligibility as { overall: string }).overall;
        const facts = await fetchFacts(ctx, eligibilityAnalyst);
        const passport = passportStatus(facts);

        const budgetFact = facts.find((f) => f.key === "annual_budget");
        const annualBudgetUsd = budgetFact
          ? Number(budgetFact.value.replace(/[^0-9.]/g, "")) || null
          : null;
        const daysToDeadline = opportunity.deadline
          ? Math.floor((new Date(opportunity.deadline).getTime() - Date.now()) / 86_400_000)
          : null;

        const bid = computeBidDecision({
          eligibility: eligibility as never,
          daysToDeadline,
          passportCompleteness: passport.completeness,
          fundingMax: opportunity.funding_max ? Number(opportunity.funding_max) : null,
          annualBudgetUsd,
          mandatoryRequirementCount: requirements.filter((r) => r.mandatory).length,
        });
        // Mission Fit and Application Viability are independent — a great-fit
        // opportunity that's already closed is still a great fit, just not
        // viable right now (spec: "95% fit, 0% viability — closed").
        const missionFit = computeMissionFit({
          fundingMax: opportunity.funding_max ? Number(opportunity.funding_max) : null,
          annualBudgetUsd,
          passportCompleteness: passport.completeness,
        });
        const viability = computeApplicationViability({
          eligibility: eligibility as never,
          opportunityStatus: opportunity.status,
          daysToDeadline,
        });

        const bidId = uuidv7();
        await ctx.client.query(
          `INSERT INTO bid_decisions (id, tenant_id, opportunity_id, run_id, scores, total, recommendation,
             rationale, mission_fit_score, mission_fit_rationale, viability, viability_rationale)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [bidId, ctx.tenantId, input.opportunityId, ctx.runId,
           JSON.stringify(bid.dimensions), bid.total, bid.recommendation, bid.rationale,
           missionFit.score, missionFit.rationale, viability.viability, viability.rationale]
        );

        // Transparent fit assessment (spec §5 Stage 3): every entry below is
        // derived from the actual eligibility findings and score dimensions —
        // nothing is synthesized to pad the card.
        const elig = ctx.state.eligibility as {
          overall: string;
          findings: Array<{ ruleKey: string; status: string; evidence?: string }>;
          missingFacts: string[];
        };
        const fit = {
          qualifies: elig.findings.filter((f) => f.status === "pass")
            .map((f) => f.ruleKey.replace(/_/g, " ")),
          disqualifiers: elig.findings.filter((f) => f.status === "fail")
            .map((f) => `${f.ruleKey.replace(/_/g, " ")}${f.evidence ? ` — ${f.evidence}` : ""}`),
          risks: bid.dimensions.filter((d) => d.score <= 2).map((d) => d.note),
          missingEvidence: elig.missingFacts,
          nextAction: bid.recommendation === "apply"
            ? "Approve to start drafting."
            : bid.recommendation === "needs_review"
              ? "Review the risks and missing evidence before deciding."
              : "The team recommends passing — see the disqualifiers and risks.",
        };
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'bid_decision',$4)`,
          [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
            bidId, recommendation: bid.recommendation, total: bid.total,
            rationale: bid.rationale, dimensions: bid.dimensions, fit,
            missionFit: { score: missionFit.score, rationale: missionFit.rationale },
            viability: { status: viability.viability, rationale: viability.rationale },
            warnings: [...fit.disqualifiers, ...fit.risks],
          })]
        );
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: "grant.funding_strategist",
          action: "bid.recommended", entityType: "bid_decision", entityId: bidId,
          metadata: { recommendation: bid.recommendation, total: bid.total, viability: viability.viability },
        });

        return {
          state: { ...ctx.state, bid: { id: bidId, ...bid, missionFit, viability } },
          wait: { kind: "approval", payload: { approvalId, kind: "bid_decision" }, resumeStep: "bid_gate" },
        };
      },

      // ------------------------------------------------------------------
      async bid_gate(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const approval = await latestApproval(ctx, "bid_decision");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "bid_gate" },
          };
        }
        const decision = approval.status === "approved" ? "pursue" : "decline";
        await ctx.client.query(
          `UPDATE bid_decisions SET decision = $2, decided_at = now(),
             decided_by = (SELECT decided_by FROM approvals WHERE id = $3)
           WHERE run_id = $1`,
          [ctx.runId, decision, approval.id]
        );
        if (decision === "decline") {
          await ctx.client.query(
            "UPDATE grant_opportunities SET status = 'not_pursued' WHERE id = $1",
            [input.opportunityId]
          );
          return { state: { ...ctx.state, outcome: "not_pursued" }, complete: true };
        }
        await ctx.client.query(
          "UPDATE grant_opportunities SET status = 'in_progress' WHERE id = $1",
          [input.opportunityId]
        );
        const existing = await ctx.client.query(
          "SELECT id FROM grant_applications WHERE run_id = $1", [ctx.runId]
        );
        const applicationId = existing.rows[0]?.id ?? uuidv7();
        if (!existing.rows[0]) {
          await ctx.client.query(
            `INSERT INTO grant_applications (id, tenant_id, project_id, opportunity_id, run_id, status)
             VALUES ($1,$2,$3,$4,$5,'planning')`,
            [applicationId, ctx.tenantId, ctx.projectId, input.opportunityId, ctx.runId]
          );
        }
        return { state: { ...ctx.state, applicationId }, next: "plan_application" };
      },

      // ------------------------------------------------------------------
      async plan_application(ctx): Promise<StepResult> {
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const facts = await fetchFacts(ctx, programPlanner);
        // Feedback from a rejected strategy reaches the planner instead of a
        // blind re-generation (same mechanism draft_sections uses for a
        // rejected export's reviewer notes).
        const strategyFeedback = z.string().nullable().parse(ctx.state.strategyFeedback ?? null);

        const result = await runAgentTask<SectionPlanOutput>(
          ctx.services.provider, programPlanner,
          "Plan the application sections and program activities from the attached requirements.",
          [
            { label: "requirements", content: JSON.stringify(requirements) },
            { label: "org_facts", content: JSON.stringify(facts) },
            ...(strategyFeedback
              ? [{ label: "strategy_feedback", content: strategyFeedback.slice(0, 2000) }]
              : []),
          ]
        );
        await recordModelUsage(ctx, programPlanner.agentKey, result.tokensEstimated);

        for (const [idx, section] of result.output.sections.entries()) {
          await ctx.client.query(
            `INSERT INTO application_sections (id, tenant_id, application_id, order_idx, title,
               objective, word_limit, requirement_lines)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (application_id, order_idx)
             DO UPDATE SET title = EXCLUDED.title, objective = EXCLUDED.objective,
               word_limit = EXCLUDED.word_limit, requirement_lines = EXCLUDED.requirement_lines,
               status = 'planned'`,
            [uuidv7(), ctx.tenantId, applicationId, idx, section.title, section.objective,
             section.wordLimit, JSON.stringify(section.requirementLines)]
          );
        }
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "application_plan", title: "Application plan",
          content: { sections: result.output.sections, activities: result.output.activities },
          agentKey: programPlanner.agentKey,
          changeSummary: `Planned ${result.output.sections.length} sections and ${result.output.activities.length} activities`,
        });

        // Strategy checkpoint (spec §13): a human reviews the section plan
        // and activities before any drafting starts, and can send it back
        // with feedback rather than only accept/decline drafted prose later.
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'strategy',$4)`,
          [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
            artifactId: artifact.artifactId,
            sections: result.output.sections,
            activities: result.output.activities,
          })]
        );
        return {
          state: {
            ...ctx.state,
            sections: result.output.sections,
            activities: result.output.activities,
            cursor: 0,
            flaggedClaims: 0,
            wordLimitViolations: [],
          },
          wait: { kind: "approval", payload: { approvalId, kind: "strategy" }, resumeStep: "strategy_gate" },
        };
      },

      // ------------------------------------------------------------------
      async strategy_gate(ctx): Promise<StepResult> {
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const approval = await latestApproval(ctx, "strategy");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "strategy_gate" },
          };
        }
        if (approval.status === "rejected") {
          return {
            state: { ...ctx.state, strategyFeedback: approval.note },
            next: "plan_application",
          };
        }
        await ctx.client.query(
          "UPDATE grant_applications SET status = 'drafting' WHERE id = $1", [applicationId]
        );
        return { state: { ...ctx.state, strategyFeedback: null }, next: "draft_sections" };
      },

      // ------------------------------------------------------------------
      async draft_sections(ctx): Promise<StepResult> {
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const sections = z.array(PlannedSection).parse(ctx.state.sections);
        const cursor = z.number().int().parse(ctx.state.cursor ?? 0);
        if (cursor >= sections.length) {
          return { state: ctx.state, next: "build_budget" };
        }
        const section = sections[cursor]!;
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const sectionReqs = requirements.filter(
          (r) => section.requirementLines.includes(r.sourceLocation.line) || r.kind === "narrative"
        );
        const facts = await fetchFacts(ctx, grantWriter);
        const usable = facts.filter((f) => f.status === "verified" || f.status === "user_certified");
        // Real research context (spec §4): retrieved page excerpts, each tagged
        // with its URL so drafted claims stay traceable to a source.
        const researchNotes = z.array(z.string()).parse(ctx.state.researchNotes ?? []);

        const result = await runAgentTask<SectionDraftOutput>(
          ctx.services.provider, grantWriter,
          `Draft a grant proposal section titled "${section.title}" that responds to the attached requirements using only the attached organizational facts. Objective: ${section.objective}`,
          [
            { label: "requirements", content: JSON.stringify(sectionReqs) },
            { label: "org_facts", content: JSON.stringify(usable) },
            ...(researchNotes.length
              ? [{ label: "funder_research", content: researchNotes.join("\n---\n").slice(0, 6000) }]
              : []),
            // Redraft after a rejected export: the panel's actual notes reach
            // the writer instead of blind re-generation.
            ...(((ctx.state.review as { recommendations?: string[] } | undefined)?.recommendations?.length)
              ? [{ label: "revision_recommendations",
                  content: (ctx.state.review as { recommendations: string[] }).recommendations.join("\n").slice(0, 3000) }]
              : []),
          ]
        );
        await recordModelUsage(ctx, grantWriter.agentKey, result.tokensEstimated);
        const { claims, flaggedCount } = verifyClaims(result.output.claims, facts);

        const warnings: string[] = [];
        const wordLimitViolations = z.array(z.string()).parse(ctx.state.wordLimitViolations ?? []);
        if (section.wordLimit && result.output.wordCount > section.wordLimit) {
          const msg = `"${section.title}" exceeds its ${section.wordLimit}-word limit (${result.output.wordCount} words).`;
          warnings.push(`Exceeds the ${section.wordLimit}-word limit (${result.output.wordCount} words).`);
          wordLimitViolations.push(msg);
        }
        if (flaggedCount > 0) warnings.push(`${flaggedCount} claim(s) lack verified evidence.`);

        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "grant_section", title: section.title,
          content: { title: section.title, body: result.output.body, claims,
                     wordCount: result.output.wordCount, warnings },
          agentKey: grantWriter.agentKey,
          changeSummary: `Drafted "${section.title}" (${result.output.wordCount} words, ${flaggedCount} flagged)`,
        });
        await ctx.client.query(
          `UPDATE application_sections SET artifact_id = $3, status = 'drafted'
           WHERE application_id = $1 AND order_idx = $2`,
          [applicationId, cursor, artifact.artifactId]
        );
        return {
          state: {
            ...ctx.state,
            cursor: cursor + 1,
            flaggedClaims: z.number().parse(ctx.state.flaggedClaims ?? 0) + flaggedCount,
            wordLimitViolations,
          },
          next: "draft_sections",
        };
      },

      // ------------------------------------------------------------------
      async build_budget(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const activities = z.array(z.string()).parse(ctx.state.activities);
        const opportunity = await getOpportunity(ctx, input.opportunityId);
        const facts = await fetchFacts(ctx, budgetSpecialist);

        const result = await runAgentTask<BudgetOutput>(
          ctx.services.provider, budgetSpecialist,
          "Build a line-item budget for the attached activities.",
          [
            { label: "activities", content: JSON.stringify(activities) },
            { label: "org_facts", content: JSON.stringify(facts) },
          ]
        );
        await recordModelUsage(ctx, budgetSpecialist.agentKey, result.tokensEstimated);

        const items = result.output.items.map((it) => ({
          ...it,
          amount: Math.round(it.quantity * it.unitCost * 100) / 100,
        }));
        const total = items.reduce((sum, it) => sum + it.amount, 0);

        // Deterministic validation — BRD: every activity with a cost is in the
        // budget and every item connects to an activity.
        const warnings: string[] = [];
        const costed = new Set(items.map((it) => it.activity));
        for (const activity of activities) {
          if (!costed.has(activity)) warnings.push(`Activity "${activity}" has no budget line.`);
        }
        const fundingMax = opportunity.funding_max ? Number(opportunity.funding_max) : null;
        if (fundingMax && total > fundingMax) {
          warnings.push(`Total $${total.toLocaleString()} exceeds the funding ceiling $${fundingMax.toLocaleString()}.`);
        }

        const budgetRow = await ctx.client.query(
          `INSERT INTO budgets (id, tenant_id, application_id, currency, total, warnings)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (application_id)
           DO UPDATE SET total = EXCLUDED.total, warnings = EXCLUDED.warnings
           RETURNING id`,
          [uuidv7(), ctx.tenantId, applicationId, result.output.currency, total, JSON.stringify(warnings)]
        );
        const budgetId = budgetRow.rows[0].id;
        for (const it of items) {
          await ctx.client.query(
            `INSERT INTO budget_items (id, tenant_id, budget_id, category, description, activity,
               quantity, unit_cost, amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (budget_id, md5(description))
             DO UPDATE SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost,
                           amount = EXCLUDED.amount, activity = EXCLUDED.activity`,
            [uuidv7(), ctx.tenantId, budgetId, it.category, it.description, it.activity,
             it.quantity, it.unitCost, it.amount]
          );
        }
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "budget", title: "Line-item budget",
          content: { currency: result.output.currency, items, total,
                     narrative: result.output.narrative, warnings },
          agentKey: budgetSpecialist.agentKey,
          changeSummary: `${items.length} line items totaling $${total.toLocaleString()}`,
        });
        await ctx.client.query("UPDATE budgets SET artifact_id = $2 WHERE id = $1", [budgetId, artifact.artifactId]);
        return { state: { ...ctx.state, budgetTotal: total, budgetWarnings: warnings }, next: "build_logic_model" };
      },

      // ------------------------------------------------------------------
      async build_logic_model(ctx): Promise<StepResult> {
        const activities = z.array(z.string()).parse(ctx.state.activities);
        const facts = await fetchFacts(ctx, melSpecialist);
        const result = await runAgentTask<LogicModelOutput>(
          ctx.services.provider, melSpecialist,
          "Produce a logic model and indicator table for the attached activities.",
          [
            { label: "activities", content: JSON.stringify(activities) },
            { label: "org_facts", content: JSON.stringify(facts) },
          ]
        );
        await recordModelUsage(ctx, melSpecialist.agentKey, result.tokensEstimated);
        await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "logic_model", title: "Logic model",
          content: result.output,
          agentKey: melSpecialist.agentKey,
          changeSummary: `${result.output.outcomes.length} outcomes, ${result.output.indicators.length} indicators`,
        });
        return { state: ctx.state, next: "review_panel" };
      },

      // ------------------------------------------------------------------
      async review_panel(ctx): Promise<StepResult> {
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const sections = z.array(PlannedSection).parse(ctx.state.sections);
        // Coverage the panel sees must reflect work that actually happened:
        // lines addressed by drafted sections, budget lines (a budget was
        // built two steps ago), and deadline lines (tracked on the
        // opportunity). Formatting, attachment, and unmapped requirements
        // stay UNCOVERED so the panel can flag them.
        const coveredLines = [
          ...new Set([
            ...sections.flatMap((s) => s.requirementLines),
            ...requirements.filter((r) => r.kind === "budget").map((r) => r.sourceLocation.line),
            ...requirements.filter((r) => r.kind === "deadline").map((r) => r.sourceLocation.line),
          ]),
        ];
        const uncovered = requirements
          .filter((r) => !coveredLines.includes(r.sourceLocation.line))
          .map((r) => ({ line: r.sourceLocation.line, kind: r.kind, mandatory: r.mandatory, text: r.text.slice(0, 200) }));
        const flaggedClaims = z.number().parse(ctx.state.flaggedClaims ?? 0);

        const result = await runAgentTask<ReviewPanelOutput>(
          ctx.services.provider, reviewerPanel,
          "Score this application against the funder's requirements from four reviewer perspectives.",
          [
            { label: "requirements", content: JSON.stringify(requirements) },
            { label: "coverage", content: JSON.stringify({ coveredLines, uncovered, flaggedClaims }) },
          ]
        );
        await recordModelUsage(ctx, reviewerPanel.agentKey, result.tokensEstimated);

        const overall = result.output.reviews.reduce((s, r) => s + r.score, 0);
        const max = result.output.reviews.reduce((s, r) => s + r.maxScore, 0);
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "review_report", title: "Reviewer panel report",
          content: { ...result.output, overall, max },
          agentKey: reviewerPanel.agentKey,
          changeSummary: `Panel scored ${overall}/${max}; ${result.output.reviews.filter((r) => r.fatalFlaw).length} fatal flaw(s)`,
        });
        const reviewRunId = uuidv7();
        await ctx.client.query(
          `INSERT INTO review_runs (id, tenant_id, application_id, run_id, artifact_id, overall_score, max_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [reviewRunId, ctx.tenantId, applicationId, ctx.runId, artifact.artifactId, overall, max]
        );
        for (const review of result.output.reviews) {
          await ctx.client.query(
            `INSERT INTO review_scores (id, tenant_id, review_run_id, reviewer, criterion, score,
               max_score, strengths, weaknesses, fatal_flaw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [uuidv7(), ctx.tenantId, reviewRunId, review.reviewer, review.criterion, review.score,
             review.maxScore, review.strengths, review.weaknesses, review.fatalFlaw]
          );
        }
        return {
          state: { ...ctx.state, review: { overall, max, recommendations: result.output.revisionRecommendations } },
          next: "final_compliance",
        };
      },

      // ------------------------------------------------------------------
      async final_compliance(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const opportunity = await getOpportunity(ctx, input.opportunityId);
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const sections = z.array(PlannedSection).parse(ctx.state.sections);
        const flaggedClaims = z.number().parse(ctx.state.flaggedClaims ?? 0);
        const budgetWarnings = z.array(z.string()).parse(ctx.state.budgetWarnings ?? []);
        const wordLimitViolations = z.array(z.string()).parse(ctx.state.wordLimitViolations ?? []);

        // Attachments can't be produced by the team — the checklist names each
        // one from the announcement so nothing is silently dropped (spec §5
        // Stage 8). Files uploaded to the project, or reused from the
        // organization's evidence library and linked here, count as provided.
        const uploadedFiles = await ctx.client.query(
          `SELECT f.filename FROM files f
           JOIN file_links fl ON fl.file_id = f.id
           WHERE fl.project_id = $1`,
          [ctx.projectId]
        );

        // An application with no drafted content or no costed budget must
        // never pass compliance vacuously just because it has nothing to
        // flag — content and budget presence are checked explicitly.
        const draftedSections = await ctx.client.query(
          "SELECT count(*)::int AS n FROM application_sections WHERE application_id = $1 AND status != 'planned'",
          [applicationId]
        );
        const budgetItemCount = await ctx.client.query(
          `SELECT count(bi.*)::int AS n FROM budgets b
           JOIN budget_items bi ON bi.budget_id = b.id
           WHERE b.application_id = $1`,
          [applicationId]
        );

        const checks = evaluateCompliance({
          sectionCount: sections.length,
          draftedSectionCount: draftedSections.rows[0].n as number,
          costedBudgetLineCount: budgetItemCount.rows[0].n as number,
          requirements,
          coveredRequirementLines: new Set(sections.flatMap((s) => s.requirementLines)),
          uploadedFileCount: uploadedFiles.rows.length,
          flaggedClaims,
          budgetWarnings,
          wordLimitViolations,
          deadline: opportunity.deadline,
        });
        const failures = checks.filter((c) => !c.pass);

        await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "compliance_report", title: "Final compliance check",
          content: { checks },
          agentKey: "system.compliance",
          changeSummary: `${checks.length - failures.length}/${checks.length} checks passed`,
        });
        await ctx.client.query(
          "UPDATE grant_applications SET status = 'review' WHERE id = $1", [applicationId]
        );

        const review = ctx.state.review as { overall: number; max: number; recommendations: string[] };
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'final_export',$4)`,
          [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
            warnings: [
              ...failures.map((f) => `${f.name}: ${f.detail}`),
              ...review.recommendations,
            ],
            reviewScore: `${review.overall}/${review.max}`,
          })]
        );
        return {
          state: { ...ctx.state, complianceChecks: checks },
          wait: { kind: "approval", payload: { approvalId, kind: "final_export" }, resumeStep: "final_gate" },
        };
      },

      // ------------------------------------------------------------------
      async final_gate(ctx): Promise<StepResult> {
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const approval = await latestApproval(ctx, "final_export");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "final_gate" },
          };
        }
        if (approval.status === "rejected") {
          await ctx.client.query(
            "UPDATE grant_applications SET status = 'drafting' WHERE id = $1", [applicationId]
          );
          return {
            state: { ...ctx.state, cursor: 0, flaggedClaims: 0, wordLimitViolations: [] },
            next: "draft_sections",
          };
        }
        return { state: ctx.state, next: "export_full" };
      },

      // ------------------------------------------------------------------
      async export_full(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const applicationId = z.string().uuid().parse(ctx.state.applicationId);
        const opportunity = await getOpportunity(ctx, input.opportunityId);

        // Gather everything from the database — the export reflects stored
        // artifacts, not transient state.
        const artifacts = await ctx.client.query(
          `SELECT a.type, a.title, av.content
           FROM artifacts a JOIN artifact_versions av
             ON av.artifact_id = a.id AND av.version = a.current_version
           WHERE a.run_id = $1 ORDER BY a.created_at`,
          [ctx.runId]
        );
        const budget = await ctx.client.query(
          `SELECT b.total, b.currency FROM budgets b WHERE b.application_id = $1`, [applicationId]
        );
        const items = await ctx.client.query(
          `SELECT category, description, activity, quantity, unit_cost, amount
           FROM budget_items bi JOIN budgets b ON b.id = bi.budget_id
           WHERE b.application_id = $1 ORDER BY bi.category, bi.description`,
          [applicationId]
        );

        const exportInput = {
          opportunity: {
            title: opportunity.title,
            funder: opportunity.funder,
            number: opportunity.opportunity_number,
            deadline: opportunity.deadline,
          },
          artifacts: artifacts.rows,
          budgetTotal: budget.rows[0] ? Number(budget.rows[0].total) : null,
          eligibility: ctx.state.eligibility as never,
          bid: ctx.state.bid as never,
        };
        const markdown = renderFullExport(exportInput);
        const csv = budgetCsv(items.rows);
        const docxBuffer = await renderFullExportDocx(exportInput);
        const pdfBuffer = await renderFullExportPdf(exportInput);

        const exportKey = `tenants/${ctx.tenantId}/exports/${ctx.runId}/application.md`;
        const csvKey = `tenants/${ctx.tenantId}/exports/${ctx.runId}/budget.csv`;
        const docxKey = `tenants/${ctx.tenantId}/exports/${ctx.runId}/application.docx`;
        const pdfKey = `tenants/${ctx.tenantId}/exports/${ctx.runId}/application.pdf`;
        await ctx.services.storage.put(exportKey, Buffer.from(markdown, "utf8"));
        await ctx.services.storage.put(csvKey, Buffer.from(csv, "utf8"));
        await ctx.services.storage.put(docxKey, docxBuffer);
        await ctx.services.storage.put(pdfKey, pdfBuffer);

        await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "export_package", title: `Export — ${opportunity.title}`,
          content: {
            markdown, budgetCsv: csv, storageKey: exportKey, csvStorageKey: csvKey,
            docxStorageKey: docxKey, pdfStorageKey: pdfKey,
          },
          agentKey: "system.exporter",
          changeSummary: "Approved full application package generated (Markdown, DOCX, PDF, budget CSV)",
        });
        await ctx.client.query(
          "UPDATE grant_applications SET status = 'ready' WHERE id = $1", [applicationId]
        );
        await ctx.client.query(
          "UPDATE grant_opportunities SET status = 'ready' WHERE id = $1", [input.opportunityId]
        );
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: "system.exporter",
          action: "export.completed", entityType: "grant_application", entityId: applicationId,
          metadata: { storageKey: exportKey },
        });
        return { state: { ...ctx.state, exported: true }, complete: true };
      },
    },
  };
}
