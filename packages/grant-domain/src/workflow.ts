import { z } from "zod";
import { audit, uuidv7, type StorageAdapter } from "@deedwell/database";
import { runAgentTask, type ModelProvider } from "@deedwell/agent-runtime";
import type { ToolGateway } from "@deedwell/tools";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import {
  ExtractedRequirement,
  OrgFact,
  type RequirementsExtractionOutput,
  type SectionDraftOutput,
} from "@deedwell/schemas";
import { grantWriter, requirementsAnalyst } from "./agents.js";
import { upsertArtifactVersion } from "./artifacts.js";
import { verifyClaims } from "./claims.js";
import { renderExportMarkdown } from "./export.js";
import { requiredFactKeys } from "./facts.js";
import { scanForInjection } from "./injection.js";

/** Result of really fetching one research page (spec §4). Implemented by
 *  @deedwell/browser-research; structural here so this package stays free of
 *  a Playwright dependency. */
export interface ResearchPageResult {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  links: string[];
  accessedAt: string;
  via: "browser" | "fetch";
  status: "retrieved" | "failed" | "blocked";
  error?: string;
}

export interface ResearchService {
  fetchPage(url: string): Promise<ResearchPageResult>;
}

export interface GrantServices {
  provider: ModelProvider;
  gateway: ToolGateway;
  storage: StorageAdapter;
  /** Absent → the research step records an honest skip, never fake sources. */
  research?: ResearchService;
}

export const GRANT_SLICE_WORKFLOW = "grant-application-slice";

const SliceInput = z.object({
  opportunityId: z.string().uuid(),
  fileId: z.string().uuid(),
  sectionTitle: z.string(),
  opportunityTitle: z.string(),
  funder: z.string(),
});

type Ctx = StepContext<GrantServices>;

function sliceInput(ctx: Ctx) {
  return SliceInput.parse(ctx.state.input);
}

