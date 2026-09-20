/**
 * Campaign requests. A customer asks for a campaign from their dashboard;
 * Deedwell administrators receive it, hand it to the Ad Grants account
 * manager (the `google_ads.grants_manager` agent), and the request follows
 * the work — assessment → questions → plan → build (copy, keywords,
 * extensions, images) → one final approval → publish — until the campaign
 * is live.
 *
 * This module is the request's state: rows, timeline, views, the progress
 * checklist both dashboards render, and the customer/administrator actions.
 * The agent run lives in request-run.ts and the automatic continuation
 * (plan → build → approval → publish) in request-pipeline.ts; both build on
 * the helpers here.
 */
import { uuidv7 } from "@deedwell/database";
import { emailOps, emailOrgAdmins, orgNameOf } from "@deedwell/email";
import {
  CANCELLABLE_REQUEST_STATUSES, REQUEST_GOALS, REQUEST_STEPS, adsGrantsManager, isOpenRequest,
  type QuestionAudience, type RequestGoal, type RequestStatus, type RequestStep, type RequestStepKey, type RequestStepState,
} from "@deedwell/google-ads-domain";
import type { GoogleAdsCampaignRequestInput } from "@deedwell/schemas";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { loadStrategy } from "./ai.js";
import { adView, assetView, loadDraft } from "./drafts.js";
import { emitOrgEvent, loadAccount, logActivity } from "./store.js";

type Queryable = Pick<PoolClient, "query">;
type ActorKind = "user" | "admin" | "system" | "ai";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  submitted: "Submitted", in_review: "Under review", needs_info: "Needs your input", needs_admin: "Waiting on Deedwell", in_progress: "In progress", planned: "Plan ready",
  building: "Building the campaign", awaiting_approval: "Ready for your approval", publishing: "Publishing", live: "Live", completed: "Completed", declined: "Declined", cancelled: "Cancelled",
};

const isAdminQuestion = (q: Record<string, any>) => q?.audience === "admin";

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
  const pending: Record<string, any>[] = Array.isArray(r.content?.pendingQuestions) ? r.content.pendingQuestions : [];
  return {
    id: r.id, number: r.number, reference: `REQ-${String(r.number).padStart(4, "0")}`, status: r.status, statusLabel: REQUEST_STATUS_LABEL[r.status as RequestStatus] ?? r.status,
    title: r.title, goal: r.goal, goalLabel: REQUEST_GOALS[r.goal as RequestGoal]?.label ?? r.goal, priority: r.priority,
    content: r.content ?? {}, customerMessage: r.customer_message ?? null,
    pendingQuestions: pending,
    answers: Array.isArray(r.content?.answers) ? r.content.answers : [],
    strategyId: r.strategy_id ?? null, liveCampaignId: r.live_campaign_id ?? null,
    approval: r.approved_at ? { at: r.approved_at, by: r.approved_by_name ?? null, as: r.approved_as ?? null } : null,
    createdBy: r.created_by_name ?? null, submittedAt: r.submitted_at, updatedAt: r.updated_at, decidedAt: r.decided_at ?? null,
    declineReason: r.decline_reason ?? null, isOpen: isOpenRequest(r.status), canCancel: (CANCELLABLE_REQUEST_STATUSES as string[]).includes(r.status),
    canApprove: r.status === "awaiting_approval",
  };
}

/** Everything a detail view needs beyond the row. */
export interface RequestDetailExtra {
  events?: Record<string, any>[];
  runs?: Record<string, any>[];
  builds?: Record<string, any>[];
  drafts?: DraftSummary[];
  campaign?: Record<string, any> | null;
  strategy?: unknown;
  orgName?: string;
  preview?: unknown[];
}

/** What the customer sees: the brief, the status, the public timeline, the
 *  progress checklist, and — once built — the campaign to approve. */
