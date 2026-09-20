/**
 * Campaign requests. A customer asks for a campaign from their dashboard;
 * Deedwell administrators receive it, hand it to the Ad Grants account
 * manager (the `google_ads.grants_manager` agent), and the request follows
 * the work — plan → approval → build → publish — until the campaign is live.
 *
 * The agent runs in audit-and-draft mode: its answer is a row in
 * google_ads_request_runs and, when it proceeds, an ordinary strategy row
 * (status draft, request_id set) that goes through the existing approve →
 * build → review → publish pipeline. Nothing here reaches Google Ads.
 */
import { runAgentTask } from "@deedwell/agent-runtime";
import { uuidv7, withContext } from "@deedwell/database";
import { emailOps, emailOrgAdmins, orgNameOf } from "@deedwell/email";
import {
  AD_GRANTS_DAILY_CAP_USD, AD_GRANTS_MONTHLY_LIMIT_USD, CANCELLABLE_REQUEST_STATUSES, REQUEST_GOALS, adsGrantsManager, utilizationForecast, isOpenRequest,
  type RequestGoal, type RequestStatus, type UtilizationForecast,
} from "@deedwell/google-ads-domain";
import type { GoogleAdsCampaignRequestInput, GoogleAdsRequestPlanOutput } from "@deedwell/schemas";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { buildAdsContext, loadStrategy } from "./ai.js";
import { complianceReport } from "./compliance.js";
import { emitOrgEvent, loadAccount, loadAccountById, logActivity, type AccountRow } from "./store.js";

type Log = { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
type Queryable = Pick<PoolClient, "query">;

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  submitted: "Submitted", in_review: "Under review", needs_info: "Needs your input", in_progress: "In progress", planned: "Plan ready",
  building: "Building the campaign", live: "Live", completed: "Completed", declined: "Declined", cancelled: "Cancelled",
};

/* ---- views --------------------------------------------------------------- */

const eventView = (e: Record<string, any>) => ({
  id: e.id, kind: e.kind, actorKind: e.actor_kind, actor: e.actor_name ?? null, fromStatus: e.from_status, toStatus: e.to_status,
  message: e.message, metadata: e.metadata ?? {}, customerVisible: Boolean(e.customer_visible), createdAt: e.created_at,
});

const runView = (r: Record<string, any>, full: boolean) => ({
  id: r.id, agentKey: r.agent_key, status: r.status, attempts: r.attempts, error: r.error, instructions: full ? r.instructions : undefined,
  startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at,
  result: full ? r.result ?? {} : undefined,
  decision: r.result?.decision ?? null,
});

function baseView(r: Record<string, any>) {
  return {
    id: r.id, number: r.number, reference: `REQ-${String(r.number).padStart(4, "0")}`, status: r.status, statusLabel: REQUEST_STATUS_LABEL[r.status as RequestStatus] ?? r.status,
    title: r.title, goal: r.goal, goalLabel: REQUEST_GOALS[r.goal as RequestGoal]?.label ?? r.goal, priority: r.priority,
    content: r.content ?? {}, customerMessage: r.customer_message ?? null,
    pendingQuestions: Array.isArray(r.content?.pendingQuestions) ? r.content.pendingQuestions : [],
    answers: Array.isArray(r.content?.answers) ? r.content.answers : [],
    strategyId: r.strategy_id ?? null, liveCampaignId: r.live_campaign_id ?? null,
    createdBy: r.created_by_name ?? null, submittedAt: r.submitted_at, updatedAt: r.updated_at, decidedAt: r.decided_at ?? null,
    declineReason: r.decline_reason ?? null, isOpen: isOpenRequest(r.status), canCancel: (CANCELLABLE_REQUEST_STATUSES as string[]).includes(r.status),
  };
}

/** What the customer sees: the brief, the status, the public timeline. */
export function customerRequestView(r: Record<string, any>, extra: { events?: Record<string, any>[]; campaign?: Record<string, any> | null } = {}) {
  return {
    ...baseView(r),
    events: (extra.events ?? []).filter((e) => e.customer_visible).map(eventView),
    campaign: extra.campaign ? { id: extra.campaign.id, name: extra.campaign.name, status: extra.campaign.status } : null,
  };
}