async function recordModelUsage(ctx: Ctx, agentKey: string, tokens: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,$3,'model_tokens',$4,$5)`,
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey })]
  );
}

export function buildGrantSliceWorkflow(): WorkflowDefinition<GrantServices> {
  return {
    name: GRANT_SLICE_WORKFLOW,
    version: 1,
    initialStep: "parse_document",
    stepBudget: 25,
    steps: {
      // -----------------------------------------------------------------
      async parse_document(ctx): Promise<StepResult> {
        const input = sliceInput(ctx);
        const { rows } = await ctx.client.query(
          "SELECT storage_key, mime FROM files WHERE id = $1",
          [input.fileId]
        );
        if (!rows[0]) throw new Error(`File ${input.fileId} not found in tenant scope`);

        // DocumentParser seam: plain text/markdown parsed directly; PDF/DOCX
        // parsing arrives behind the same interface in a sandboxed worker.
        const text = (await ctx.services.storage.get(rows[0].storage_key)).toString("utf8");
        if (!text.trim()) throw new Error("Uploaded document is empty");

        const warnings = scanForInjection(text);
        await ctx.client.query(
          "UPDATE grant_opportunities SET injection_warnings = $2 WHERE id = $1",
          [input.opportunityId, JSON.stringify(warnings)]
        );
        if (warnings.length) {
          await audit(ctx.client, {
            tenantId: ctx.tenantId,
            actorAgent: requirementsAnalyst.agentKey,
            action: "document.injection_flagged",
            entityType: "grant_opportunity",
            entityId: input.opportunityId,
            metadata: { warnings },
          });
        }
        return {
          state: { ...ctx.state, documentText: text, injectionWarnings: warnings.length },
          next: "extract_requirements",
        };
      },

      // -----------------------------------------------------------------
      async extract_requirements(ctx): Promise<StepResult> {
        const input = sliceInput(ctx);
        const text = z.string().parse(ctx.state.documentText);

        const result = await runAgentTask<RequirementsExtractionOutput>(
          ctx.services.provider,
          requirementsAnalyst,
          "Extract every application requirement from the attached grant announcement.",
          [{ label: "document", content: text }]
        );
        await recordModelUsage(ctx, requirementsAnalyst.agentKey, result.tokensEstimated);

        await ctx.services.gateway.invoke(
          ctx.client,
          { tenantId: ctx.tenantId, userId: null, agentKey: requirementsAnalyst.agentKey, runId: ctx.runId },
          requirementsAnalyst,
          "record_requirements",
          { opportunityId: input.opportunityId, requirements: result.output.requirements }
        );

        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          type: "compliance_matrix",
          title: `Compliance matrix — ${input.opportunityTitle}`,
          content: {
            requirements: result.output.requirements,
            documentSummary: result.output.documentSummary,
          },
          agentKey: requirementsAnalyst.agentKey,
          changeSummary: `Extracted ${result.output.requirements.length} requirements`,
        });
        await audit(ctx.client, {
          tenantId: ctx.tenantId,
          actorAgent: requirementsAnalyst.agentKey,
          action: "artifact.version_created",
          entityType: "artifact",
          entityId: artifact.artifactId,
          metadata: { type: "compliance_matrix", version: artifact.version },
        });

        return {
          state: {
            ...ctx.state,
            requirements: result.output.requirements,
            matrixArtifactId: artifact.artifactId,
          },
          next: "check_org_info",
        };
      },

      // -----------------------------------------------------------------
      async check_org_info(ctx): Promise<StepResult> {
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const needed = requiredFactKeys(requirements);

        const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
          ctx.client,
          { tenantId: ctx.tenantId, userId: null, agentKey: requirementsAnalyst.agentKey, runId: ctx.runId },
          requirementsAnalyst,
          "fetch_org_facts",
          {}
        );
        const usable = new Set(
          facts
            .filter((f) => f.status === "verified" || f.status === "user_certified")
            .map((f) => f.key)
        );
        const missing = needed.filter((key) => !usable.has(key));
        if (missing.length) {
          // Missing information is requested from the user — never guessed.
          return {
            state: { ...ctx.state, missingFacts: missing },
            wait: { kind: "info", payload: { missingFacts: missing }, resumeStep: "check_org_info" },
          };
        }
        return { state: { ...ctx.state, missingFacts: [] }, next: "draft_section" };
      },

      // -----------------------------------------------------------------
      async draft_section(ctx): Promise<StepResult> {
        const input = sliceInput(ctx);
        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);

        const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
          ctx.client,
          { tenantId: ctx.tenantId, userId: null, agentKey: grantWriter.agentKey, runId: ctx.runId },
          grantWriter,
          "fetch_org_facts",
          {}
        );
        const usableFacts = facts.filter(
          (f) => f.status === "verified" || f.status === "user_certified"
        );

        const result = await runAgentTask<SectionDraftOutput>(
          ctx.services.provider,
          grantWriter,
          `Draft a grant proposal section titled "${input.sectionTitle}" that responds to the attached requirements using only the attached organizational facts.`,
          [
            { label: "requirements", content: JSON.stringify(requirements) },
            { label: "org_facts", content: JSON.stringify(usableFacts) },
          ]
        );
        await recordModelUsage(ctx, grantWriter.agentKey, result.tokensEstimated);

        // Server-side verification: the model's own support labels are untrusted.
        const { claims, flaggedCount } = verifyClaims(result.output.claims, facts);

        const warnings: string[] = [];
        const wordLimit = requirements.find((r) => r.kind === "narrative" && r.wordLimit)?.wordLimit;
        if (wordLimit && result.output.wordCount > wordLimit) {
          warnings.push(
            `Section exceeds the ${wordLimit}-word limit (currently ${result.output.wordCount} words).`
          );
        }
        if (flaggedCount > 0) {
          warnings.push(`${flaggedCount} claim(s) lack verified or user-certified evidence.`);
        }

        const section = {
          title: result.output.title,
          body: result.output.body,
          claims,
          wordCount: result.output.wordCount,
          warnings,
        };
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          type: "grant_section",
          title: input.sectionTitle,
          content: section,
          agentKey: grantWriter.agentKey,
          changeSummary: `Drafted "${input.sectionTitle}" (${result.output.wordCount} words, ${flaggedCount} flagged claims)`,
        });

        // One pending approval per run: re-drafting after rejection creates a
        // fresh request; a crashed step never half-creates one (same tx).
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload)
           VALUES ($1,$2,$3,'section_export',$4)`,
          [approvalId, ctx.tenantId, ctx.runId,
           JSON.stringify({ artifactId: artifact.artifactId, version: artifact.version, warnings })]
        );
        await audit(ctx.client, {
          tenantId: ctx.tenantId,
          actorAgent: grantWriter.agentKey,
          action: "approval.requested",
          entityType: "approval",
          entityId: approvalId,
          metadata: { kind: "section_export", warnings },
        });

        return {
          state: { ...ctx.state, section, sectionArtifactId: artifact.artifactId, approvalId },
          wait: { kind: "approval", payload: { approvalId, warnings }, resumeStep: "export_package" },
        };
      },

      // -----------------------------------------------------------------
      async export_package(ctx): Promise<StepResult> {
        const input = sliceInput(ctx);
        // Threat T5: the gate is re-verified against the database, not the UI.
        const { rows } = await ctx.client.query(
          `SELECT id, status FROM approvals WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [ctx.runId]
        );
        const approval = rows[0];
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: {
              kind: "approval",
              payload: { approvalId: approval?.id ?? null },
              resumeStep: "export_package",
            },
          };
        }
        if (approval.status === "rejected") {
          return { state: { ...ctx.state, lastRejection: approval.id }, next: "draft_section" };
        }

        const requirements = z.array(ExtractedRequirement).parse(ctx.state.requirements);
        const section = ctx.state.section as {
          title: string; body: string; claims: never[]; wordCount: number; warnings: string[];
        };
        const markdown = renderExportMarkdown({
          opportunityTitle: input.opportunityTitle,
          funder: input.funder,
          requirements,
          section,
          warnings: section.warnings ?? [],
        });
        const exportKey = `tenants/${ctx.tenantId}/exports/${ctx.runId}/application.md`;
        await ctx.services.storage.put(exportKey, Buffer.from(markdown, "utf8"));

        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          runId: ctx.runId,
          type: "export_package",
          title: `Export — ${input.opportunityTitle}`,
          content: { markdown, storageKey: exportKey, approvedApprovalId: approval.id },
          agentKey: "system.exporter",
          changeSummary: "Approved export package generated",
        });
        await audit(ctx.client, {
          tenantId: ctx.tenantId,
          actorAgent: "system.exporter",
          action: "export.completed",
          entityType: "artifact",
          entityId: artifact.artifactId,
          metadata: { storageKey: exportKey },
        });

        return { state: { ...ctx.state, exportArtifactId: artifact.artifactId }, complete: true };
      },
    },
  };
}
