/**
 * What happens to a campaign request after the account manager's plan,
 * without anyone clicking: the strategy is approved, one build per campaign
 * is queued (copy, keywords, sitelinks, callouts, then images), every stage
 * is narrated into the request's progress checklist, and once the last
 * build finishes the request waits for ONE final approval — the customer's
 * or an administrator's — which publishes it. Administrators can still stop
 * a request, ask the customer, or send it back to the agent at any point.
 */
import { withContext } from "@deedwell/database";
import { emailOps, orgNameOf } from "@deedwell/email";
import type { QuestionAudience } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import { billingState } from "../billing-gate.js";
import type { Deps } from "../bootstrap.js";
import { enqueueBuilds, type BuildHooks } from "./build.js";
import { decideDraft } from "./drafts.js";
import { requestPublish } from "./publish.js";
import {
  REQUEST_STATUS_LABEL, RequestError, addRequestEvent, loadRequest, loadRequestBuilds, loadRequestDrafts, narrate, onStrategyApproved, requestOfStrategy, transitionRequest,
} from "./requests.js";
import { emitOrgEvent, loadAccountById, type AccountRow } from "./store.js";

/** The plan is in: approve the strategy and queue the builds. Runs inside
 *  the request run's tenant transaction. */
export async function continueAfterPlan(deps: Deps, client: PoolClient, request: Record<string, any>, account: AccountRow, strategyId: string, actorUserId: string): Promise<void> {
  const ref = { id: request.id as string, tenant_id: request.tenant_id as string };
  const billing = await billingState(client, request.tenant_id);
  if (billing.blocked) {
    await addRequestEvent(client, { tenantId: request.tenant_id, requestId: request.id, kind: "blocked", actorKind: "system", message: "The organization is out of tokens — the campaign build waits until it tops up or is marked exempt.", metadata: { strategyId, reason: "payment_required" }, customerVisible: false });
    await emailOps(client, { title: `Campaign request paused: ${await orgNameOf(client, request.tenant_id)} is out of tokens`, body: "The plan is written but the build cannot start until the organization tops up or is marked exempt.", rows: [["Request", `REQ-${String(request.number).padStart(4, "0")} — ${request.title}`]], tone: "warn" }, { tenantId: request.tenant_id, dedupe: `google_ads_request_blocked:${strategyId}` }).catch(() => 0);
    emitOrgEvent(deps, request.tenant_id, "google_ads:request_changed", { requestId: request.id, status: "planned" });
    return;
  }
  const { rows } = await client.query(`UPDATE google_ads_strategies SET status = 'approved', approved_by = NULL, approved_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`, [strategyId]);
  if (!rows[0]) return;
  const builds = await enqueueBuilds(client, account, rows[0], actorUserId);
  await onStrategyApproved(deps, client, rows[0], null, { auto: true });
  await narrate(deps, ref, "build", builds.length === 1 ? `Queued the campaign build: ${builds[0]!.campaignName}` : `Queued ${builds.length} campaign builds`, { metadata: { strategyId } });
}

