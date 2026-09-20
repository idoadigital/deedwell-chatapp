/**
 * The account manager's run on a campaign request. Narrates each real step
 * into the request's progress checklist, asks the agent, stores its answer,
 * and moves the request on: questions (to the customer or to Deedwell), a
 * recommendation to decline, or a plan — which the pipeline continues on its
 * own (request-pipeline.ts). Only the tenant's own rows are visible to the
 * agent (RLS under the tenant context).
 */
import { runAgentTask } from "@deedwell/agent-runtime";
import { uuidv7, withContext } from "@deedwell/database";
import { emailOps } from "@deedwell/email";
import { AD_GRANTS_DAILY_CAP_USD, AD_GRANTS_MONTHLY_LIMIT_USD, REQUEST_GOALS, adsGrantsManager, utilizationForecast, isOpenRequest, type RequestGoal, type UtilizationForecast } from "@deedwell/google-ads-domain";
import type { GoogleAdsRequestPlanOutput } from "@deedwell/schemas";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { buildAdsContext } from "./ai.js";
import { complianceReport } from "./compliance.js";
import { continueAfterPlan } from "./request-pipeline.js";
import { addRequestEvent, loadRequest, narrate, transitionRequest } from "./requests.js";
import { emitOrgEvent, loadAccount, loadAccountById, logActivity, type AccountRow } from "./store.js";

