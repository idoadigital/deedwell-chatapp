import { withContext } from "@deedwell/database";
import type { Deps } from "../bootstrap.js";
import { insertMessage } from "../assistant.js";
import { taskPhrases, teammateForTask } from "./teammate-map.js";

/**
 * Async bridge: platform work that outlives the chat request becomes teammate
 * messages, the same way local workflow milestones already do.
 *
 * Watched channels (any routed channel that recently started platform work)
 * are polled for task state; a task reaching a terminal state is announced
 * once — watch_state persists which announcements were made, so a restarting
 * server never re-posts old milestones and a refreshing browser simply
 * re-reads the messages table. Durability lives in the platform and in
 * Postgres; nothing here depends on a long-lived browser connection.
 */

const POLL_MS = 5_000;
const TERMINAL = new Set(["completed", "failed"]);

let timer: NodeJS.Timeout | null = null;
let polling = false;

export function startGcpBridge(deps: Deps): void {
  if (timer) return;
  timer = setInterval(() => { void poll(deps); }, POLL_MS);
  timer.unref?.();
}

export function stopGcpBridge(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** One poll pass. Exported so tests can drive the bridge deterministically. */
export async function poll(deps: Deps): Promise<void> {
  if (polling || !deps.gcp) return;
  polling = true;
  try {
    // Cross-tenant enumeration uses the admin pool — the same pattern as the
    // workflow worker's run claiming. All per-tenant writes happen under RLS.
    const { rows } = await deps.adminPool.query(
      `SELECT c.tenant_id, c.channel_id, c.gcp_conversation_id, c.gcp_application_id, c.watch_state,
              o.gcp_organization_id,
              (SELECT u.gcp_user_id FROM gcp_user_links u WHERE u.tenant_id = c.tenant_id LIMIT 1) AS gcp_user_id
         FROM gcp_channel_conversations c
         JOIN gcp_org_links o ON o.tenant_id = c.tenant_id
        WHERE c.watch_until IS NOT NULL AND c.watch_until > now()`);
    for (const row of rows) {
      try {
        await pollChannel(deps, row);
      } catch (err) {
        console.log(JSON.stringify({
          at: "gcp_bridge_poll_failed", channelId: row.channel_id,
          error: String(err instanceof Error ? err.message : err).slice(0, 200),
        }));
      }
    }
  } finally {
    polling = false;
  }
}

interface WatchRow {
  tenant_id: string;
  channel_id: string;
  gcp_conversation_id: string;
  gcp_application_id: string | null;
  watch_state: Record<string, string>;
  gcp_organization_id: string;
  gcp_user_id: string | null;
}

async function pollChannel(deps: Deps, row: WatchRow): Promise<void> {
  const platform = deps.gcp!;
  const ids = { organizationId: row.gcp_organization_id, userId: row.gcp_user_id ?? row.gcp_organization_id };
  const activity = await platform.activity(row.gcp_conversation_id, ids);
  const tasks = (activity.tasks ?? []) as Array<Record<string, unknown>>;
  const counts = (activity.counts ?? {}) as { running?: number };

  const seen: Record<string, string> = { ...(row.watch_state ?? {}) };
  const announce: Array<{ taskId: string; taskType: string; status: string; task: Record<string, unknown> }> = [];

  // Documents being ingested (doc:<id> entries): ingestion runs on the
  // document worker without a conversation, so it is watched directly.
  let docsPending = 0;
  for (const key of Object.keys(seen)) {
    if (!key.startsWith("doc:")) continue;
    if (["COMPLETE", "FAILED", "QUARANTINED"].includes(seen[key]!)) continue;
    const documentId = key.slice(4);
    const doc = await platform.getDocument(documentId, ids).catch(() => null);
    const st = String(doc?.ingestion_status ?? "");
    if (!["COMPLETE", "FAILED", "QUARANTINED"].includes(st)) { docsPending += 1; continue; }
    seen[key] = st;
    const filename = String(doc?.original_filename ?? "the document");
    let body: string;
    if (st === "COMPLETE") {
      const ev = await platform.evidence(ids, { documentId, limit: 200 }).catch(() => null);
      const facts = Number(ev?.count ?? 0);
      const kind = String(doc?.document_type ?? "").replace(/_/g, " ").toLowerCase();
      body = `**${filename}** is in the Evidence Library${kind && kind !== "unclassified" ? ` (classified as ${kind})` : ""} — ${facts} fact${facts === 1 ? "" : "s"} extracted, each with its source location. Every application can now draw on it; ask me to show the evidence any time.`;
    } else {
      body = `I couldn't finish processing **${filename}** (${String(doc?.failure_code ?? st).toLowerCase()}). The rest of the Evidence Library is unaffected — please try another copy.`;
    }
    announce.push({ taskId: key, taskType: "document_ingestion", status: st === "COMPLETE" ? "completed" : "failed",
      task: { result_summary: "", failure_message: null, attempts: 1, __body: body } });
  }

  for (const t of tasks) {
    const taskId = String(t.task_id);
    const status = String(t.status ?? "");
    const prev = seen[taskId];
    if (prev === status) continue;
    // First sight of a task that finished long ago is history, not news —
    // record it silently so backlogs are never re-announced into the chat.
    if (prev === undefined && TERMINAL.has(status)) {
      const createdAt = t.created_at ? Date.parse(String(t.created_at)) : 0;
      if (Date.now() - createdAt > 15 * 60 * 1000) { seen[taskId] = status; continue; }
    }
    seen[taskId] = status;
    if (TERMINAL.has(status)) {
      announce.push({ taskId, taskType: String(t.task_type ?? ""), status, task: t });
    }
  }

  const running = counts.running ?? 0;

  await withContext(deps.appPool, { tenantId: row.tenant_id, userId: null }, async (client) => {
    for (const a of announce) {
      const phrases = taskPhrases(a.taskType);
      const author = teammateForTask(a.taskType);
      const summary = a.task.result_summary ? ` ${String(a.task.result_summary)}` : "";
      const attempts = Number(a.task.attempts ?? 1);
      const retryNote = attempts > 1 ? ` (succeeded on attempt ${attempts} after an automatic retry)` : "";
      const body = typeof a.task.__body === "string" ? a.task.__body
        : a.status === "completed"
        ? `${phrases.done}${retryNote}.${summary}`.trim()
        : `${phrases.failed}: ${String(a.task.failure_message ?? a.task.failure_code ?? "the platform reported a failure")}. Nothing else in the workspace is affected — you can ask me to try again.`;
      await insertMessage(client, {
        tenantId: row.tenant_id, channelId: row.channel_id, authorKind: "agent",
        authorAgent: author, body,
        metadata: {
          gcpTaskId: a.taskId, gcpTaskType: a.taskType, gcpTaskStatus: a.status,
          ...(row.gcp_application_id ? { openWorkspace: true } : {}),
        },
      });
    }
    await client.query(
      `UPDATE gcp_channel_conversations
          SET watch_state = $2::jsonb,
              watch_until = CASE WHEN $3::int > 0 THEN watch_until ELSE now() + interval '15 seconds' END
        WHERE channel_id = $1`,
      [row.channel_id, JSON.stringify(seen), running + docsPending]);
  });

  if (announce.length) {
    for (const a of announce) {
      console.log(JSON.stringify({ at: "gcp_bridge_announced", channelId: row.channel_id, taskId: a.taskId, status: a.status }));
    }
    deps.engine.events.emit("event", {
      type: "message_created", tenantId: row.tenant_id, channelId: row.channel_id,
    });
  }
}