/** Narration and continuation from the build worker. */
export function requestBuildHooks(deps: Deps): BuildHooks {
  const ref = async (job: Record<string, any>) => requestOfStrategy(deps, job.strategy_id);
  return {
    async started(job) {
      const r = await ref(job);
      if (r) await narrate(deps, r, "build", `Writing the ads, keywords, sitelinks and callouts for “${job.campaign_name ?? "the campaign"}”`, { metadata: { strategyId: job.strategy_id, buildId: job.id } });
    },
    async campaignWritten(job, draft) {
      const r = await ref(job);
      if (!r) return;
      await narrate(deps, r, "build", `“${draft.name}” written — ${draft.ads} ad${draft.ads === 1 ? "" : "s"}, ${draft.keywords} keyword${draft.keywords === 1 ? "" : "s"}, ${draft.sitelinks} sitelink${draft.sitelinks === 1 ? "" : "s"}, ${draft.callouts} callout${draft.callouts === 1 ? "" : "s"}`, { metadata: { strategyId: job.strategy_id, buildId: job.id, draftId: draft.id, done: true } });
      if (draft.images > 0) await narrate(deps, r, "images", `Generating ${draft.images} image${draft.images === 1 ? "" : "s"} for “${draft.name}”`, { metadata: { strategyId: job.strategy_id, buildId: job.id, draftId: draft.id } });
    },
    async imageRendered(job, info) {
      const r = await ref(job);
      if (r) await narrate(deps, r, "images", info.ok ? `Image ${info.index} of ${info.total} generated${info.title ? ` — ${info.title}` : ""}` : `Image ${info.index} of ${info.total} could not be generated${info.error ? ` (${info.error})` : ""}`, { metadata: { strategyId: job.strategy_id, buildId: job.id, draftId: info.draftId, ok: info.ok } });
    },
    async finished(job, info) {
      const r = await ref(job);
      if (!r) return;
      if (info.status === "failed") await narrate(deps, r, "build", `The build of “${job.campaign_name ?? "the campaign"}” failed: ${info.error ?? "unknown error"}`, { customerVisible: false, metadata: { strategyId: job.strategy_id, buildId: job.id } });
      else if (info.images.total) await narrate(deps, r, "images", `${info.images.rendered} of ${info.images.total} image${info.images.total === 1 ? "" : "s"} ready for “${job.campaign_name ?? "the campaign"}”`, { metadata: { strategyId: job.strategy_id, buildId: job.id, done: true } });
      await onBuildsSettled(deps, r);
    },
  };
}

/** When the last build of a request's strategy has finished, the request
 *  moves to the final approval (or back to the team when nothing usable
 *  came out). */
async function onBuildsSettled(deps: Deps, r: { id: string; tenant_id: string; strategy_id: string }): Promise<void> {
  await withContext(deps.appPool, { tenantId: r.tenant_id, userId: null }, async (client) => {
    const request = await loadRequest(client, r.tenant_id, r.id);
    if (!request || request.status !== "building") return;
    const builds = await loadRequestBuilds(client, r.strategy_id);
    if (builds.some((b) => ["queued", "running"].includes(b.status))) return;
    const drafts = (await loadRequestDrafts(client, r.strategy_id)).filter((d) => !["rejected", "failed"].includes(d.status));
    if (!drafts.length) {
      await transitionRequest(deps, client, request, "in_review", { actorKind: "system", kind: "build_failed", message: builds.find((b) => b.error)?.error ?? "The campaign build failed.", customerVisible: false });
      await emailOps(client, { title: `Campaign build failed — REQ-${String(request.number).padStart(4, "0")}`, body: builds.find((b) => b.error)?.error ?? null, rows: [["Request", request.title]], tone: "warn" }, { tenantId: r.tenant_id, dedupe: `google_ads_request_build_failed:${r.strategy_id}` }).catch(() => 0);
      return;
    }
    const images = drafts.reduce((n, d) => n + d.images.rendered, 0);
    const summary = `${drafts.length === 1 ? `“${drafts[0]!.name}”` : `${drafts.length} campaigns`} — ${images} image${images === 1 ? "" : "s"} generated`;
    await transitionRequest(deps, client, request, "awaiting_approval", {
      actorKind: "ai", kind: "ready_for_approval", message: `The campaign is built: ${summary}. Waiting for the organization or Deedwell to approve it.`,
      customerMessage: "Your campaign is built — the ads, keywords and images are ready for you to look over. Approve it and Deedwell publishes it to Google Ads.",
      metadata: { strategyId: r.strategy_id, drafts: drafts.map((d) => d.id) }, email: true,
    });
    await emailOps(client, { title: `Campaign ready for approval — REQ-${String(request.number).padStart(4, "0")} (${await orgNameOf(client, r.tenant_id)})`, body: summary, rows: [["Request", request.title]], tone: "info" }, { tenantId: r.tenant_id, dedupe: `google_ads_request_ready:${r.strategy_id}` }).catch(() => 0);
  }).catch(() => undefined);
}