export function customerRequestView(r: Record<string, any>, extra: RequestDetailExtra = {}) {
  const base = baseView(r);
  const detail = Boolean(extra.events);
  return {
    ...base,
    pendingQuestions: base.pendingQuestions.filter((q) => !isAdminQuestion(q)),
    events: (extra.events ?? []).filter((e) => e.customer_visible).map(eventView),
    progress: detail ? requestProgress(r, extra).map((step) => ({ ...step, activity: step.activity.filter((a) => a.customerVisible) })) : undefined,
    preview: extra.preview,
    campaign: extra.campaign ? { id: extra.campaign.id, name: extra.campaign.name, status: extra.campaign.status } : null,
  };
}

/** What the administrator sees: everything, including notes and the agent's runs. */
export function adminRequestView(r: Record<string, any>, extra: RequestDetailExtra = {}) {
  const base = baseView(r);
  const detail = Boolean(extra.events);
  return {
    ...base,
    adminQuestions: base.pendingQuestions.filter(isAdminQuestion),
    orgId: r.tenant_id, orgName: extra.orgName ?? r.org_name ?? null, accountId: r.account_id ?? null,
    adminNotes: r.admin_notes ?? null, agentKey: r.agent_key ?? null, handedOffAt: r.handed_off_at ?? null, handedOffBy: r.handed_off_by_name ?? null,
    decidedBy: r.decided_by_name ?? null,
    events: (extra.events ?? []).map(eventView),
    runs: (extra.runs ?? []).map((run) => runView(run, true)),
    latestRun: extra.runs?.[0] ? runView(extra.runs[0]!, true) : null,
    progress: detail ? requestProgress(r, extra) : undefined,
    strategy: extra.strategy ?? null,
    drafts: extra.drafts ?? [],
    preview: extra.preview,
    campaign: extra.campaign ? { id: extra.campaign.id, campaignId: extra.campaign.campaign_id, name: extra.campaign.name, status: extra.campaign.status } : null,
  };
}

/* ---- the progress checklist --------------------------------------------- */

export interface DraftSummary {
  id: string; status: string; name: string; campaignIndex: number | null; publishedCampaignId: string | null;
  images: { total: number; rendered: number; failed: number; pending: number };
}

const CLOSED_DRAFT = new Set(["rejected", "failed"]);

/** Computes the checklist from the request, its events, runs, builds and
 *  drafts. Pure: the same inputs always give the same steps, so the
 *  dashboards can poll or re-fetch on every event without flicker. */
