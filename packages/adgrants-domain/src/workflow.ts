import { audit, uuidv7 } from "@deedwell/database";
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
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey })]
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

function googleReconnectWait(ctx: Ctx, resumeStep: string): StepResult {
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
        return { state: ctx.state, next: "techsoup_validation" };
      },

      // -----------------------------------------------------------------
      async techsoup_validation(ctx): Promise<StepResult> {
        const facts = await fetchUsableFacts(ctx, eligibilityAnalyst.agentKey);
        const hasToken = facts.some((f) => f.key === "techsoup_validation_token");
        if (!hasToken) {
          return {
            state: ctx.state,
            wait: {
              kind: "info",
              payload: { missingFacts: ["techsoup_validation_token"], context: "techsoup" },
              resumeStep: "techsoup_validation",
            },
          };
        }
        return { state: ctx.state, next: "connect_google_account" };
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
        const factsMap = Object.fromEntries(facts.map((f) => [f.key, f.value]));
        let screenshotKey: string;
        try {
          ({ screenshotKey } = await ctx.services.google!.runNonprofitsEnrollment(ctx.tenantId, factsMap));
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
          ctx, "ad_grants_enrollment_submit", { artifactId: artifact.artifactId, screenshotKey }, applicationAgent.agentKey
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
        const factsMap = Object.fromEntries(facts.map((f) => [f.key, f.value]));
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
        if (review.status === "rejected") {
          return { state: { ...ctx.state, reviewRejectionReason: review.reason ?? null }, next: "handle_review_rejection" };
        }
        return { state: ctx.state, next: "activate_ad_grants_product" };
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
        try {
          ({ screenshotKey } = await ctx.services.google!.runAdGrantsActivation(ctx.tenantId));
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
          ctx, "ad_grants_activation_submit", { artifactId: artifact.artifactId, screenshotKey }, applicationAgent.agentKey
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
        const result = await runAgentTask<AdGrantsCampaignPlanOutput>(
          ctx.services.provider, campaignStrategist,
          "Draft a Google Ad Grants campaign plan using only the attached organizational facts.",
          [{ label: "org_facts", content: JSON.stringify(facts) }]
        );
        await recordModelUsage(ctx, campaignStrategist.agentKey, result.tokensEstimated);
        const artifact = await upsertArtifactVersion(ctx.client, {
          tenantId: ctx.tenantId, projectId: ctx.projectId, runId: ctx.runId,
          type: "ad_grants_campaign_plan", title: `Campaign plan — ${result.output.campaignName}`,
          content: result.output, agentKey: campaignStrategist.agentKey,
          changeSummary: `Drafted "${result.output.campaignName}" with ${result.output.adGroups.length} ad group(s)`,
        });
        const approvalId = await requestApproval(
          ctx, "ad_grants_campaign_publish", { artifactId: artifact.artifactId }, campaignStrategist.agentKey
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
        return { state: { ...ctx.state, result: "completed", googleCampaignId: campaignId }, complete: true };
      },
    },
  };
}