/** What the administrator sees: everything, including notes and the agent's runs. */
export function adminRequestView(r: Record<string, any>, extra: { events?: Record<string, any>[]; runs?: Record<string, any>[]; strategy?: unknown; drafts?: unknown[]; campaign?: Record<string, any> | null; orgName?: string } = {}) {
  return {
    ...baseView(r),
    orgId: r.tenant_id, orgName: extra.orgName ?? r.org_name ?? null, accountId: r.account_id ?? null,
    adminNotes: r.admin_notes ?? null, agentKey: r.agent_key ?? null, handedOffAt: r.handed_off_at ?? null, handedOffBy: r.handed_off_by_name ?? null,
    decidedBy: r.decided_by_name ?? null,
    events: (extra.events ?? []).map(eventView),
    runs: (extra.runs ?? []).map((run) => runView(run, true)),
    latestRun: extra.runs?.[0] ? runView(extra.runs[0]!, true) : null,
    strategy: extra.strategy ?? null,
    drafts: extra.drafts ?? [],
    campaign: extra.campaign ? { id: extra.campaign.id, campaignId: extra.campaign.campaign_id, name: extra.campaign.name, status: extra.campaign.status } : null,
  };
}

/* ---- reads --------------------------------------------------------------- */

const SELECT = `SELECT r.*, c.display_name AS created_by_name, h.display_name AS handed_off_by_name, d.display_name AS decided_by_name
                  FROM google_ads_campaign_requests r
                  LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users h ON h.id = r.handed_off_by LEFT JOIN users d ON d.id = r.decided_by`;

export async function listRequests(client: Queryable, tenantId: string): Promise<Record<string, any>[]> {
  const { rows } = await client.query(`${SELECT} WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [tenantId]);
  return rows;
}

export async function loadRequest(client: Queryable, tenantId: string, id: string): Promise<Record<string, any> | null> {
  const { rows } = await client.query(`${SELECT} WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, id]);
  return rows[0] ?? null;
}

export async function loadRequestEvents(client: Queryable, requestId: string): Promise<Record<string, any>[]> {
  const { rows } = await client.query(
    `SELECT e.*, u.display_name AS actor_name FROM google_ads_request_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.request_id = $1 ORDER BY e.created_at`, [requestId]);
  return rows;
}

export async function loadRequestRuns(client: Queryable, requestId: string): Promise<Record<string, any>[]> {
  const { rows } = await client.query(`SELECT * FROM google_ads_request_runs WHERE request_id = $1 ORDER BY created_at DESC`, [requestId]);
  return rows;
}

/** The synced campaign a live request produced, if any. */
export async function loadRequestCampaign(client: Queryable, request: Record<string, any>): Promise<Record<string, any> | null> {
  if (!request.live_campaign_id || !request.account_id) return null;
  const { rows } = await client.query(`SELECT id, campaign_id, name, status FROM google_ads_campaigns WHERE account_id = $1 AND campaign_id = $2`, [request.account_id, request.live_campaign_id]);
  return rows[0] ?? null;
}

/** Full detail for the admin page: strategy and drafts the request produced. */
export async function adminRequestDetail(client: PoolClient, tenantId: string, id: string, orgName?: string) {
  const request = await loadRequest(client, tenantId, id);
  if (!request) return null;
  const events = await loadRequestEvents(client, id);
  const runs = await loadRequestRuns(client, id);
  const campaign = await loadRequestCampaign(client, request);
  const strategy = request.strategy_id ? await loadStrategy(client, request.strategy_id) : null;
  const { rows: drafts } = request.strategy_id
    ? await client.query(`SELECT id, status, name, published_campaign_id, (model_meta->>'campaignIndex')::int AS campaign_index FROM google_ads_drafts WHERE strategy_id = $1 ORDER BY created_at DESC`, [request.strategy_id])
    : { rows: [] as Record<string, any>[] };
  return adminRequestView(request, {
    events, runs, campaign, orgName, strategy,
    drafts: drafts.map((d) => ({ id: d.id, status: d.status, name: d.name, campaignIndex: d.campaign_index, publishedCampaignId: d.published_campaign_id })),
  });
}