export function requestProgress(r: Record<string, any>, x: RequestDetailExtra): RequestStep[] {
  const status: string = r.status;
  const events = x.events ?? [];
  const runs = x.runs ?? [];
  const builds = x.builds ?? [];
  const drafts = (x.drafts ?? []).filter((d) => !CLOSED_DRAFT.has(d.status));
  const latestRun = runs[0] ?? null;
  const lastEvent = (kind: string, pred?: (e: Record<string, any>) => boolean) => [...events].reverse().find((e) => e.kind === kind && (!pred || pred(e))) ?? null;
  const at = (e: Record<string, any> | null) => (e ? String(e.created_at instanceof Date ? e.created_at.toISOString() : e.created_at) : null);
  const activity = (step: RequestStepKey, pred?: (e: Record<string, any>) => boolean) => events
    .filter((e) => e.kind === "progress" && e.metadata?.step === step && (!pred || pred(e)))
    .slice(-12)
    .map((e) => ({ message: String(e.message ?? ""), at: at(e)!, customerVisible: Boolean(e.customer_visible) }));
  const pending: Record<string, any>[] = Array.isArray(r.content?.pendingQuestions) ? r.content.pendingQuestions : [];
  const answers: Record<string, any>[] = Array.isArray(r.content?.answers) ? r.content.answers : [];
  const runActive = latestRun && ["queued", "running"].includes(latestRun.status);
  const forRun = (e: Record<string, any>) => !latestRun || e.metadata?.runId === latestRun.id;
  const forStrategy = (e: Record<string, any>) => !r.strategy_id || !e.metadata?.strategyId || e.metadata.strategyId === r.strategy_id;

  const step = (key: RequestStepKey, state: RequestStepState, o: Partial<RequestStep> = {}): RequestStep => ({
    key, label: REQUEST_STEPS.find((s) => s.key === key)!.label, state, detail: o.detail ?? null, waitingOn: o.waitingOn ?? null, at: o.at ?? null, activity: o.activity ?? [],
  });
  const steps: RequestStep[] = [];

  steps.push(step("submitted", "done", { at: at({ created_at: r.submitted_at }), detail: r.created_by_name ? `by ${r.created_by_name}` : null }));

  const handoff = lastEvent("handed_off");
  steps.push(step("handoff", r.handed_off_at ? "done" : "todo", { at: r.handed_off_at ? at({ created_at: r.handed_off_at }) : null, detail: r.handed_off_at ? `${adsGrantsManager.displayName}${r.handed_off_by_name ? ` · by ${r.handed_off_by_name}` : ""}` : status === "submitted" || status === "in_review" ? "With the Deedwell team" : null, activity: handoff ? [] : [] }));

  // Assessment: the latest run tells the story; its narration is the activity.
  if (!latestRun) steps.push(step("assess", "todo"));
  else if (runActive) steps.push(step("assess", "active", { detail: latestRun.status === "queued" ? "Queued — starting shortly" : "Working", activity: activity("assess", forRun) }));
  else if (latestRun.status === "failed") steps.push(step("assess", "failed", { detail: latestRun.error ?? "The run failed", at: at({ created_at: latestRun.finished_at }), activity: activity("assess", forRun) }));
  else {
    const d = latestRun.result?.decision;
    const detail = d === "proceed" ? "Plan written" : d === "needs_info" ? `Asked ${latestRun.result?.questions?.length ?? ""} question${latestRun.result?.questions?.length === 1 ? "" : "s"}` : d === "decline_recommended" ? "Recommends declining" : null;
    steps.push(step("assess", "done", { detail, at: at({ created_at: latestRun.finished_at }), activity: activity("assess", forRun) }));
  }

  // Questions: waiting while someone has to answer; done once answers exist;
  // skipped when the plan came without any.
  if (status === "needs_info") steps.push(step("questions", "waiting", { waitingOn: "customer", detail: `Waiting on the organization · ${pending.filter((q) => !isAdminQuestion(q)).length || pending.length} question${pending.length === 1 ? "" : "s"}` }));
  else if (status === "needs_admin") steps.push(step("questions", "waiting", { waitingOn: "admin", detail: `Waiting on Deedwell · ${pending.filter(isAdminQuestion).length || pending.length} question${pending.length === 1 ? "" : "s"}` }));
  else if (answers.length) steps.push(step("questions", "done", { detail: `${answers.length} answer${answers.length === 1 ? "" : "s"} received`, at: answers[answers.length - 1]?.answeredAt ?? at(lastEvent("answered")) }));
  else if (r.strategy_id || lastEvent("plan_ready")) steps.push(step("questions", "skipped", { detail: "No questions needed" }));
  else steps.push(step("questions", "todo"));

  // Plan.
  const planReady = lastEvent("plan_ready");
  const declineRec = lastEvent("decline_recommended");
  if (r.strategy_id) steps.push(step("plan", "done", { at: at(planReady), detail: x.strategy && (x.strategy as any).title ? String((x.strategy as any).title) : null }));
  else if (declineRec && !runActive && status === "in_review") steps.push(step("plan", "waiting", { waitingOn: "admin", detail: "The account manager recommends declining — Deedwell decides" }));
  else steps.push(step("plan", "todo"));

  // Build: copy, keywords, extensions per campaign.
  const blocked = lastEvent("blocked");
  const buildsOpen = builds.filter((b) => ["queued", "running"].includes(b.status));
  const buildsTerminal = builds.length > 0 && buildsOpen.length === 0;
  const copyDone = builds.filter((b) => b.draft_id || b.status === "completed").length;
  const buildActivity = activity("build", forStrategy);
  if (!builds.length) {
    if (r.strategy_id && blocked && status === "planned") steps.push(step("build", "waiting", { waitingOn: "admin", detail: blocked.message ?? "Waiting on Deedwell" }));
    else steps.push(step("build", "todo"));
  } else if (buildsOpen.some((b) => b.status === "queued" || b.stage === "campaign")) {
    steps.push(step("build", "active", { detail: builds.length > 1 ? `${copyDone} of ${builds.length} campaigns written` : "Writing the ads, keywords, sitelinks and callouts", activity: buildActivity }));
  } else if (buildsTerminal && !drafts.length) {
    steps.push(step("build", "failed", { detail: builds.find((b) => b.error)?.error ?? "The build failed", activity: buildActivity }));
  } else {
    steps.push(step("build", "done", { detail: builds.length > 1 ? `${drafts.length} campaigns` : drafts[0]?.name ?? null, at: at(lastEvent("progress", (e) => e.metadata?.step === "build" && e.metadata?.done)) ?? at({ created_at: builds[builds.length - 1]?.finished_at ?? builds[builds.length - 1]?.updated_at }), activity: buildActivity }));
  }

  // Images.
  const img = drafts.reduce((acc, d) => ({ total: acc.total + d.images.total, rendered: acc.rendered + d.images.rendered, failed: acc.failed + d.images.failed, pending: acc.pending + d.images.pending }), { total: 0, rendered: 0, failed: 0, pending: 0 });
  const imageActivity = activity("images", forStrategy);
  const rendering = buildsOpen.some((b) => b.stage === "creatives");
  if (!builds.length || (!drafts.length && !buildsTerminal)) steps.push(step("images", "todo"));
  else if (rendering || (img.pending > 0 && buildsOpen.length)) steps.push(step("images", "active", { detail: `${img.rendered} of ${img.total} image${img.total === 1 ? "" : "s"} generated`, activity: imageActivity }));
  else if (buildsTerminal && img.total === 0) steps.push(step("images", "skipped", { detail: "No images for this campaign" }));
  else if (buildsTerminal) steps.push(step("images", img.rendered ? "done" : "failed", { detail: `${img.rendered} of ${img.total} image${img.total === 1 ? "" : "s"} generated${img.failed ? ` · ${img.failed} failed` : ""}`, at: at(lastEvent("progress", (e) => e.metadata?.step === "images" && e.metadata?.done)), activity: imageActivity }));
  else steps.push(step("images", "todo"));

  // Final approval.
  const changes = lastEvent("changes_requested");
  if (r.approved_at) steps.push(step("approval", "done", { at: at({ created_at: r.approved_at }), detail: `Approved by ${r.approved_by_name ?? (r.approved_as === "admin" ? "Deedwell" : "the organization")}${r.approved_as === "admin" ? " (Deedwell)" : ""}` }));
  else if (status === "awaiting_approval") steps.push(step("approval", "waiting", { waitingOn: "customer", detail: "Waiting for the organization or Deedwell to approve the campaign" }));
  else if (changes && status === "in_review" && drafts.length) steps.push(step("approval", "waiting", { waitingOn: "admin", detail: "Changes requested — with the Deedwell team" }));
  else steps.push(step("approval", "todo"));

  // Publish and live.
  const publishFailed = lastEvent("publish_failed");
  const published = lastEvent("campaign_published");
  if (status === "publishing") steps.push(step("publish", "active", { detail: "Creating the campaign in Google Ads", activity: activity("publish", forStrategy) }));
  else if (published) steps.push(step("publish", "done", { at: at(published), activity: activity("publish", forStrategy) }));
  else if (publishFailed && r.approved_at && !r.live_campaign_id) steps.push(step("publish", "failed", { detail: publishFailed.message ?? "Publishing failed", at: at(publishFailed) }));
  else steps.push(step("publish", "todo"));

  if (status === "live" || status === "completed") steps.push(step("live", "done", { at: at(published) ?? at(lastEvent("completed")), detail: x.campaign ? (x.campaign.status === "PAUSED" ? "Published paused — Deedwell switches it on after a final check" : "Running on Google Ads") : null }));
  else steps.push(step("live", "todo"));

  // A declined or cancelled request stops at its first unfinished step.
  if (status === "declined" || status === "cancelled") {
    const label = status === "declined" ? "Declined" : "Cancelled";
    const when = at(lastEvent(status));
    const first = steps.find((s) => s.state !== "done" && s.state !== "skipped");
    if (first) { first.state = "stopped"; first.detail = label; first.at = when; first.waitingOn = null; }
    for (const s of steps) if (s.state === "active" || s.state === "waiting") { s.state = "todo"; s.waitingOn = null; }
  }
  return steps;
}

