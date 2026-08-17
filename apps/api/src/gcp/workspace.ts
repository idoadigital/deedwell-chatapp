import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import type { GcpIds } from "./platform.js";
import { ensureGcpIds, getChannelLink } from "./links.js";
import { taskPhrases, teammateForTask } from "./teammate-map.js";

/**
 * The workspace panel's view of a platform-backed application: real persisted
 * backend state (requirements, missing information, strategy, sections,
 * budget, deterministic compliance, deliverables, Evidence Library), fetched
 * server-side with the tenant's own backend identity. Nothing is computed
 * here — readiness percentages, verdicts, and counts all come from the
 * platform, which never fakes progress.
 */

export interface GcpWorkspaceBlock {
  application: Record<string, unknown> | null;
  readiness: Record<string, unknown> | null;
  requirements: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  strategy: Record<string, unknown> | null;
  strategyApprovedVersion: number | null;
  sections: Record<string, unknown> | null;
  budget: Record<string, unknown> | null;
  compliance: Record<string, unknown> | null;
  deliverables: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  evidenceCount: number;
  activity: { tasks: Array<Record<string, unknown>>; counts: Record<string, unknown> };
}

// The panel refetches on every SSE tick and a 10s poll; a short TTL cache
// keeps that from turning into a stampede of upstream calls.
const CACHE_TTL_MS = 3_000;
const cache = new Map<string, { at: number; value: GcpWorkspaceBlock | null }>();

export async function buildGcpWorkspace(
  deps: Deps,
  client: PoolClient,
  ids: { tenantId: string; userId: string },
  projectId: string
): Promise<GcpWorkspaceBlock | null> {
  const platform = deps.gcp;
  if (!platform) return null;
  const { rows: chan } = await client.query(
    "SELECT id FROM channels WHERE project_id = $1 LIMIT 1", [projectId]);
  if (!chan[0]) return null;
  const link = await getChannelLink(client, chan[0].id);
  if (!link) return null;

  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const gcpIds = await ensureGcpIds(platform, client, ids.tenantId, ids.userId);
  const appId = link.gcp_application_id;

  const [activityR, appR, reqR, askR, stratR, secR, budR, compR, delivR, docsR, evR] =
    await Promise.allSettled([
      platform.activity(link.gcp_conversation_id, gcpIds),
      appId ? platform.applicationOverview(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.requirements(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.informationRequests(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.strategy(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.sections(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.budget(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.compliance(appId, gcpIds) : Promise.resolve(null),
      appId ? platform.deliverables(appId, gcpIds) : Promise.resolve(null),
      platform.documents(gcpIds),
      platform.evidence(gcpIds, { limit: 500 }),
    ]);

  const val = <T>(r: PromiseSettledResult<T>): T | null => r.status === "fulfilled" ? r.value : null;
  const activity = (val(activityR) ?? { tasks: [], counts: {} }) as Record<string, unknown>;
  const reqBody = val(reqR) as Record<string, unknown> | null;
  const askBody = val(askR) as Record<string, unknown> | null;
  const stratBody = val(stratR) as Record<string, unknown> | null;
  const secBody = val(secR) as Record<string, unknown> | null;
  const budBody = val(budR) as Record<string, unknown> | null;
  const compBody = val(compR) as Record<string, unknown> | null;
  const delivBody = val(delivR) as Record<string, unknown> | null;
  const docsBody = val(docsR) as Record<string, unknown> | null;
  const evBody = val(evR) as Record<string, unknown> | null;

  const block: GcpWorkspaceBlock = {
    application: (val(appR) as Record<string, unknown> | null),
    readiness: (reqBody?.readiness as Record<string, unknown>) ?? null,
    requirements: (reqBody?.requirements as Array<Record<string, unknown>>) ?? [],
    questions: ((askBody?.requests as Array<Record<string, unknown>>) ?? [])
      .filter((q) => q.status === "OPEN"),
    strategy: (stratBody?.strategy as Record<string, unknown>) ?? null,
    strategyApprovedVersion: (stratBody?.approved_version as number) ?? null,
    sections: secBody ? { progress: secBody.progress, sections: secBody.sections } : null,
    budget: (budBody?.budget as Record<string, unknown>) ?? null,
    compliance: (compBody?.latest as Record<string, unknown>) ?? null,
    deliverables: (delivBody?.deliverables as Array<Record<string, unknown>>) ?? [],
    documents: (docsBody?.documents as Array<Record<string, unknown>>) ?? [],
    evidenceCount: Number(evBody?.count ?? 0),
    activity: {
      tasks: (activity.tasks as Array<Record<string, unknown>>) ?? [],
      counts: (activity.counts as Record<string, unknown>) ?? {},
    },
  };
  cache.set(projectId, { at: Date.now(), value: block });
  return block;
}

/** Platform tasks/events rendered as the panel's existing activity timeline. */
export function gcpActivityEvents(block: GcpWorkspaceBlock): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const t of block.activity.tasks) {
    const type = String(t.task_type ?? "");
    const status = String(t.status ?? "");
    const phrases = taskPhrases(type);
    out.push({
      id: String(t.task_id),
      run_id: null,
      event_type: `gcp_${type}`,
      title: status === "completed" ? phrases.done
        : status === "failed" ? phrases.failed
        : `${phrases.doing[0]?.toUpperCase() ?? ""}${phrases.doing.slice(1)}`,
      summary: String(t.result_summary ?? t.progress ?? ""),
      status: status === "completed" ? "completed" : status === "failed" ? "failed" : "in_progress",
      agent_key: teammateForTask(type),
      artifact_id: null,
      metadata: { attempts: t.attempts ?? 1, run_count: t.run_count ?? 1 },
      error: t.failure_message ? String(t.failure_message) : null,
      created_at: t.created_at ?? new Date().toISOString(),
      completed_at: t.completed_at ?? null,
    });
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

/** Open platform information requests in the panel's existing question shape. */
export function gcpQuestions(block: GcpWorkspaceBlock): Array<Record<string, unknown>> {
  return block.questions.map((q) => ({
    key: String(q.request_id),
    label: String(q.question ?? ""),
    inputType: q.request_type === "DOCUMENT" ? "textarea"
      : (q.options as unknown[] | undefined)?.length ? "choice" : "textarea",
    choices: ((q.options as Array<string | { value?: unknown; label?: string }> | undefined) ?? [])
      .map((o) => typeof o === "string" ? o : String(o.value ?? o.label ?? "")),
    help: q.request_type === "DOCUMENT"
      ? "This funder asks for a document — upload it in the channel, or describe in words what it would show."
      : undefined,
    reasonNeeded: String(q.rationale ?? "The funder's requirements need this."),
    required: true,
    group: String(q.request_type ?? "INFORMATION"),
    prefill: null,
  }));
}

export async function resolveGcpIdsForRequest(
  deps: Deps,
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<GcpIds> {
  if (!deps.gcp) throw new Error("grant platform not configured");
  return await ensureGcpIds(deps.gcp, client, tenantId, userId);
}

export function invalidateGcpWorkspace(projectId: string): void {
  cache.delete(projectId);
}