/** Every organization's requests, for the Platform Admin overview (admin pool). */
export async function requestsAcrossTenants(adminPool: Queryable, opts: { open?: boolean; limit?: number } = {}) {
  const { rows } = await adminPool.query(
    `SELECT r.*, o.name AS org_name, o.slug AS org_slug, c.display_name AS created_by_name, h.display_name AS handed_off_by_name, d.display_name AS decided_by_name,
            (SELECT status FROM google_ads_request_runs x WHERE x.request_id = r.id ORDER BY x.created_at DESC LIMIT 1) AS latest_run_status
       FROM google_ads_campaign_requests r JOIN organizations o ON o.id = r.tenant_id
       LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users h ON h.id = r.handed_off_by LEFT JOIN users d ON d.id = r.decided_by
      WHERE ($1::boolean IS NOT TRUE OR r.status NOT IN ('completed','declined','cancelled'))
      ORDER BY CASE WHEN r.status = 'submitted' THEN 0 WHEN r.status = 'needs_info' THEN 2 ELSE 1 END, r.priority = 'urgent' DESC, r.created_at DESC
      LIMIT $2`, [opts.open ?? false, Math.min(opts.limit ?? 200, 500)]);
  return rows.map((r) => ({ ...adminRequestView(r), orgSlug: r.org_slug, latestRunStatus: r.latest_run_status ?? null }));
}

/* ---- writes -------------------------------------------------------------- */

interface EventInput {
  tenantId: string; requestId: string; kind: string; actorKind?: "user" | "admin" | "system" | "ai"; actorUserId?: string | null;
  fromStatus?: string | null; toStatus?: string | null; message?: string | null; metadata?: Record<string, unknown>; customerVisible?: boolean;
}

export async function addRequestEvent(client: Queryable, input: EventInput): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO google_ads_request_events (id, tenant_id, request_id, kind, actor_kind, actor_user_id, from_status, to_status, message, metadata, customer_visible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, input.tenantId, input.requestId, input.kind, input.actorKind ?? "user", input.actorUserId ?? null, input.fromStatus ?? null, input.toStatus ?? null,
      input.message ?? null, JSON.stringify(input.metadata ?? {}), input.customerVisible ?? true]);
  return id;
}

/** Moves a request to `status`, records the transition, tells the customer
 *  when the change matters to them, and pings the org's event stream. */
export async function transitionRequest(
  deps: Deps, client: PoolClient, request: Record<string, any>, status: RequestStatus,
  opts: { actorKind?: "user" | "admin" | "system" | "ai"; actorUserId?: string | null; kind?: string; message?: string | null; customerMessage?: string | null; metadata?: Record<string, unknown>; customerVisible?: boolean; email?: boolean; questions?: string[]; extra?: Record<string, unknown> } = {},
): Promise<Record<string, any>> {
  const sets = ["status = $2"];
  const params: unknown[] = [request.id, status];
  if (opts.customerMessage !== undefined) { params.push(opts.customerMessage); sets.push(`customer_message = $${params.length}`); }
  for (const [key, value] of Object.entries(opts.extra ?? {})) { params.push(value); sets.push(`${key} = $${params.length}`); }
  await client.query(`UPDATE google_ads_campaign_requests SET ${sets.join(", ")} WHERE id = $1`, params);
  await addRequestEvent(client, {
    tenantId: request.tenant_id, requestId: request.id, kind: opts.kind ?? "status_changed", actorKind: opts.actorKind ?? "system", actorUserId: opts.actorUserId ?? null,
    fromStatus: request.status, toStatus: status, message: opts.message ?? null, metadata: opts.metadata, customerVisible: opts.customerVisible ?? true,
  });
  await logActivity(client, {
    tenantId: request.tenant_id, accountId: request.account_id ?? null, actorUserId: opts.actorUserId ?? null, actorKind: opts.actorKind ?? "system",
    action: `request_${status}`, entityType: "request", entityId: request.id, previousState: request.status, newState: status, summary: request.title,
    metadata: { number: request.number, ...(opts.metadata ?? {}) },
  });
  if (opts.email) {
    await emailOrgAdmins(client, request.tenant_id, "google_ads_request_update", {
      orgName: await orgNameOf(client, request.tenant_id), title: request.title, number: request.number, status, statusLabel: REQUEST_STATUS_LABEL[status],
      message: opts.customerMessage ?? opts.message ?? null, questions: opts.questions ?? [],
    }, { dedupe: `google_ads_request_update:${request.id}:${status}:${Date.now()}` }).catch(() => 0);
  }
  emitOrgEvent(deps, request.tenant_id, "google_ads:request_changed", { requestId: request.id, status });
  return (await loadRequest(client, request.tenant_id, request.id))!;
}