/* ---- reads --------------------------------------------------------------- */

const SELECT = `SELECT r.*, c.display_name AS created_by_name, h.display_name AS handed_off_by_name, d.display_name AS decided_by_name, a.display_name AS approved_by_name
                  FROM google_ads_campaign_requests r
                  LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users h ON h.id = r.handed_off_by LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN users a ON a.id = r.approved_by`;

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

/** Builds queued for the request's strategy (oldest first). */
export async function loadRequestBuilds(client: Queryable, strategyId: string | null): Promise<Record<string, any>[]> {
  if (!strategyId) return [];
  const { rows } = await client.query(`SELECT * FROM google_ads_build_jobs WHERE strategy_id = $1 ORDER BY created_at`, [strategyId]);
  return rows;
}

/** The drafts the request's strategy produced, with image counts. */
export async function loadRequestDrafts(client: Queryable, strategyId: string | null): Promise<DraftSummary[]> {
  if (!strategyId) return [];
  const { rows } = await client.query(
    `SELECT d.id, d.status, d.name, d.published_campaign_id, (d.model_meta->>'campaignIndex')::int AS campaign_index,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id AND x.kind = 'image') AS img_total,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id AND x.kind = 'image' AND x.storage_key IS NOT NULL) AS img_rendered,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id AND x.kind = 'image' AND x.status = 'failed') AS img_failed,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id AND x.kind = 'image' AND x.status = 'draft') AS img_pending
       FROM google_ads_drafts d WHERE d.strategy_id = $1 ORDER BY d.created_at`, [strategyId]);
  return rows.map((d) => ({
    id: d.id, status: d.status, name: d.name, campaignIndex: d.campaign_index, publishedCampaignId: d.published_campaign_id,
    images: { total: Number(d.img_total), rendered: Number(d.img_rendered), failed: Number(d.img_failed), pending: Number(d.img_pending) },
  }));
}