type Log = { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
type Queryable = Pick<PoolClient, "query">;

/** The account manager's view of the account's grant capacity this month. */
export async function requestUtilization(client: Queryable, account: AccountRow): Promise<UtilizationForecast> {
  const { rows } = await client.query(
    `SELECT day::text AS day, cost_micros FROM google_ads_metrics_daily WHERE account_id = $1 AND level = 'account' AND day >= date_trunc('month', CURRENT_DATE)::date ORDER BY day`, [account.id]);
  const grants = account.account_kind === "ad_grants";
  return utilizationForecast({
    days: rows.map((r) => ({ day: r.day, costMicros: Number(r.cost_micros ?? 0) })), timeZone: account.time_zone ?? null,
    monthlyLimitUsd: grants ? AD_GRANTS_MONTHLY_LIMIT_USD : null, dailyCapUsd: grants ? AD_GRANTS_DAILY_CAP_USD : null,
  });
}

/** Runs one queued request run. */
export async function runRequestRun(deps: Deps, job: Record<string, any>, opts: { log?: Log } = {}): Promise<void> {
  const tenantId: string = job.tenant_id;
  const ref = { id: job.request_id as string, tenant_id: tenantId };
  const say = (message: string, customerVisible = true) => narrate(deps, ref, "assess", message, { customerVisible, metadata: { runId: job.id } });
  const fail = async (message: string) => {
    await deps.adminPool.query(`UPDATE google_ads_request_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, message.slice(0, 1000)]);
    await withContext(deps.appPool, { tenantId, userId: job.requested_by ?? null }, async (client) => {
      const request = await loadRequest(client, tenantId, job.request_id);
      if (!request) return;
      await addRequestEvent(client, { tenantId, requestId: request.id, kind: "run_failed", actorKind: "system", message: message.slice(0, 400), metadata: { runId: job.id }, customerVisible: false });
      if (request.status === "in_progress") await transitionRequest(deps, client, request, "in_review", { actorKind: "system", kind: "status_changed", message: "The account manager could not finish — back with the Deedwell team.", customerVisible: false });
    }).catch(() => undefined);
    emitOrgEvent(deps, tenantId, "google_ads:request_changed", { requestId: job.request_id, runId: job.id, status: "failed" });
    opts.log?.error({ at: "google_ads.request_run_failed", runId: job.id, message });
  };
  try {
    await deps.adminPool.query(`UPDATE google_ads_request_runs SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1 WHERE id = $1`, [job.id]);
    emitOrgEvent(deps, tenantId, "google_ads:request_changed", { requestId: job.request_id, runId: job.id, status: "running" });
    await withContext(deps.appPool, { tenantId, userId: job.requested_by ?? null }, async (client) => {
      const request = await loadRequest(client, tenantId, job.request_id);
      if (!request) throw new Error("The request is gone.");
      if (!isOpenRequest(request.status)) throw new Error(`The request is ${request.status}.`);
      const account = request.account_id ? await loadAccountById(client, tenantId, request.account_id) : await loadAccount(client, tenantId);
      if (!account) throw new Error("The organization has no Google Ads account.");
      if (account.status !== "connected") throw new Error("The Google Ads account is not connected.");

      const answers: Record<string, any>[] = Array.isArray(request.content?.answers) ? request.content.answers : [];
      await say(answers.length ? `Reading the brief and the ${answers.length} answer${answers.length === 1 ? "" : "s"} received` : "Reading the brief");
      const { rows: changeRows } = await client.query(`SELECT message, created_at FROM google_ads_request_events WHERE request_id = $1 AND kind = 'changes_requested' ORDER BY created_at`, [request.id]);
      await say("Reading the Mission Profile, the website pages and the Google Ads account");
      const ctx = await buildAdsContext(deps, client, tenantId, account);
      await say(`Checking the last 30 days of performance — ${ctx.campaigns.length} campaign${ctx.campaigns.length === 1 ? "" : "s"}, ${ctx.keywords.length} keyword${ctx.keywords.length === 1 ? "" : "s"}`);
      await say("Running the Ad Grants compliance checks");
      const compliance = await complianceReport(client, account);
      await say("Forecasting this month's grant utilization");
      const utilization = await requestUtilization(client, account);
      const brief = {
        reference: `REQ-${String(request.number).padStart(4, "0")}`, title: request.title, goal: request.goal, goalDescription: REQUEST_GOALS[request.goal as RequestGoal] ?? null,
        priority: request.priority, submittedAt: request.submitted_at, ...request.content,
        changeRequests: changeRows.map((c) => ({ message: c.message, at: c.created_at })),
        administratorGuidance: job.instructions ?? null,
      };
      const grants = account.account_kind === "ad_grants" ? " This is a Google Ad Grants account." : account.account_kind === "standard" ? " This is a standard (paid) Google Ads account: grant-only limits do not apply, but paid spend needs explicit authorization." : "";
      await say("Assessing eligibility and policy, then writing the assessment and the campaign plan");
      const result = await runAgentTask<GoogleAdsRequestPlanOutput>(
        deps.provider, adsGrantsManager,
        `Handle campaign request ${brief.reference} ("${request.title}") for ${ctx.organization.name}.${grants} Decide proceed / needs_info / decline_recommended and return the full assessment.`,
        [
          { label: "campaign_request", content: JSON.stringify(brief) },
          { label: "organization", content: JSON.stringify(ctx.organization) },
          { label: "account", content: JSON.stringify({ ...ctx.account, promptVersion: adsGrantsManager.version }) },
          { label: "performance_30d", content: JSON.stringify(ctx.performance) },
          { label: "campaigns", content: JSON.stringify(ctx.campaigns) },
          { label: "keywords", content: JSON.stringify(ctx.keywords) },
          { label: "past_ads", content: JSON.stringify(ctx.pastAds) },
          { label: "compliance_report", content: JSON.stringify(compliance) },
          { label: "utilization_forecast", content: JSON.stringify(utilization) },
        ],
      );
      await client.query(
        `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',$3,$4)`,
        [uuidv7(), tenantId, Math.max(0, Math.round(result.tokensEstimated)), JSON.stringify({ agentKey: adsGrantsManager.agentKey, source: "google_ads", purpose: "campaign_request" })]);
      const out = result.output;
      const stored = { ...out, utilizationForecast: utilization, complianceSummary: compliance.summary, tokens: result.tokensEstimated, attempts: result.attempts, provider: deps.provider.name };
      await client.query(`UPDATE google_ads_request_runs SET status = 'completed', result = $2, finished_at = now(), error = NULL WHERE id = $1`, [job.id, JSON.stringify(stored)]);
      const askedAdmin = out.decision === "needs_info" && out.questions.length > 0 && out.questions.every((q) => q.audience === "admin");
      await addRequestEvent(client, { tenantId, requestId: request.id, kind: "run_completed", actorKind: "ai", message: out.adminSummary, metadata: { runId: job.id, decision: out.decision, audience: askedAdmin ? "admin" : "customer" }, customerVisible: false });
      await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId: job.requested_by ?? null, actorKind: "ai", action: "request_assessed", entityType: "request", entityId: request.id, newState: out.decision, summary: request.title, metadata: { runId: job.id, decision: out.decision } });
      const checks = out.assessment.policyChecks;
      const passed = checks.filter((c) => c.status === "pass").length;
      await say(`Policy checks done — ${passed} of ${checks.length} pass${checks.some((c) => c.status === "fail") ? ", some fail" : checks.some((c) => c.status === "warning") ? ", with warnings" : ""}`);

      if (out.decision === "needs_info") {
        const forAdmin = out.questions.filter((q) => q.audience === "admin");
        const toAdmin = askedAdmin;
        const content = { ...(request.content ?? {}), pendingQuestions: out.questions.map((q) => ({ ...q, askedBy: "ai", askedAt: new Date().toISOString() })) };
        await client.query(`UPDATE google_ads_campaign_requests SET content = $2 WHERE id = $1`, [request.id, JSON.stringify(content)]);
        if (toAdmin) {
          await say(`Needs a decision from Deedwell — ${forAdmin.length} question${forAdmin.length === 1 ? "" : "s"} for the administrator`, false);
          await transitionRequest(deps, client, { ...request, content }, "needs_admin", {
            actorKind: "ai", kind: "question_asked", message: out.adminSummary, customerMessage: out.customerSummary, metadata: { runId: job.id, questions: out.questions, audience: "admin" }, customerVisible: false,
          });
          await emailOps(client, { title: `The account manager has a question for you — ${brief.reference}`, body: out.adminSummary.slice(0, 800), rows: forAdmin.map((q) => ["Question", q.question]), tone: "warn" }, { tenantId, dedupe: `google_ads_request_admin_q:${job.id}` }).catch(() => 0);
          return;
        }
        const forCustomer = out.questions.filter((q) => q.audience !== "admin");
        await say(`Needs ${forCustomer.length} answer${forCustomer.length === 1 ? "" : "s"} from the organization before planning`);
        await transitionRequest(deps, client, { ...request, content }, "needs_info", { actorKind: "ai", kind: "question_asked", message: out.customerSummary, customerMessage: out.customerSummary, metadata: { runId: job.id, questions: out.questions }, email: true, questions: forCustomer.map((q) => q.question) });
        return;
      }
      if (out.decision === "decline_recommended") {
        await say("Recommends not going ahead — Deedwell decides", false);
        await transitionRequest(deps, client, request, "in_review", { actorKind: "ai", kind: "decline_recommended", message: out.declineReason ?? out.adminSummary, metadata: { runId: job.id }, customerVisible: false });
        return;
      }
      // proceed: the plan becomes a strategy, and the pipeline carries on.
      const plan = out.plan!;
      const { rows: v } = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM google_ads_strategies WHERE account_id = $1`, [account.id]);
      const strategyId = uuidv7();
      const { title, ...content } = plan;
      await client.query(
        `INSERT INTO google_ads_strategies (id, tenant_id, account_id, request_id, version, status, title, content, model_meta, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9)`,
        [strategyId, tenantId, account.id, request.id, Number(v[0].next), title, JSON.stringify(content),
          JSON.stringify({ provider: deps.provider.name, agentKey: adsGrantsManager.agentKey, tokens: result.tokensEstimated, attempts: result.attempts, requestId: request.id, runId: job.id }), job.requested_by ?? request.created_by]);
      await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId: job.requested_by ?? null, actorKind: "ai", action: "strategy_generated", entityType: "strategy", entityId: strategyId, newState: "draft", summary: title, metadata: { requestId: request.id } });
      const campaigns = (plan.campaigns ?? []).length;
      await say(`Campaign plan written — ${campaigns} campaign${campaigns === 1 ? "" : "s"}, ${(plan.keywordThemes ?? []).length} keyword theme${(plan.keywordThemes ?? []).length === 1 ? "" : "s"}`);
      const planned = await transitionRequest(deps, client, request, "planned", {
        actorKind: "ai", kind: "plan_ready", message: out.customerSummary, customerMessage: out.customerSummary, metadata: { runId: job.id, strategyId }, extra: { strategy_id: strategyId },
      });
      emitOrgEvent(deps, tenantId, "google_ads:strategy_changed", { strategyId });
      await continueAfterPlan(deps, client, planned, account, strategyId, job.requested_by ?? request.created_by);
    });
    opts.log?.info({ at: "google_ads.request_run_completed", runId: job.id });
  } catch (err) {
    await fail((err as Error).message ?? String(err));
  }
}