/** The customer submits a request. The account row is optional on purpose:
 *  the button lives on the connected page today, but a request keeps its
 *  meaning if the account is swapped later. */
export async function createRequest(deps: Deps, client: PoolClient, tenantId: string, userId: string, input: GoogleAdsCampaignRequestInput): Promise<Record<string, any>> {
  const account = await loadAccount(client, tenantId);
  const id = uuidv7();
  const { title, goal, priority, ...content } = input;
  await client.query(
    `INSERT INTO google_ads_campaign_requests (id, tenant_id, account_id, status, title, goal, priority, content, created_by)
     VALUES ($1,$2,$3,'submitted',$4,$5,$6,$7,$8)`,
    [id, tenantId, account?.id ?? null, title, goal, priority ?? "normal", JSON.stringify({ ...content, answers: [], pendingQuestions: [] }), userId]);
  const request = (await loadRequest(client, tenantId, id))!;
  await addRequestEvent(client, { tenantId, requestId: id, kind: "submitted", actorKind: "user", actorUserId: userId, toStatus: "submitted", message: `Request submitted: ${title}` });
  await logActivity(client, { tenantId, accountId: account?.id ?? null, customerId: account?.customer_id ?? null, actorUserId: userId, actorKind: "user", action: "request_submitted", entityType: "request", entityId: id, newState: "submitted", summary: title, metadata: { number: request.number, goal } });
  const orgName = await orgNameOf(client, tenantId);
  await emailOrgAdmins(client, tenantId, "google_ads_request_received", { orgName, title, number: request.number, goal: REQUEST_GOALS[goal]?.label ?? goal }, { dedupe: `google_ads_request_received:${id}` }).catch(() => 0);
  await emailOps(client, {
    title: `New Google Ads campaign request from ${orgName}`, tone: priority === "urgent" ? "warn" : "info",
    body: content.program.slice(0, 600),
    rows: [["Organization", orgName], ["Request", `REQ-${String(request.number).padStart(4, "0")} — ${title}`], ["Goal", REQUEST_GOALS[goal]?.label ?? goal], ["Priority", priority ?? "normal"], ["Geography", content.geography], ["Landing page", content.landingPage ?? "not given"]],
  }, { tenantId, dedupe: `google_ads_request_ops:${id}` }).catch(() => 0);
  emitOrgEvent(deps, tenantId, "google_ads:request_changed", { requestId: id, status: "submitted" });
  return request;
}

/** The customer answers the open questions. If the account manager had the
 *  request, it goes straight back to the agent; otherwise it returns to the
 *  administrator's review queue. */