/** The built campaign(s) as the approver sees them: budget, ads, keywords,
 *  sitelinks, callouts and images. Rejected/failed drafts are left out. */
export async function requestPreview(client: PoolClient, accountId: string | null, drafts: DraftSummary[]) {
  if (!accountId) return [];
  const out: unknown[] = [];
  for (const d of drafts) {
    if (CLOSED_DRAFT.has(d.status)) continue;
    const draft = await loadDraft(client, accountId, d.id);
    if (!draft) continue;
    const c = draft.content as Record<string, any>;
    out.push({
      id: draft.id, name: draft.name, status: draft.status, publishedCampaignId: draft.publishedCampaignId, validationOk: (draft.validation as any)?.ok ?? null,
      dailyBudget: c?.dailyBudgetMicros != null ? c.dailyBudgetMicros / 1_000_000 : null, currencyCode: c?.currencyCode ?? null,
      locations: c?.locations ?? c?.geoTargets ?? [], languages: c?.languages ?? [], rationale: draft.rationale,
      adGroups: (c?.adGroups ?? []).map((g: Record<string, any>) => ({ key: g.key ?? g.name, name: g.name, keywords: (g.keywords ?? []).map((k: any) => (typeof k === "string" ? k : k.text ?? k.keyword)).filter(Boolean) })),
      negativeKeywords: c?.negativeKeywords ?? [],
      ads: draft.ads.filter((a) => a.status !== "rejected").map((a) => ({ id: a.id, adGroupKey: a.adGroupKey, title: a.title, headlines: a.headlines, descriptions: a.descriptions, finalUrl: a.finalUrl, path1: a.path1, path2: a.path2, status: a.status })),
      sitelinks: draft.creatives.filter((x) => x.kind === "sitelink" && x.status !== "rejected").map((x) => ({ id: x.id, linkText: x.linkText, description1: x.description1, description2: x.description2, finalUrl: x.finalUrl })),
      callouts: draft.creatives.filter((x) => x.kind === "callout" && x.status !== "rejected").map((x) => ({ id: x.id, text: x.text })),
      images: draft.creatives.filter((x) => x.kind === "image").map((x) => ({ id: x.id, title: x.title, aspect: x.aspect, status: x.status, altText: x.altText, rendered: Boolean(x.image), version: x.image?.version ?? null, error: x.error })),
    });
  }
  return out;
}