const PUBLISHABLE = new Set(["draft", "awaiting_approval", "approved", "failed"]);

/** The last step: the customer or an administrator approves the built
 *  campaign(s); each draft is approved and queued to publish. */
export async function approveRequest(
  deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string,
  opts: { as: QuestionAudience; enableOnPublish: boolean; message?: string | null },
): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  const allowed = opts.as === "admin" ? ["awaiting_approval", "in_review"] : ["awaiting_approval"];
  if (!allowed.includes(request.status)) throw new RequestError(409, opts.as === "admin" ? `A ${REQUEST_STATUS_LABEL[request.status as keyof typeof REQUEST_STATUS_LABEL]?.toLowerCase() ?? request.status} request cannot be published from here.` : "This request is not waiting for your approval.");
  if (!request.account_id) throw new RequestError(409, "The request has no Google Ads account.");
  const account = await loadAccountById(client, tenantId, request.account_id);
  if (!account || account.status !== "connected") throw new RequestError(409, "The Google Ads account is not connected.");
  const drafts = (await loadRequestDrafts(client, request.strategy_id ?? null)).filter((d) => PUBLISHABLE.has(d.status));
  if (!drafts.length) throw new RequestError(409, "There is no built campaign to publish yet.");
  const orgName = await orgNameOf(client, tenantId);
  for (const d of drafts) {
    try {
      if (d.status !== "approved") await decideDraft(client, account, d.id, "approve", userId);
      await requestPublish(deps, client, account, d.id, userId, { confirmName: d.name, enableOnPublish: opts.enableOnPublish }, orgName);
    } catch (err) {
      throw new RequestError(409, `“${d.name}” cannot be published yet: ${(err as Error).message}`);
    }
  }
  const who = opts.as === "admin" ? "Deedwell" : "The organization";
  const updated = await transitionRequest(deps, client, request, "publishing", {
    actorKind: opts.as === "admin" ? "admin" : "user", actorUserId: userId, kind: "approved",
    message: `${who} approved the campaign${opts.message ? `: ${opts.message}` : "."} Publishing to Google Ads${opts.enableOnPublish ? "" : " (paused)"}.`,
    customerMessage: opts.as === "admin" ? "Deedwell approved the campaign and is publishing it to Google Ads." : "Thanks for approving — Deedwell is publishing your campaign to Google Ads now.",
    metadata: { as: opts.as, enableOnPublish: opts.enableOnPublish, drafts: drafts.map((d) => d.id) },
    extra: { approved_by: userId, approved_at: new Date(), approved_as: opts.as },
  });
  await narrate(deps, { id, tenant_id: tenantId }, "publish", `Creating ${drafts.length === 1 ? `“${drafts[0]!.name}”` : `${drafts.length} campaigns`} in Google Ads`, { actorKind: "system", metadata: { strategyId: request.strategy_id } });
  if (opts.as === "customer") await emailOps(client, { title: `${orgName} approved campaign request REQ-${String(request.number).padStart(4, "0")}`, body: opts.message ?? "Publishing now.", rows: [["Request", request.title]] }, { tenantId, dedupe: `google_ads_request_approved:${id}` }).catch(() => 0);
  return updated;
}

/** The customer sends the built campaign back with what to change; the
 *  Deedwell team picks it up (and can send it back to the agent with the
 *  change request as guidance). */
export async function requestChanges(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, message: string): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (request.status !== "awaiting_approval") throw new RequestError(409, "This request is not waiting for your approval.");
  const orgName = await orgNameOf(client, tenantId);
  const updated = await transitionRequest(deps, client, request, "in_review", { actorKind: "user", actorUserId: userId, kind: "changes_requested", message, metadata: { message } });
  await emailOps(client, { title: `${orgName} asked for changes to REQ-${String(request.number).padStart(4, "0")}`, body: message, rows: [["Request", request.title]], tone: "warn" }, { tenantId, dedupe: `google_ads_request_changes:${id}:${Date.now()}` }).catch(() => 0);
  return updated;
}