export async function answerRequest(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, answers: Array<{ question: string; answer: string }>): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (request.status !== "needs_info") throw new RequestError(409, "This request is not waiting for your input.");
  const answeredAt = new Date().toISOString();
  const content = { ...(request.content ?? {}), answers: [...(request.content?.answers ?? []), ...answers.map((a) => ({ ...a, answeredAt }))], pendingQuestions: [] };
  await client.query(`UPDATE google_ads_campaign_requests SET content = $2 WHERE id = $1`, [id, JSON.stringify(content)]);
  await addRequestEvent(client, { tenantId, requestId: id, kind: "answered", actorKind: "user", actorUserId: userId, message: answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n"), metadata: { answers } });
  const fresh = { ...request, content };
  if (request.agent_key) {
    await enqueueRun(client, fresh, request.agent_key, null, null);
    return transitionRequest(deps, client, fresh, "in_progress", { actorKind: "user", actorUserId: userId, kind: "resumed", message: "Answers received — Deedwell's account manager is continuing the review." });
  }
  const orgName = await orgNameOf(client, tenantId);
  await emailOps(client, { title: `Campaign request answered by ${orgName}`, rows: [["Request", `REQ-${String(request.number).padStart(4, "0")} — ${request.title}`], ["Answers", String(answers.length)]] }, { tenantId }).catch(() => 0);
  return transitionRequest(deps, client, fresh, "in_review", { actorKind: "user", actorUserId: userId, kind: "resumed", message: "Answers received — back with the Deedwell team." });
}

export async function cancelRequest(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, reason: string | null): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (!(CANCELLABLE_REQUEST_STATUSES as string[]).includes(request.status)) throw new RequestError(409, "This request can no longer be cancelled from here — contact Deedwell if you need it stopped.");
  await client.query(`UPDATE google_ads_request_runs SET status = 'failed', error = 'Request cancelled', finished_at = now() WHERE request_id = $1 AND status = 'queued'`, [id]);
  return transitionRequest(deps, client, request, "cancelled", { actorKind: "user", actorUserId: userId, kind: "cancelled", message: reason ? `Cancelled by the organization: ${reason}` : "Cancelled by the organization.", extra: { decided_by: userId, decided_at: new Date() } });
}

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "RequestError"; }
}

/* ---- administrator actions ---------------------------------------------- */

async function enqueueRun(client: Queryable, request: Record<string, any>, agentKey: string, instructions: string | null, userId: string | null): Promise<Record<string, any>> {
  const { rows: busy } = await client.query(`SELECT id FROM google_ads_request_runs WHERE request_id = $1 AND status IN ('queued','running')`, [request.id]);
  if (busy[0]) throw new RequestError(409, "The account manager is already working on this request.");
  const id = uuidv7();
  const { rows } = await client.query(
    `INSERT INTO google_ads_request_runs (id, tenant_id, request_id, agent_key, instructions, status, requested_by) VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING *`,
    [id, request.tenant_id, request.id, agentKey, instructions, userId]);
  return rows[0];
}

/** Hands the request to the account manager (or re-runs it with guidance). */
export async function handoffRequest(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, instructions: string | null): Promise<{ request: Record<string, any>; run: Record<string, any> }> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (!isOpenRequest(request.status) || request.status === "live") throw new RequestError(409, `A ${REQUEST_STATUS_LABEL[request.status as RequestStatus].toLowerCase()} request cannot be handed off.`);
  const account = await loadAccount(client, tenantId);
  if (!account || account.status !== "connected") throw new RequestError(409, "The organization's Google Ads account is not connected; connect it before handing off.");
  const run = await enqueueRun(client, request, adsGrantsManager.agentKey, instructions, userId);
  await client.query(`UPDATE google_ads_campaign_requests SET agent_key = $2, handed_off_by = $3, handed_off_at = now(), account_id = COALESCE(account_id, $4) WHERE id = $1`, [id, adsGrantsManager.agentKey, userId, account.id]);
  const first = !request.handed_off_at;
  const updated = await transitionRequest(deps, client, { ...request, account_id: request.account_id ?? account.id }, "in_progress", {
    actorKind: "admin", actorUserId: userId, kind: "handed_off",
    message: first ? `Handed to ${adsGrantsManager.displayName}.` : `Sent back to ${adsGrantsManager.displayName}${instructions ? " with guidance" : ""}.`,
    metadata: { runId: run.id, instructions }, email: false,
  });
  return { request: updated, run };
}

/** The administrator asks the customer something directly. */
export async function askCustomer(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, questions: Array<{ question: string; why?: string | null }>, message: string | null): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (!isOpenRequest(request.status) || request.status === "live") throw new RequestError(409, "This request is closed.");
  const content = { ...(request.content ?? {}), pendingQuestions: questions.map((q) => ({ question: q.question, why: q.why ?? null, askedBy: "admin", askedAt: new Date().toISOString() })) };
  await client.query(`UPDATE google_ads_campaign_requests SET content = $2 WHERE id = $1`, [id, JSON.stringify(content)]);
  return transitionRequest(deps, client, { ...request, content }, "needs_info", {
    actorKind: "admin", actorUserId: userId, kind: "question_asked", message: message ?? "Deedwell needs a few more details to continue.",
    customerMessage: message ?? "Deedwell needs a few more details to continue.", metadata: { questions }, email: true, questions: questions.map((q) => q.question),
  });
}