async function detailExtra(client: PoolClient, request: Record<string, any>): Promise<RequestDetailExtra> {
  const events = await loadRequestEvents(client, request.id);
  const runs = await loadRequestRuns(client, request.id);
  const campaign = await loadRequestCampaign(client, request);
  const strategy = request.strategy_id ? await loadStrategy(client, request.strategy_id) : null;
  const builds = await loadRequestBuilds(client, request.strategy_id ?? null);
  const drafts = await loadRequestDrafts(client, request.strategy_id ?? null);
  const preview = drafts.length ? await requestPreview(client, request.account_id ?? null, drafts) : [];
  return { events, runs, campaign, strategy, builds, drafts, preview };
}

/** Full detail for the customer page. */
export async function customerRequestDetail(client: PoolClient, tenantId: string, id: string) {
  const request = await loadRequest(client, tenantId, id);
  if (!request) return null;
  return customerRequestView(request, await detailExtra(client, request));
}

/** Full detail for the admin page: strategy, builds and drafts the request produced. */
export async function adminRequestDetail(client: PoolClient, tenantId: string, id: string, orgName?: string) {
  const request = await loadRequest(client, tenantId, id);
  if (!request) return null;
  return adminRequestView(request, { ...(await detailExtra(client, request)), orgName });
}

