import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";
import { approvalButtons, taskApprovalButtons, type OutboundButton } from "@deedwell/connectors";
import { connectionsForUser, prefsOf, type ConnectionRow } from "./connections.js";

/**
 * Outbound relay: decides whether a message an agent (or the system) just
 * posted into a channel should also go to a phone, and queues it.
 *
 * Two reasons a message travels:
 *   1. The channel is linked to a connection (a WhatsApp/Telegram
 *      conversation). Everything an agent says there is mirrored — including
 *      the follow-ups workflows post hours later — so the phone always has
 *      the whole conversation.
 *   2. Notifications: a proactive teammate message, a task outcome or an
 *      approval request posted anywhere in the workspace is pushed to the
 *      user's connections when their preferences allow it.
 *
 * Only queued here, inside the caller's transaction; the worker sends after
 * commit, so nothing goes out for a turn that rolls back.
 */
export interface RelayableMessage {
  id: string;
  tenantId: string;
  channelId: string;
  authorKind: "agent" | "system" | "user";
  authorAgent: string | null;
  body: string;
  metadata: Record<string, unknown>;
}

export interface RelayHints {
  /** The user this message is for (proactive/task/approval). Falls back to the channel's owner. */
  userId?: string | null;
  /** Force a notification category regardless of metadata inspection. */
  category?: "agent" | "tasks" | "approvals" | "critical" | null;
  /** Skip the linked-channel mirror (used when the message came FROM this connection's user as a command echo). */
  skipMirror?: boolean;
}

function buttonsFor(m: RelayableMessage): OutboundButton[] | undefined {
  const md = m.metadata ?? {};
  if (Array.isArray(md.buttons)) return (md.buttons as OutboundButton[]).filter((b) => b && typeof b.id === "string" && typeof b.label === "string").slice(0, 3);
  if (typeof md.approvalId === "string") return approvalButtons(md.approvalId);
  if (typeof md.taskId === "string" && (md.taskApproval === true || md.awaitingApproval === true)) return taskApprovalButtons(md.taskId);
  return undefined;
}

function categoryOf(m: RelayableMessage): RelayHints["category"] {
  const md = m.metadata ?? {};
  if (typeof md.approvalId === "string" || md.awaitingApproval === true || md.taskApproval === true) return "approvals";
  if (typeof md.taskQuestion === "string") return "approvals";           // a teammate is blocked on the person
  if (md.proactive === true) return md.notifyExternal === false ? null : "agent";
  if (typeof md.taskId === "string") {
    // Task runner posts: started/delegated are progress, not something to buzz a phone for.
    if (md.taskUpdate === "failed" || md.taskStatus === "failed") return "critical";
    if (md.taskUpdate === "completed" || md.taskUpdate === "done" || md.deliverables !== undefined) return "tasks";
    return null;
  }
  if (md.level === "error" || md.critical === true) return "critical";
  return null;
}

async function queue(client: PoolClient, conn: ConnectionRow, m: RelayableMessage, reason: "mirror" | "notification", chatId: string | null): Promise<void> {
  const buttons = buttonsFor(m);
  const fileId = typeof m.metadata?.fileId === "string" ? m.metadata.fileId : null;
  const images = Array.isArray(m.metadata?.images) ? (m.metadata.images as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 4) : [];
  await client.query(
    `INSERT INTO messaging_events (id, tenant_id, connection_id, channel, direction, kind, external_chat_id, conversation_channel_id, message_id, user_id, status, payload)
     VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,'pending',$10)`,
    [uuidv7(), m.tenantId, conn.id, conn.provider, fileId || images.length ? "document" : "text",
     chatId, m.channelId, m.id, conn.connected_by_user_id,
     JSON.stringify({ text: m.body, buttons: buttons ?? null, fileId, imageFileIds: images, reason, authorAgent: m.authorAgent, category: categoryOf(m) })],
  );
}

const linkCache = new Map<string, { at: number; conn: string | null }>();

/** Call right after a message is inserted, on the same client. Never throws. */
export async function relayMessage(client: PoolClient, m: RelayableMessage, hints: RelayHints = {}): Promise<void> {
  if (m.authorKind === "user") return;
  // A failed statement would abort the caller's transaction even though we
  // catch the JS error, so the relay runs inside its own savepoint.
  let savepoint = false;
  try { await client.query("SAVEPOINT dw_relay"); savepoint = true; } catch { /* not in a transaction — fine */ }
  try {
    await relayBody(client, m, hints);
    if (savepoint) await client.query("RELEASE SAVEPOINT dw_relay");
  } catch (err) {
    if (savepoint) await client.query("ROLLBACK TO SAVEPOINT dw_relay").catch(() => undefined);
    console.warn(JSON.stringify({ at: "messaging_relay_failed", channelId: m.channelId, error: (err as Error).message }));
  }
}

async function relayBody(client: PoolClient, m: RelayableMessage, hints: RelayHints): Promise<void> {
  let linked: string | null;
  const hit = linkCache.get(m.channelId);
  if (hit && Date.now() - hit.at < 60_000) linked = hit.conn;
  else {
    const { rows } = await client.query("SELECT external_connection_id FROM channels WHERE id = $1", [m.channelId]);
    linked = (rows[0]?.external_connection_id as string | null) ?? null;
    linkCache.set(m.channelId, { at: Date.now(), conn: linked });
  }
  const mirrored = new Set<string>();
  if (linked && !hints.skipMirror) {
    const { rows } = await client.query("SELECT * FROM connector_connections WHERE id = $1 AND status <> 'disconnected'", [linked]);
    const conn = rows[0] as ConnectionRow | undefined;
    if (conn) { await queue(client, conn, m, "mirror", null); mirrored.add(conn.id); }
  }
  // 2. Notifications to the user's other connections.
  const category = hints.category ?? categoryOf(m);
  if (!category) return;
  const userId = hints.userId ?? (typeof m.metadata?.userId === "string" ? m.metadata.userId : null) ?? (await ownerOf(client, m.channelId));
  if (!userId) return;
  for (const conn of await connectionsForUser(client, m.tenantId, userId)) {
    if (mirrored.has(conn.id)) continue;
    if (!prefsOf(conn.metadata)[category]) continue;
    await queue(client, conn, { ...m, body: m.body }, "notification", null);
  }
}

/** The most recent human in a channel — who a notification there is for. */
async function ownerOf(client: PoolClient, channelId: string): Promise<string | null> {
  const { rows } = await client.query(
    "SELECT author_user FROM messages WHERE channel_id = $1 AND author_kind = 'user' AND author_user IS NOT NULL ORDER BY created_at DESC LIMIT 1", [channelId]);
  return (rows[0]?.author_user as string | undefined) ?? null;
}

export function forgetLink(channelId: string): void { linkCache.delete(channelId); }