export async function decideRequest(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, status: "in_review" | "in_progress" | "completed" | "declined", message: string | null, reason: string | null): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (!isOpenRequest(request.status)) throw new RequestError(409, "This request is already closed.");
  if (status === "in_progress" && !request.handed_off_at) throw new RequestError(409, "Hand the request off first.");
  const closing = status === "completed" || status === "declined";
  if (closing) await client.query(`UPDATE google_ads_request_runs SET status = 'failed', error = 'Request closed', finished_at = now() WHERE request_id = $1 AND status = 'queued'`, [id]);
  return transitionRequest(deps, client, request, status, {
    actorKind: "admin", actorUserId: userId, kind: status === "declined" ? "declined" : status === "completed" ? "completed" : "status_changed",
    message: message ?? (status === "declined" ? reason : null) ?? null, customerMessage: message ?? (status === "declined" ? reason : undefined),
    email: closing, extra: closing ? { decided_by: userId, decided_at: new Date(), decline_reason: status === "declined" ? reason : null } : {},
  });
}

export async function noteRequest(client: PoolClient, tenantId: string, userId: string, id: string, patch: { adminNotes?: string | null; customerMessage?: string | null }): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  const sets: string[] = []; const params: unknown[] = [id];
  if (patch.adminNotes !== undefined) { params.push(patch.adminNotes); sets.push(`admin_notes = $${params.length}`); }
  if (patch.customerMessage !== undefined) { params.push(patch.customerMessage); sets.push(`customer_message = $${params.length}`); }
  if (sets.length) await client.query(`UPDATE google_ads_campaign_requests SET ${sets.join(", ")} WHERE id = $1`, params);
  if (patch.adminNotes !== undefined) await addRequestEvent(client, { tenantId, requestId: id, kind: "note", actorKind: "admin", actorUserId: userId, message: patch.adminNotes, customerVisible: false });
  if (patch.customerMessage !== undefined && patch.customerMessage) await addRequestEvent(client, { tenantId, requestId: id, kind: "message", actorKind: "admin", actorUserId: userId, message: patch.customerMessage, customerVisible: true });
  return (await loadRequest(client, tenantId, id))!;
}

/* ---- pipeline hooks ------------------------------------------------------ */

/** Called when a strategy is approved: the request moves to "building". */
export async function onStrategyApproved(deps: Deps, client: PoolClient, strategy: Record<string, any>, userId: string | null): Promise<void> {
  if (!strategy.request_id) return;
  const request = await loadRequest(client, strategy.tenant_id, strategy.request_id);
  if (!request || !["planned", "in_progress", "in_review"].includes(request.status)) return;
  await transitionRequest(deps, client, request, "building", { actorKind: "admin", actorUserId: userId, kind: "strategy_approved", message: "The campaign plan was approved — Deedwell is now building the campaign for a final review.", customerMessage: "Your campaign plan is approved. Deedwell is writing the ads and preparing everything for a final check before it goes live." });
}

/** Called when a draft publishes: the request moves to "live". */
export async function onDraftPublished(deps: Deps, client: PoolClient, draft: Record<string, any>, campaignId: string | null, paused: boolean, userId: string | null): Promise<void> {
  const strategyId: string | null = draft.strategy?.id ?? draft.strategy_id ?? draft.strategyId ?? null;
  if (!strategyId) return;
  const { rows } = await client.query(`SELECT request_id, tenant_id FROM google_ads_strategies WHERE id = $1`, [strategyId]);
  const requestId = rows[0]?.request_id;
  if (!requestId) return;
  const request = await loadRequest(client, rows[0].tenant_id, requestId);
  if (!request || !isOpenRequest(request.status) || request.status === "live") return;
  await transitionRequest(deps, client, request, "live", {
    actorKind: "admin", actorUserId: userId, kind: "campaign_published",
    message: paused ? `Campaign "${draft.name}" was published to Google Ads (paused for a final check before it runs).` : `Campaign "${draft.name}" is live on Google Ads.`,
    customerMessage: paused ? "Your campaign is published to Google Ads. It starts running as soon as Deedwell finishes its final check." : "Your campaign is live on Google Ads.",
    metadata: { campaignId, draftId: draft.id }, email: true, extra: { live_campaign_id: campaignId },
  });
}

