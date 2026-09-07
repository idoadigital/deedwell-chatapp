import { audit, loadMissionProfile, missionProfileBlock, uuidv7 } from "@deedwell/database";
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { runAgentTask } from "@deedwell/agent-runtime";
import { upsertArtifactVersion, type GrantServices } from "@deedwell/grant-domain";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import type { AdGrantsCampaignPlanOutput, OrgFact } from "@deedwell/schemas";
import { applicationAgent, campaignStrategist, eligibilityAnalyst } from "./agents.js";
import { checkAdGrantsEligibility } from "./eligibility.js";
import { requiredAdGrantsFactKeys } from "./facts.js";

export const AD_GRANTS_WORKFLOW = "ad-grants-application";

type Ctx = StepContext<GrantServices>;

async function recordModelUsage(ctx: Ctx, agentKey: string, tokens: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,$3,'model_tokens',$4,$5)`,
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey, source: "workflow" })]
  );
}

async function fetchUsableFacts(ctx: Ctx, agentKey: string): Promise<OrgFact[]> {
  const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
    ctx.client,
    { tenantId: ctx.tenantId, userId: null, agentKey, runId: ctx.runId },
    eligibilityAnalyst,
    "fetch_org_facts",
    {}
  );
  return facts.filter((f) => f.status === "verified" || f.status === "user_certified");
}

/** Everything the organization has told Deedwell about itself — the
 *  Mission Profile (facts of every status except rejected, plus knowledge
 *  base notes and document titles). Certified facts win where both exist;
 *  the profile fills in what the certified set lacks, so the enrollment and
 *  the campaign draw on the whole profile, not only the wizard's answers. */
async function profileFacts(ctx: Ctx, certified: OrgFact[]): Promise<{ map: Record<string, string>; block: string }> {
  const map: Record<string, string> = {};
  let block = "";
  try {
    const profile = await loadMissionProfile(ctx.client, ctx.services.storage, ctx.tenantId);
    for (const f of profile.facts) if (f.value) map[f.key] = String(f.value).replace(/^"|"$/g, "");
    block = missionProfileBlock(profile);
  } catch { /* profile unavailable: certified facts alone */ }
  for (const f of certified) map[f.key] = f.value;
  return { map, block };
}

/** Re-reads the most recent approval of `kind` for this run from the
 *  database — never trusts anything cached in state, same principle
 *  grant-domain's export_package uses ("the gate is re-verified against
 *  the database, not the UI"). */
async function latestApproval(
  ctx: Ctx,
  kind: string
): Promise<{ id: string; status: string } | undefined> {
  const { rows } = await ctx.client.query(
    `SELECT id, status FROM approvals WHERE run_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.runId, kind]
  );
  return rows[0];
}

/** What the person is approving, in their words: the exact values the
 *  automation typed into Google's form (a screenshot of the filled form is
 *  taken alongside), and the Google page it concerns. Rendered by the
 *  dashboard's "Preview submission" before Approve. */
const ENROLLMENT_FIELDS: Array<[string, string]> = [
  ["country", "Country"], ["legal_name", "Organization legal name"], ["website_url", "Website"], ["ein", "EIN / tax ID"],
  ["mission", "Mission"], ["primary_contact_name", "Contact name"], ["primary_contact_email", "Contact email"],
  ["phone", "Phone"], ["mailing_address", "Mailing address"], ["goodstack_reference", "Goodstack reference"],
];
/** Marks each submitted value with what the automation reported for that
 *  field — filled, not found on Google's form, unverified — so the preview
 *  can show it without cross-referencing the raw report. */