/** Every organization's requests, for the Platform Admin overview (admin pool). */
export async function requestsAcrossTenants(adminPool: Queryable, opts: { open?: boolean; limit?: number } = {}) {
  const { rows } = await adminPool.query(
    `SELECT r.*, o.name AS org_name, o.slug AS org_slug, c.display_name AS created_by_name, h.display_name AS handed_off_by_name, d.display_name AS decided_by_name, a.display_name AS approved_by_name,
            (SELECT status FROM google_ads_request_runs x WHERE x.request_id = r.id ORDER BY x.created_at DESC LIMIT 1) AS latest_run_status
       FROM google_ads_campaign_requests r JOIN organizations o ON o.id = r.tenant_id
       LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users h ON h.id = r.handed_off_by LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN users a ON a.id = r.approved_by
      WHERE ($1::boolean IS NOT TRUE OR r.status NOT IN ('completed','declined','cancelled'))
      ORDER BY CASE WHEN r.status IN ('submitted','needs_admin') THEN 0 WHEN r.status = 'needs_info' THEN 2 ELSE 1 END, r.priority = 'urgent' DESC, r.created_at DESC
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

/**
 * Live narration for the progress checklist. Written on the admin pool,
 * outside whatever transaction the worker holds, so the dashboards see each
 * line the moment it happens (a request run or build lives in one long
 * transaction; anything written inside it would only show at commit).
 */
export async function narrate(
  deps: Deps, request: { id: string; tenant_id: string }, step: RequestStepKey, message: string,
  opts: { customerVisible?: boolean; metadata?: Record<string, unknown>; actorKind?: ActorKind } = {},
): Promise<void> {
  try {
    await deps.adminPool.query(
      `INSERT INTO google_ads_request_events (id, tenant_id, request_id, kind, actor_kind, message, metadata, customer_visible) VALUES ($1,$2,$3,'progress',$4,$5,$6,$7)`,
      [uuidv7(), request.tenant_id, request.id, opts.actorKind ?? "ai", message.slice(0, 400), JSON.stringify({ step, ...(opts.metadata ?? {}) }), opts.customerVisible ?? true]);
  } catch { /* narration is best-effort */ }
  emitOrgEvent(deps, request.tenant_id, "google_ads:request_changed", { requestId: request.id, step, progress: true });
}

/** The request a strategy belongs to, if any (admin pool: called from workers). */
export async function requestOfStrategy(deps: Deps, strategyId: string): Promise<{ id: string; tenant_id: string; status: string; strategy_id: string; account_id: string | null } | null> {
  const { rows } = await deps.adminPool.query(
    `SELECT r.id, r.tenant_id, r.status, r.strategy_id, r.account_id FROM google_ads_strategies s JOIN google_ads_campaign_requests r ON r.id = s.request_id WHERE s.id = $1`, [strategyId]);
  return rows[0] ?? null;
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

/** The customer (or, for the account manager's questions to Deedwell, an
 *  administrator) answers the open questions. If the account manager had the
 *  request, it goes straight back to the agent; otherwise it returns to the
 *  administrator's review queue. */
export async function answerRequest(
  deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, answers: Array<{ question: string; answer: string }>,
  as: QuestionAudience = "customer",
): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (as === "customer" && request.status !== "needs_info") throw new RequestError(409, "This request is not waiting for your input.");
  if (as === "admin" && request.status !== "needs_admin") throw new RequestError(409, "This request is not waiting on Deedwell.");
  const answeredAt = new Date().toISOString();
  const content = {
    ...(request.content ?? {}),
    answers: [...(request.content?.answers ?? []), ...answers.map((a) => ({ ...a, answeredBy: as, answeredAt }))],
    pendingQuestions: [],
  };
  await client.query(`UPDATE google_ads_campaign_requests SET content = $2 WHERE id = $1`, [id, JSON.stringify(content)]);
  await addRequestEvent(client, {
    tenantId, requestId: id, kind: "answered", actorKind: as === "admin" ? "admin" : "user", actorUserId: userId,
    message: answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n"), metadata: { answers, audience: as }, customerVisible: as === "customer",
  });
  const fresh = { ...request, content };
  if (request.agent_key) {
    await enqueueRun(client, fresh, request.agent_key, null, as === "admin" ? userId : null);
    return transitionRequest(deps, client, fresh, "in_progress", {
      actorKind: as === "admin" ? "admin" : "user", actorUserId: userId, kind: "resumed",
      message: as === "admin" ? "Deedwell answered — the account manager is continuing." : "Answers received — Deedwell's account manager is continuing the review.",
    });
  }
  const orgName = await orgNameOf(client, tenantId);
  if (as === "customer") await emailOps(client, { title: `Campaign request answered by ${orgName}`, rows: [["Request", `REQ-${String(request.number).padStart(4, "0")} — ${request.title}`], ["Answers", String(answers.length)]] }, { tenantId }).catch(() => 0);
  return transitionRequest(deps, client, fresh, "in_review", { actorKind: as === "admin" ? "admin" : "user", actorUserId: userId, kind: "resumed", message: "Answers received — back with the Deedwell team." });
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
  if (!isOpenRequest(request.status) || ["live", "publishing"].includes(request.status)) throw new RequestError(409, `A ${REQUEST_STATUS_LABEL[request.status as RequestStatus].toLowerCase()} request cannot be handed off.`);
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
  emitOrgEvent(deps, tenantId, "google_ads:request_changed", { requestId: id, runId: run.id, status: "queued" });
  return { request: updated, run };
}

/** The administrator asks the customer something directly. */
export async function askCustomer(deps: Deps, client: PoolClient, tenantId: string, userId: string, id: string, questions: Array<{ question: string; why?: string | null }>, message: string | null): Promise<Record<string, any>> {
  const request = await loadRequest(client, tenantId, id);
  if (!request) throw new RequestError(404, "Request not found");
  if (!isOpenRequest(request.status) || ["live", "publishing"].includes(request.status)) throw new RequestError(409, "This request is closed.");
  const content = { ...(request.content ?? {}), pendingQuestions: questions.map((q) => ({ question: q.question, why: q.why ?? null, audience: "customer", askedBy: "admin", askedAt: new Date().toISOString() })) };
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

/** Called when a strategy is approved (by hand or by the pipeline): the
 *  request moves to "building". */
export async function onStrategyApproved(deps: Deps, client: PoolClient, strategy: Record<string, any>, userId: string | null, opts: { auto?: boolean } = {}): Promise<void> {
  if (!strategy.request_id) return;
  const request = await loadRequest(client, strategy.tenant_id, strategy.request_id);
  if (!request || !["planned", "in_progress", "in_review"].includes(request.status)) return;
  await transitionRequest(deps, client, request, "building", {
    actorKind: opts.auto ? "ai" : "admin", actorUserId: userId, kind: "strategy_approved",
    message: opts.auto ? "The plan is set — the account manager is now writing the ads, keywords and extensions and generating the images." : "The campaign plan was approved — Deedwell is now building the campaign for a final review.",
    customerMessage: "Your campaign plan is ready. Deedwell is writing the ads, choosing keywords and generating images; you approve the finished campaign before it goes live.",
  });
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
    actorKind: userId ? "admin" : "system", actorUserId: userId, kind: "campaign_published",
    message: paused ? `Campaign "${draft.name}" was published to Google Ads (paused for a final check before it runs).` : `Campaign "${draft.name}" is live on Google Ads.`,
    customerMessage: paused ? "Your campaign is published to Google Ads. It starts running as soon as Deedwell finishes its final check." : "Your campaign is live on Google Ads.",
    metadata: { campaignId, draftId: draft.id }, email: true, extra: { live_campaign_id: campaignId },
  });
}

/** Called when a publish job fails: the request goes back to the Deedwell
 *  team, and the customer is told in plain words. */
export async function onPublishFailed(deps: Deps, client: PoolClient, draftId: string, message: string): Promise<void> {
  const { rows } = await client.query(`SELECT s.request_id, s.tenant_id FROM google_ads_drafts d JOIN google_ads_strategies s ON s.id = d.strategy_id WHERE d.id = $1`, [draftId]);
  const requestId = rows[0]?.request_id;
  if (!requestId) return;
  const request = await loadRequest(client, rows[0].tenant_id, requestId);
  if (!request || request.status !== "publishing") return;
  await addRequestEvent(client, { tenantId: request.tenant_id, requestId, kind: "publish_failed", actorKind: "system", message: message.slice(0, 400), metadata: { draftId }, customerVisible: false });
  await transitionRequest(deps, client, request, "in_review", {
    actorKind: "system", kind: "status_changed", message: "Publishing did not go through — back with the Deedwell team.",
    customerMessage: "Google Ads did not accept the campaign on the first try. Deedwell is looking into it and will publish as soon as it is fixed.", email: false,
  });
}