/* ---- the agent run ------------------------------------------------------ */

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

/** Runs one queued request run: assemble the evidence, ask the account
 *  manager, store its answer, and move the request accordingly. Only the
 *  tenant's own rows are visible to the agent (RLS under the tenant context). */
export async function runRequestRun(deps: Deps, job: Record<string, any>, opts: { log?: Log } = {}): Promise<void> {
  const tenantId: string = job.tenant_id;
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
    await withContext(deps.appPool, { tenantId, userId: job.requested_by ?? null }, async (client) => {
      const request = await loadRequest(client, tenantId, job.request_id);
      if (!request) throw new Error("The request is gone.");
      if (!isOpenRequest(request.status)) throw new Error(`The request is ${request.status}.`);
      const account = request.account_id ? await loadAccountById(client, tenantId, request.account_id) : await loadAccount(client, tenantId);
      if (!account) throw new Error("The organization has no Google Ads account.");
      if (account.status !== "connected") throw new Error("The Google Ads account is not connected.");

      const ctx = await buildAdsContext(deps, client, tenantId, account);
      const compliance = await complianceReport(client, account);
      const utilization = await requestUtilization(client, account);
      const brief = {
        reference: `REQ-${String(request.number).padStart(4, "0")}`, title: request.title, goal: request.goal, goalDescription: REQUEST_GOALS[request.goal as RequestGoal] ?? null,
        priority: request.priority, submittedAt: request.submitted_at, ...request.content,
        administratorGuidance: job.instructions ?? null,
      };
      const grants = account.account_kind === "ad_grants" ? " This is a Google Ad Grants account." : account.account_kind === "standard" ? " This is a standard (paid) Google Ads account: grant-only limits do not apply, but paid spend needs explicit authorization." : "";
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
      await addRequestEvent(client, { tenantId, requestId: request.id, kind: "run_completed", actorKind: "ai", message: out.adminSummary, metadata: { runId: job.id, decision: out.decision }, customerVisible: false });
      await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId: job.requested_by ?? null, actorKind: "ai", action: "request_assessed", entityType: "request", entityId: request.id, newState: out.decision, summary: request.title, metadata: { runId: job.id, decision: out.decision } });

      if (out.decision === "needs_info") {
        const content = { ...(request.content ?? {}), pendingQuestions: out.questions.map((q) => ({ ...q, askedBy: "ai", askedAt: new Date().toISOString() })) };
        await client.query(`UPDATE google_ads_campaign_requests SET content = $2 WHERE id = $1`, [request.id, JSON.stringify(content)]);
        await transitionRequest(deps, client, { ...request, content }, "needs_info", { actorKind: "ai", kind: "question_asked", message: out.customerSummary, customerMessage: out.customerSummary, metadata: { runId: job.id, questions: out.questions }, email: true, questions: out.questions.map((q) => q.question) });
        return;
      }
      if (out.decision === "decline_recommended") {
        await transitionRequest(deps, client, request, "in_review", { actorKind: "ai", kind: "decline_recommended", message: out.declineReason ?? out.adminSummary, metadata: { runId: job.id }, customerVisible: false });
        return;
      }
      // proceed: the plan becomes a draft strategy for the administrator to approve.
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
      await transitionRequest(deps, client, request, "planned", {
        actorKind: "ai", kind: "plan_ready", message: out.customerSummary, customerMessage: out.customerSummary, metadata: { runId: job.id, strategyId }, extra: { strategy_id: strategyId },
      });
      emitOrgEvent(deps, tenantId, "google_ads:strategy_changed", { strategyId });
    });
    opts.log?.info({ at: "google_ads.request_run_completed", runId: job.id });
  } catch (err) {
    await fail((err as Error).message ?? String(err));
  }
}