function withFillStatus<T extends { key: string }>(submission: T[], report: import("@deedwell/grant-domain").GoogleFillReport | undefined): Array<T & { fill?: string; note?: string }> {
  if (!report) return submission;
  const byKey = new Map(report.fields.map((f) => [f.key, f]));
  return submission.map((s) => { const f = byKey.get(s.key); return f ? { ...s, fill: f.status, ...(f.note ? { note: f.note } : {}) } : s; });
}
function submissionFrom(facts: Record<string, string>, fields: Array<[string, string]>): Array<{ key: string; label: string; value: string | null }> {
  return fields.map(([key, label]) => ({ key, label, value: facts[key] ?? null }));
}
export const GOOGLE_PAGES = {
  nonprofits: "https://www.google.com/nonprofits/",
  grants: "https://www.google.com/grants/",
  ads: "https://ads.google.com/",
} as const;

async function requestApproval(ctx: Ctx, kind: string, payload: unknown, agentKey: string): Promise<string> {
  const approvalId = uuidv7();
  await ctx.client.query(
    `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,$4,$5)`,
    [approvalId, ctx.tenantId, ctx.runId, kind, JSON.stringify(payload)]
  );
  await audit(ctx.client, {
    tenantId: ctx.tenantId, actorAgent: agentKey, action: "approval.requested",
    entityType: "approval", entityId: approvalId, metadata: { kind },
  });
  return approvalId;
}

/** Every browser-touching step needs a connected session; when the
 *  automation service isn't wired (AD_GRANTS_AUTOMATION=off, or the run
 *  reaches here before a real connect) it parks the same way a missing
 *  session does rather than throwing — an absent capability is an honest
 *  wait, never a guess. */
function needsGoogle(ctx: Ctx): StepResult | null {
  if (ctx.services.google) return null;
  return {
    state: ctx.state,
    wait: { kind: "info", payload: { context: "google_connect" }, resumeStep: "connect_google_account" },
  };
}

/** browser-automation's withSession() marks a session expired and rethrows
 *  SessionExpiredError the moment a call observes an auth failure mid-step
 *  — duck-typed by name rather than imported so this package stays free of
 *  a Playwright dependency (same reasoning as GoogleAutomationService's
 *  structural typing in grant-domain). Turning it into the same wait shape
 *  needsGoogle() already produces, but resuming into the step that hit it,
 *  is what makes an expiry mid-automation an honest pause instead of a
 *  failed run. */
function isSessionExpired(err: unknown): boolean {
  return err instanceof Error && err.name === "SessionExpiredError";
}

async function googleReconnectWait(ctx: Ctx, resumeStep: string): Promise<StepResult> {
  // The application is stuck until a person signs in to Google again — and
  // this happens mid-automation, hours or days after they last looked.
  await emailOrgAdmins(ctx.client, ctx.tenantId, "ad_grants_reconnect", {
    orgName: await orgNameOf(ctx.client, ctx.tenantId), step: resumeStep,
  }, { dedupe: `ad_grants_reconnect:${ctx.runId}:${resumeStep}:${new Date().toISOString().slice(0, 10)}` });
  return {
    state: ctx.state,
    wait: { kind: "info", payload: { context: "google_connect" }, resumeStep },
  };
}

export function buildAdGrantsWorkflow(): WorkflowDefinition<GrantServices> {
  return {
    name: AD_GRANTS_WORKFLOW,
    version: 1,
    initialStep: "check_ad_grants_facts",
    stepBudget: 80,
    steps: {
      // -----------------------------------------------------------------
      async check_ad_grants_facts(ctx): Promise<StepResult> {
        const needed = requiredAdGrantsFactKeys();
        const facts = await fetchUsableFacts(ctx, eligibilityAnalyst.agentKey);
        const usable = new Set(facts.map((f) => f.key));
        const missing = needed.filter((key) => !usable.has(key));
        if (missing.length) {
          return {
            state: { ...ctx.state, missingFacts: missing },
            wait: {
              kind: "info",
              payload: { missingFacts: missing, context: "ad_grants_facts" },
              resumeStep: "check_ad_grants_facts",
            },
          };
        }
        return { state: { ...ctx.state, missingFacts: [] }, next: "verify_eligibility" };
      },

      // -----------------------------------------------------------------
      async verify_eligibility(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, eligibilityAnalyst.agentKey);
        const result = checkAdGrantsEligibility(facts);
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "ad_grants_eligibility", title: "Ad Grants eligibility pre-screen",
          content: result, agentKey: eligibilityAnalyst.agentKey,
          changeSummary: result.eligible ? "Passed the eligibility pre-screen" : "Failed the eligibility pre-screen",
        });
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: eligibilityAnalyst.agentKey, action: "ad_grants.eligibility_checked",
          entityType: "artifact", entityId: artifact.artifactId, metadata: result,
        });
        if (!result.eligible) {
          return {
            state: { ...ctx.state, result: "ineligible", eligibilityReasons: result.reasons },
            complete: true,
          };
        }
        return { state: ctx.state, next: "collect_documents" };
      },

      // -----------------------------------------------------------------
      // Phase 2 — Document collection. Google and Goodstack ask for the IRS
      // determination letter, EIN confirmation, articles of incorporation,
      // an authorized representative's ID and authorization letter, and a
      // logo. Uploads land in the project's files; the person confirms.
      async collect_documents(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, eligibilityAnalyst.agentKey);
        const answered = facts.some((f) => f.key === "documents_status");
        const uploaded = (await ctx.client.query(
          "SELECT 1 FROM file_links WHERE project_id = $1 LIMIT 1", [ctx.projectId]
        )).rowCount ?? 0;
        if (!answered && !uploaded) {
          return {
            state: ctx.state,
            wait: { kind: "info", payload: { missingFacts: ["documents_status"], context: "documents" }, resumeStep: "collect_documents" },
          };
        }
        return { state: { ...ctx.state, documentsUploaded: uploaded > 0 }, next: "goodstack_verification" };
      },

      // -----------------------------------------------------------------
      // Phase 3 — Third-party verification. Google validates nonprofits
      // through Goodstack (its validation partner) as part of the Google for
      // Nonprofits signup; the person completes it there and records the
      // outcome here. A pre-existing TechSoup token no longer satisfies
      // this — Google stopped accepting it.
      async goodstack_verification(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, eligibilityAnalyst.agentKey);
        const status = facts.find((f) => f.key === "goodstack_validation_status")?.value ?? "";
        if (!/^verified/i.test(status)) {
          return {
            state: { ...ctx.state, goodstackStatus: status || null },
            wait: {
              kind: "info",
              payload: { missingFacts: ["goodstack_validation_status", "goodstack_reference"], context: "goodstack" },
              resumeStep: "goodstack_verification",
            },
          };
        }
        return { state: { ...ctx.state, goodstackStatus: status }, next: "connect_google_account" };
      },

      /** Runs parked here before the Goodstack change resume into it. */
      async techsoup_validation(ctx): Promise<StepResult> {
        return { state: ctx.state, next: "goodstack_verification" };
      },

      // -----------------------------------------------------------------
      async connect_google_account(ctx): Promise<StepResult> {
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        const session = await ctx.services.google!.checkSession(ctx.tenantId);
        if (!session.connected) {
          return {
            state: ctx.state,
            wait: { kind: "info", payload: { context: "google_connect" }, resumeStep: "connect_google_account" },
          };
        }
        return { state: { ...ctx.state, googleAccountHint: session.accountHint }, next: "enroll_google_nonprofits" };
      },

      // -----------------------------------------------------------------
      async enroll_google_nonprofits(ctx): Promise<StepResult> {
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        const facts = await fetchUsableFacts(ctx, applicationAgent.agentKey);
        const { map: factsMap } = await profileFacts(ctx, facts);
        let screenshotKey: string;
        let report: import("@deedwell/grant-domain").GoogleFillReport | undefined;
        try {
          ({ screenshotKey, report } = await ctx.services.google!.runNonprofitsEnrollment(ctx.tenantId, factsMap));
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "enroll_google_nonprofits");
          throw err;
        }
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "ad_grants_enrollment_snapshot", title: "Google for Nonprofits enrollment",
          content: { screenshotKey }, agentKey: applicationAgent.agentKey,
          changeSummary: "Prepared the Google for Nonprofits enrollment form for approval",
        });
        const approvalId = await requestApproval(
          ctx, "ad_grants_enrollment_submit", {
            artifactId: artifact.artifactId, screenshotKey,
            form: "Google for Nonprofits enrollment", googleUrl: GOOGLE_PAGES.nonprofits,
            submission: withFillStatus(submissionFrom(factsMap, ENROLLMENT_FIELDS), report),
            fillReport: report ?? null,
          }, applicationAgent.agentKey
        );
        return {
          state: { ...ctx.state, enrollmentArtifactId: artifact.artifactId },
          wait: { kind: "approval", payload: { approvalId }, resumeStep: "submit_enrollment" },
        };
      },

      // -----------------------------------------------------------------
      async submit_enrollment(ctx): Promise<StepResult> {
        const approval = await latestApproval(ctx, "ad_grants_enrollment_submit");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "submit_enrollment" },
          };
        }
        if (approval.status === "rejected") {
          return { state: { ...ctx.state, lastEnrollmentRejection: approval.id }, next: "enroll_google_nonprofits" };
        }
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        const facts = await fetchUsableFacts(ctx, applicationAgent.agentKey);
        const { map: factsMap } = await profileFacts(ctx, facts);
        try {
          await ctx.services.google!.submitNonprofitsEnrollment(ctx.tenantId, factsMap);
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "submit_enrollment");
          throw err;
        }
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: applicationAgent.agentKey, action: "ad_grants.enrollment_submitted",
          entityType: "workflow_run", entityId: ctx.runId, metadata: {},
        });
        return { state: ctx.state, next: "await_google_review" };
      },

      // -----------------------------------------------------------------
      async await_google_review(ctx): Promise<StepResult> {
        const blocked = needsGoogle(ctx);
        if (blocked) {
          return {
            state: ctx.state,
            wait: { kind: "info", payload: { context: "google_review_pending" }, resumeStep: "await_google_review" },
          };
        }
        let review: Awaited<ReturnType<NonNullable<GrantServices["google"]>["checkGoogleReviewStatus"]>>;
        try {
          review = await ctx.services.google!.checkGoogleReviewStatus(ctx.tenantId);
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "await_google_review");
          throw err;
        }
        if (review.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "info", payload: { context: "google_review_pending" }, resumeStep: "await_google_review" },
          };
        }
        // Google's review takes days; the outcome is the one email every
        // applicant is waiting for.
        await emailOrgAdmins(ctx.client, ctx.tenantId, "ad_grants_review", {
          orgName: await orgNameOf(ctx.client, ctx.tenantId),
          status: review.status === "rejected" ? "rejected" : "approved", reason: review.reason ?? null,
        }, { dedupe: `ad_grants_review:${ctx.runId}:${review.status}` });
        if (review.status === "rejected") {
          return { state: { ...ctx.state, reviewRejectionReason: review.reason ?? null }, next: "handle_review_rejection" };
        }
        return { state: ctx.state, next: "activate_google_products" };
      },

      // -----------------------------------------------------------------
      // Phase 6 — Activate Google products. Approved nonprofits may also
      // take Google Workspace for Nonprofits; that is a choice for the
      // person (and a Workspace admin login Deedwell never holds), so it is
      // asked, recorded, and never blocks the grant.
      async activate_google_products(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, applicationAgent.agentKey);
        const choice = facts.find((f) => f.key === "google_workspace_choice")?.value ?? null;
        if (!choice) {
          return {
            state: ctx.state,
            wait: { kind: "info", payload: { missingFacts: ["google_workspace_choice"], context: "google_products" }, resumeStep: "activate_google_products" },
          };
        }
        return { state: { ...ctx.state, googleWorkspaceChoice: choice }, next: "activate_ad_grants_product" };
      },

      // -----------------------------------------------------------------
      async handle_review_rejection(ctx): Promise<StepResult> {
        const approval = await latestApproval(ctx, "ad_grants_review_rejected");
        if (!approval) {
          await requestApproval(
            ctx, "ad_grants_review_rejected",
            { reason: ctx.state.reviewRejectionReason ?? null },
            applicationAgent.agentKey
          );
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { context: "ad_grants_review_rejected" }, resumeStep: "handle_review_rejection" },
          };
        }
        if (approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { context: "ad_grants_review_rejected" }, resumeStep: "handle_review_rejection" },
          };
        }
        // "approved" here means "retry after fixing facts"; "rejected" means abandon.
        if (approval.status === "rejected") {
          return { state: { ...ctx.state, result: "rejected" }, complete: true };
        }
        return { state: ctx.state, next: "check_ad_grants_facts" };
      },

      // -----------------------------------------------------------------
      async activate_ad_grants_product(ctx): Promise<StepResult> {
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        let screenshotKey: string;
        let report: import("@deedwell/grant-domain").GoogleFillReport | undefined;
        try {
          ({ screenshotKey, report } = await ctx.services.google!.runAdGrantsActivation(ctx.tenantId));
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "activate_ad_grants_product");
          throw err;
        }
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "ad_grants_activation_snapshot", title: "Ad Grants activation",
          content: { screenshotKey }, agentKey: applicationAgent.agentKey,
          changeSummary: "Prepared Ad Grants product activation for approval",
        });
        const approvalId = await requestApproval(
          ctx, "ad_grants_activation_submit", {
            artifactId: artifact.artifactId, screenshotKey,
            form: "Google Ad Grants activation", googleUrl: GOOGLE_PAGES.grants,
            submission: withFillStatus([{ key: "accept_terms", label: "Action", value: "Accept the Google Ad Grants program terms and activate Ad Grants on your Google for Nonprofits account" }], report),
            fillReport: report ?? null,
          }, applicationAgent.agentKey
        );
        return {
          state: { ...ctx.state, activationArtifactId: artifact.artifactId },
          wait: { kind: "approval", payload: { approvalId }, resumeStep: "submit_activation" },
        };
      },

      // -----------------------------------------------------------------
      async submit_activation(ctx): Promise<StepResult> {
        const approval = await latestApproval(ctx, "ad_grants_activation_submit");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "submit_activation" },
          };
        }
        if (approval.status === "rejected") {
          return { state: { ...ctx.state, lastActivationRejection: approval.id }, next: "activate_ad_grants_product" };
        }
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        try {
          await ctx.services.google!.submitAdGrantsActivation(ctx.tenantId);
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "submit_activation");
          throw err;
        }
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: applicationAgent.agentKey, action: "ad_grants.activation_submitted",
          entityType: "workflow_run", entityId: ctx.runId, metadata: {},
        });
        return { state: ctx.state, next: "draft_campaign_plan" };
      },

      // -----------------------------------------------------------------
      async draft_campaign_plan(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, campaignStrategist.agentKey);
        const { block: missionProfile } = await profileFacts(ctx, facts);
        const result = await runAgentTask<AdGrantsCampaignPlanOutput>(
          ctx.services.provider, campaignStrategist,
          "Draft a Google Ad Grants campaign plan using only the attached organizational facts and Mission Profile.",
          [{ label: "org_facts", content: JSON.stringify(facts) }, ...(missionProfile ? [{ label: "mission_profile", content: missionProfile }] : [])]
        );
        await recordModelUsage(ctx, campaignStrategist.agentKey, result.tokensEstimated);
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "ad_grants_campaign_plan", title: `Campaign plan — ${result.output.campaignName}`,
          content: result.output, agentKey: campaignStrategist.agentKey,
          changeSummary: `Drafted "${result.output.campaignName}" with ${result.output.adGroups.length} ad group(s)`,
        });
        const plan = result.output;
        const approvalId = await requestApproval(
          ctx, "ad_grants_campaign_publish", {
            artifactId: artifact.artifactId,
            form: "Google Ads campaign", googleUrl: GOOGLE_PAGES.ads,
            submission: [
              { key: "campaignName", label: "Campaign name", value: plan.campaignName },
              { key: "dailyBudgetUsd", label: "Daily budget (USD)", value: String(plan.dailyBudgetUsd) },
              { key: "geoTargets", label: "Locations", value: plan.geoTargets.join(", ") },
              ...plan.adGroups.map((g, i) => ({ key: `adGroup${i + 1}`, label: `Ad group ${i + 1}: ${g.name}`, value: `${g.keywords.length} keywords · ${g.headlines.length} headlines · ${g.finalUrl}` })),
              { key: "sitelinks", label: "Sitelinks", value: plan.sitelinks.map((l) => `${l.text} → ${l.url}`).join("\n") || null },
            ],
          }, campaignStrategist.agentKey
        );
        return {
          state: { ...ctx.state, campaignArtifactId: artifact.artifactId },
          wait: { kind: "approval", payload: { approvalId }, resumeStep: "publish_campaign" },
        };
      },

      // -----------------------------------------------------------------
      async publish_campaign(ctx): Promise<StepResult> {
        const approval = await latestApproval(ctx, "ad_grants_campaign_publish");
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "publish_campaign" },
          };
        }
        if (approval.status === "rejected") {
          return { state: { ...ctx.state, lastCampaignRejection: approval.id }, next: "draft_campaign_plan" };
        }
        const blocked = needsGoogle(ctx);
        if (blocked) return blocked;
        const artifactId = ctx.state.campaignArtifactId as string;
        const { rows } = await ctx.client.query(
          `SELECT av.content FROM artifacts a
           JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = a.current_version
           WHERE a.id = $1`,
          [artifactId]
        );
        let campaignId: string;
        try {
          ({ campaignId } = await ctx.services.google!.publishCampaign(ctx.tenantId, rows[0].content));
        } catch (err) {
          if (isSessionExpired(err)) return googleReconnectWait(ctx, "publish_campaign");
          throw err;
        }
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: applicationAgent.agentKey, action: "ad_grants.campaign_published",
          entityType: "workflow_run", entityId: ctx.runId, metadata: { campaignId },
        });
        await emailOrgAdmins(ctx.client, ctx.tenantId, "ad_grants_live", {
          orgName: await orgNameOf(ctx.client, ctx.tenantId), campaignId: campaignId ?? null,
        }, { dedupe: `ad_grants_live:${ctx.runId}` });
        return { state: { ...ctx.state, googleCampaignId: campaignId }, next: "onboard_client" };
      },

      // -----------------------------------------------------------------
      // Phase 9 — Congratulations & ongoing care. The campaign is live; the
      // grant is active. Next steps go in the timeline (the congratulations
      // email went out with the campaign), and the run completes.
      async onboard_client(ctx): Promise<StepResult> {
        await ctx.client.query(
          `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary, status, agent_key, completed_at)
           VALUES ($1,$2,$3,$4,'ad_grants:onboarded',$5,$6,'completed',$7, now())`,
          [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId, "Your Google Ad Grant is active",
           "Your first campaign is live. Deedwell keeps it within Google's Ad Grants policies (5% click-through, active management) and reports back as results come in.",
           applicationAgent.agentKey]
        );
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: applicationAgent.agentKey, action: "ad_grants.onboarded",
          entityType: "workflow_run", entityId: ctx.runId, metadata: { campaignId: ctx.state.googleCampaignId ?? null },
        });
        return { state: { ...ctx.state, result: "completed" }, complete: true };
      },
    },
  };
}
