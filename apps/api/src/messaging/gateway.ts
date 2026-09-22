import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { audit, tenantFileKey, uuidv7, withContext } from "@deedwell/database";
import {
  buttonToText, mediaAllowed, type InboundMessage, type InboundStatus, type MessagingChannel, type MessagingChannelAdapter, type OutboundMessage, type ParsedWebhook,
} from "@deedwell/connectors";
import type { Deps } from "../bootstrap.js";
import { handleUserMessage, insertMessage } from "../assistant.js";
import { mentionedTeammate } from "../routes-chat.js";
import { TEAMMATES } from "../teammates.js";
import { listTasks } from "../tasks/store.js";
import { adapterFor, APP_ORIGIN } from "./adapters.js";
import {
  CHANNEL_LABEL, connectionView, ensureLinkedChannel, loadConnection, connectionForPhoneNumberId, patchConnectionMeta, sealed, setConnectionStatus, targetOf,
  type ConnectionRow,
} from "./connections.js";
import { forgetLink } from "./relay.js";

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
const noop: Log = { info: () => undefined, warn: () => undefined };

/* =========================================================================
 * Ingest: webhook → identity → queue. Fast, no agent work.
 * ========================================================================= */

const WINDOW_MS = 10 * 60_000;
const WINDOW_LIMIT = 60;          // paired senders
const UNPAIRED_LIMIT = 5;         // unknown senders get a handful of help replies, then silence

interface Identity {
  id: string; channel: MessagingChannel; external_user_id: string; external_chat_id: string | null; display_name: string | null;
  user_id: string | null; active_connection_id: string | null; window_started_at: string | null; window_count: number;
}

async function touchIdentity(pool: Pool, m: InboundMessage): Promise<{ identity: Identity; overLimit: boolean; firstOver: boolean }> {
  const { rows } = await pool.query<Identity>(
    `INSERT INTO messaging_identities (id, channel, external_user_id, external_chat_id, display_name, window_started_at, window_count, last_seen_at)
     VALUES ($1,$2,$3,$4,$5, now(), 1, now())
     ON CONFLICT (channel, external_user_id) DO UPDATE SET
       external_chat_id = EXCLUDED.external_chat_id,
       display_name = COALESCE(EXCLUDED.display_name, messaging_identities.display_name),
       last_seen_at = now(),
       window_started_at = CASE WHEN messaging_identities.window_started_at IS NULL OR messaging_identities.window_started_at < now() - ($6 || ' milliseconds')::interval THEN now() ELSE messaging_identities.window_started_at END,
       window_count = CASE WHEN messaging_identities.window_started_at IS NULL OR messaging_identities.window_started_at < now() - ($6 || ' milliseconds')::interval THEN 1 ELSE messaging_identities.window_count + 1 END
     RETURNING *`,
    [uuidv7(), m.channel, m.externalUserId, m.externalChatId, m.displayName, String(WINDOW_MS)]);
  const identity = rows[0]!;
  const limit = identity.active_connection_id ? WINDOW_LIMIT : UNPAIRED_LIMIT;
  return { identity, overLimit: identity.window_count > limit, firstOver: identity.window_count === limit + 1 };
}

/** Records one message we sent outside a conversation (pairing help, refusals) so it is auditable and metered. */
async function sendSystem(deps: Deps, adapter: MessagingChannelAdapter, conn: ConnectionRow | null, chatId: string, text: string, opts: { tenantId?: string; userId?: string | null; buttons?: OutboundMessage["buttons"]; target?: ReturnType<typeof targetOf> } = {}): Promise<void> {
  const target = opts.target ?? (conn ? targetOf(conn, chatId) : { channel: adapter.channel, chatId, accountId: null, accessToken: null });
  let externalId: string | null = null; let error: string | null = null;
  try { externalId = (await adapter.send(target, { text, buttons: opts.buttons })).externalMessageId; } catch (err) { error = (err as Error).message; }
  const tenantId = opts.tenantId ?? conn?.tenant_id ?? null;
  if (tenantId) {
    await deps.adminPool.query(
      `INSERT INTO messaging_events (id, tenant_id, connection_id, channel, direction, kind, external_message_id, external_chat_id, user_id, status, payload, error, sent_at)
       VALUES ($1,$2,$3,$4,'out','system',$5,$6,$7,$8,$9,$10, CASE WHEN $10::text IS NULL THEN now() ELSE NULL END)`,
      [uuidv7(), tenantId, conn?.id ?? null, adapter.channel, externalId, chatId, opts.userId ?? conn?.connected_by_user_id ?? null, error ? "failed" : "sent", JSON.stringify({ text, buttons: opts.buttons ?? null, reason: "system" }), error]).catch(() => undefined);
    await meter(deps.adminPool, tenantId, adapter.channel, "out", conn?.id ?? null).catch(() => undefined);
  }
}

export async function meter(pool: Pool | PoolClient, tenantId: string, channel: MessagingChannel, direction: "in" | "out", connectionId: string | null): Promise<void> {
  await pool.query(
    "INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'channel_message',1,$3)",
    [uuidv7(), tenantId, JSON.stringify({ source: "messaging", channel, direction, connectionId })]);
}

export async function ingestWebhook(deps: Deps, channel: MessagingChannel, parsed: ParsedWebhook, log: Log = noop): Promise<{ queued: number; handled: number; ignored: number }> {
  const adapter = await adapterFor(deps.appPool, channel);
  const stats = { queued: 0, handled: 0, ignored: 0 };
  for (const s of parsed.statuses) await applyStatus(deps, s).catch((err) => log.warn({ err: (err as Error).message }, "messaging status update failed"));
  for (const m of parsed.messages) {
    try {
      const outcome = await ingestOne(deps, adapter, m, log);
      stats[outcome] += 1;
    } catch (err) {
      stats.ignored += 1;
      log.warn({ channel, externalMessageId: m.externalMessageId, err: (err as Error).message }, "messaging ingest failed");
    }
  }
  return stats;
}

async function ingestOne(deps: Deps, adapter: MessagingChannelAdapter, m: InboundMessage, log: Log): Promise<"queued" | "handled" | "ignored"> {
  // Provider redelivery: the unique index makes the second copy a no-op.
  const dup = await deps.adminPool.query("SELECT 1 FROM messaging_events WHERE channel = $1 AND direction = 'in' AND external_message_id = $2", [m.channel, m.externalMessageId]);
  if (dup.rows[0]) return "ignored";

  const { identity, overLimit, firstOver } = await touchIdentity(deps.adminPool, m);
  if (overLimit) {
    if (firstOver) await sendSystem(deps, adapter, null, m.externalChatId, "You're sending messages faster than I can take them in. Give me a few minutes and try again.", {});
    log.warn({ channel: m.channel, externalUserId: m.externalUserId }, "messaging rate limit");
    return "ignored";
  }

  // Pairing (Telegram): /start <token> minted by a logged-in Deedwell user.
  if (m.channel === "telegram" && m.command?.name === "start") {
    await pairTelegram(deps, adapter, m, identity, log);
    return "handled";
  }

  let conn: ConnectionRow | null = null;
  let userId: string | null = null;
  if (m.channel === "whatsapp") {
    if (!m.accountId) return "ignored";
    conn = await connectionForPhoneNumberId(deps.adminPool, m.accountId);
    if (!conn) { log.warn({ phoneNumberId: m.accountId }, "whatsapp message for an unknown number"); return "ignored"; }
    const sender = (conn.metadata.allowedSenders ?? []).find((s) => s.phone.replace(/\D/g, "") === m.externalUserId.replace(/\D/g, ""));
    if (!sender) {
      await sendSystem(deps, adapter, conn, m.externalChatId, `This WhatsApp number belongs to a Deedwell workspace, and your phone isn't on its list yet. Ask the workspace admin to add ${m.externalUserId} under Connectors → WhatsApp → Manage.`, {});
      await audit(deps.adminPool as never, { tenantId: conn.tenant_id, action: "messaging.refused", entityType: "connector_connection", entityId: conn.id, metadata: { channel: "whatsapp", from: m.externalUserId } }).catch(() => undefined);
      return "handled";
    }
    userId = sender.userId;
    if (identity.user_id !== userId || identity.active_connection_id !== conn.id) {
      await deps.adminPool.query("UPDATE messaging_identities SET user_id = $2, active_connection_id = $3 WHERE id = $1", [identity.id, userId, conn.id]);
    }
  } else {
    if (!identity.active_connection_id || !identity.user_id) {
      await sendSystem(deps, adapter, null, m.externalChatId,
        `Hi! I'm Deedwell. This chat isn't connected to a Deedwell workspace yet.\n\nOpen ${APP_ORIGIN}/dashboard/connectors, choose Telegram → Connect, and tap the button there — it brings you back here signed in.`, {});
      return "handled";
    }
    conn = await loadConnection(deps.adminPool, identity.active_connection_id);
    if (!conn) {
      await deps.adminPool.query("UPDATE messaging_identities SET active_connection_id = NULL, window_count = 0, window_started_at = NULL WHERE id = $1", [identity.id]);
      await sendSystem(deps, adapter, null, m.externalChatId, "That Deedwell connection was removed. Reconnect from Deedwell → Connectors → Telegram when you're ready.", {});
      return "handled";
    }
    userId = identity.user_id;
  }

  await deps.adminPool.query(
    `INSERT INTO messaging_events (id, tenant_id, connection_id, channel, direction, kind, external_message_id, external_user_id, external_chat_id, user_id, status, payload)
     VALUES ($1,$2,$3,$4,'in',$5,$6,$7,$8,$9,'received',$10)
     ON CONFLICT DO NOTHING`,
    [uuidv7(), conn.tenant_id, conn.id, m.channel, m.kind, m.externalMessageId, m.externalUserId, m.externalChatId, userId,
     JSON.stringify({ text: m.text, command: m.command, buttonPayload: m.buttonPayload, media: m.media, replyTo: m.replyToExternalId, displayName: m.displayName, sentAt: m.sentAt, raw: m.raw })]);
  await patchConnectionMeta(deps.adminPool, conn.id, { lastInboundAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  if (m.channel === "whatsapp" && "markRead" in adapter) await (adapter as { markRead: (t: ReturnType<typeof targetOf>, id: string) => Promise<void> }).markRead(targetOf(conn, m.externalChatId), m.externalMessageId).catch(() => undefined);
  if (m.kind === "button" && adapter.acknowledgeButton) await adapter.acknowledgeButton(targetOf(conn, m.externalChatId), m.raw).catch(() => undefined);
  return "queued";
}

async function applyStatus(deps: Deps, s: InboundStatus): Promise<void> {
  // Status callbacks are recorded against the message they belong to; nothing
  // is acted on yet, but every one is logged so delivery can be traced.
  console.log(JSON.stringify({ at: "messaging_status", channel: s.channel, externalMessageId: s.externalMessageId, status: s.status, error: s.error, ...s.raw }));
  const rank: Record<string, number> = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5 };
  const { rows } = await deps.adminPool.query("SELECT id, status FROM messaging_events WHERE channel = $1 AND direction = 'out' AND external_message_id = $2", [s.channel, s.externalMessageId]);
  const row = rows[0];
  if (!row) return;
  if (s.status !== "failed" && (rank[row.status] ?? 0) >= (rank[s.status] ?? 0)) return;
  await deps.adminPool.query("UPDATE messaging_events SET status = $2, error = COALESCE($3, error), result = result || $4::jsonb WHERE id = $1",
    [row.id, s.status, s.error, JSON.stringify({ providerStatus: s.status, at: s.at, ...s.raw })]);
}

/* ---- Telegram pairing ------------------------------------------------------- */

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Mints the single-use token the Connect button embeds in the deep link. */
export async function mintTelegramPairing(client: PoolClient, tenantId: string, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = `${randomBytes(18).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await client.query(
    `INSERT INTO connector_oauth_states (id, tenant_id, provider, state_hash, created_by, expires_at) VALUES ($1,$2,'telegram',$3,$4,$5)`,
    [uuidv7(), tenantId, hashToken(token), userId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

async function pairTelegram(deps: Deps, adapter: MessagingChannelAdapter, m: InboundMessage, identity: Identity, log: Log): Promise<boolean> {
  const token = (m.command?.args ?? "").trim();
  if (!token) {
    if (identity.active_connection_id) { await sendSystem(deps, adapter, null, m.externalChatId, "You're already connected. Just tell me what you need — or /help for ideas.", {}); return true; }
    await sendSystem(deps, adapter, null, m.externalChatId, `To connect this chat, open ${APP_ORIGIN}/dashboard/connectors in Deedwell, choose Telegram → Connect, and tap the button there.`, {});
    return false;
  }
  const { rows } = await deps.adminPool.query(
    `UPDATE connector_oauth_states SET consumed_at = now()
      WHERE state_hash = $1 AND provider = 'telegram' AND consumed_at IS NULL AND expires_at > now()
      RETURNING tenant_id, created_by`,
    [hashToken(token)]);
  const st = rows[0];
  if (!st) {
    await sendSystem(deps, adapter, null, m.externalChatId, "That connection link has expired or was already used. Open Deedwell → Connectors → Telegram and press Connect again for a fresh one.", {});
    return false;
  }
  const secret = sealed(randomBytes(24).toString("hex"));
  const meta = { telegramUserId: m.externalUserId, username: m.raw.username ?? null, displayName: m.displayName, connectMode: "manual", notifications: {}, lastActivityAt: new Date().toISOString() };
  const upsert = await deps.adminPool.query(
    `INSERT INTO connector_connections
       (id, tenant_id, provider, connector_type, provider_account_id, provider_account_name, provider_account_handle,
        encrypted_access_token, access_iv, access_tag, key_version, scopes, status, metadata, connected_by_user_id)
     VALUES ($1,$2,'telegram','telegram_chat',$3,$4,$5,$6,$7,$8,$9,'{}','connected',$10,$11)
     ON CONFLICT (tenant_id, provider, connector_type, provider_account_id) WHERE status <> 'disconnected'
     DO UPDATE SET provider_account_name = EXCLUDED.provider_account_name, provider_account_handle = EXCLUDED.provider_account_handle,
                   metadata = connector_connections.metadata || EXCLUDED.metadata, status = 'connected', status_detail = NULL
     RETURNING *`,
    [uuidv7(), st.tenant_id, m.externalChatId, m.displayName ?? "Telegram", m.raw.username ? `@${m.raw.username}` : null,
     secret.ciphertext, secret.iv, secret.tag, secret.keyVersion, JSON.stringify(meta), st.created_by]);
  const conn = upsert.rows[0] as ConnectionRow;
  await deps.adminPool.query("UPDATE messaging_identities SET user_id = $2, active_connection_id = $3 WHERE id = $1", [identity.id, st.created_by, conn.id]);
  await withContext(deps.appPool, { tenantId: st.tenant_id, userId: st.created_by }, async (client) => {
    await ensureLinkedChannel(client, conn);
    await audit(client, { tenantId: st.tenant_id, actorUser: st.created_by, action: "messaging.connected", entityType: "connector_connection", entityId: conn.id, metadata: { channel: "telegram" } });
  });
  const org = await deps.adminPool.query("SELECT name FROM organizations WHERE id = $1", [st.tenant_id]);
  await sendSystem(deps, adapter, conn, m.externalChatId,
    `Connected to ${org.rows[0]?.name ?? "your Deedwell workspace"}. 🎉\n\nYou can now message your AI team here just like in Deedwell — ask for research, content, website changes, tasks, or a status update. Try:\n• "What does my team need to get done today?"\n• "Research our three biggest competitors"\n• "Update the hero text on my website"\n\n/help lists the shortcuts.`, {});
  log.info({ tenantId: st.tenant_id, connectionId: conn.id }, "telegram paired");
  return true;
}

/* =========================================================================
 * Processing: queued event → the agent runtime, under the tenant.
 * ========================================================================= */

interface EventRow {
  id: string; tenant_id: string; connection_id: string | null; channel: MessagingChannel; direction: "in" | "out"; kind: string;
  external_message_id: string | null; external_user_id: string | null; external_chat_id: string | null; user_id: string | null;
  status: string; payload: Record<string, unknown>; attempts: number; message_id: string | null;
}

export async function processInboundEvent(deps: Deps, ev: EventRow, log: Log = noop): Promise<void> {
  const conn = ev.connection_id ? await loadConnection(deps.adminPool, ev.connection_id) : null;
  if (!conn || !ev.user_id) {
    await deps.adminPool.query("UPDATE messaging_events SET status = 'skipped', error = 'connection or user no longer exists', processed_at = now() WHERE id = $1", [ev.id]);
    return;
  }
  const adapter = await adapterFor(deps.appPool, conn.provider);
  const target = targetOf(conn, ev.external_chat_id);
  const payload = ev.payload as { text?: string | null; command?: { name: string; args: string } | null; buttonPayload?: string | null; media?: { providerRef: string; mime: string | null; filename: string | null; sizeBytes: number | null; caption: string | null } | null; replyTo?: string | null; displayName?: string | null; raw?: Record<string, unknown> };
  const ids = { tenantId: conn.tenant_id, userId: ev.user_id };

  const result = await withContext(deps.appPool, ids, async (client) => {
    const channel = await ensureLinkedChannel(client, conn);
    const reply = async (text: string, buttons?: OutboundMessage["buttons"]) => {
      const msg = await insertMessage(client, { tenantId: ids.tenantId, channelId: channel.id, authorKind: "system", body: text, metadata: { via: conn.provider, system: true, ...(buttons ? { buttons } : {}) } });
      // insertMessage relays into the linked conversation; buttons ride along in metadata.
      return msg.id as string;
    };

    // Slash commands.
    if (ev.kind === "command" && payload.command) {
      const handled = await runCommand(deps, client, { conn, ids, channel, command: payload.command, reply });
      if (handled) return { kind: "command", command: payload.command.name };
    }

    // Buttons become the plain words the runtime already understands.
    let body = (payload.text ?? "").trim();
    if (ev.kind === "button" && payload.buttonPayload) {
      const mapped = buttonToText(payload.buttonPayload);
      if (!mapped) return { kind: "button", ignored: true };
      if (mapped.openUrl) { await reply(`Open it in Deedwell: ${APP_ORIGIN}${mapped.openUrl}`); return { kind: "button", opened: mapped.openUrl }; }
      body = mapped.text;
    }

    // Media → the existing files pipeline, then handed to the runtime as an attachment.
    let fileId: string | null = null;
    if (payload.media) {
      const gate = mediaAllowed(payload.media.mime, payload.media.sizeBytes);
      if (!gate.ok) { await reply(gate.reason!); return { kind: "media", rejected: gate.reason }; }
      const dl = await adapter.downloadMedia(target, payload.media);
      const gate2 = mediaAllowed(dl.mime ?? payload.media.mime, dl.bytes.length);
      if (!gate2.ok) { await reply(gate2.reason!); return { kind: "media", rejected: gate2.reason }; }
      fileId = await storeInboundFile(deps, client, ids, channel, { bytes: dl.bytes, mime: (dl.mime ?? payload.media.mime ?? "application/octet-stream").split(";")[0]!.trim(), filename: dl.filename ?? payload.media.filename ?? "attachment", via: conn.provider });
      if (!body) body = payload.media.caption?.trim() || (ev.kind === "audio" ? "(voice note)" : ev.kind === "image" ? "(image)" : `(file: ${dl.filename ?? "attachment"})`);
    }
    if (!body) { await reply("I can read text, images, PDFs, documents and voice notes here — that one I couldn't."); return { kind: ev.kind, ignored: true }; }

    const mentioned = mentionedTeammate(body);
    const messages = await handleUserMessage(deps, client, ids, channel as never, body, fileId, `ext:${ev.id}`, null, mentioned, null, null);
    await meter(client, ids.tenantId, conn.provider, "in", conn.id);
    await audit(client, {
      tenantId: ids.tenantId, actorUser: ids.userId, action: "messaging.inbound", entityType: "channel", entityId: channel.id,
      metadata: { channel: conn.provider, externalMessageId: ev.external_message_id, kind: ev.kind, attachment: Boolean(fileId), replies: messages.filter((x) => x.author_kind === "agent").length, mentioned },
    });
    return { kind: ev.kind, channelId: channel.id, messageIds: messages.map((x) => x.id), fileId };
  });

  await deps.adminPool.query("UPDATE messaging_events SET status = 'processed', processed_at = now(), conversation_channel_id = $2, message_id = $3, result = $4::jsonb WHERE id = $1",
    [ev.id, (result as { channelId?: string }).channelId ?? conn.metadata.channelId ?? null, (result as { messageIds?: string[] }).messageIds?.[0] ?? null, JSON.stringify(result)]);
  deps.engine.events.emit("event", { type: "message_created", tenantId: conn.tenant_id, channelId: (result as { channelId?: string }).channelId ?? conn.metadata.channelId, authorUser: ev.user_id, external: conn.provider } as never);
  await flushOutbound(deps, conn.id, log);
}

async function storeInboundFile(deps: Deps, client: PoolClient, ids: { tenantId: string; userId: string }, channel: { id: string; project_id: string | null }, file: { bytes: Buffer; mime: string; filename: string; via: string }): Promise<string> {
  let projectId = channel.project_id;
  if (!projectId) {
    const shared = await client.query("SELECT id FROM projects WHERE name = 'Shared Files' LIMIT 1");
    projectId = shared.rows[0]?.id ?? uuidv7();
    if (!shared.rows[0]) await client.query("INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'Shared Files','other',$3)", [projectId, ids.tenantId, ids.userId]);
  }
  const fileId = uuidv7();
  const safeName = file.filename.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "attachment";
  const storageKey = tenantFileKey(ids.tenantId, fileId, safeName);
  await deps.storage.put(storageKey, file.bytes);
  await client.query(
    `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [fileId, ids.tenantId, projectId, safeName, file.mime, file.bytes.length, createHash("sha256").update(file.bytes).digest("hex"), storageKey, ids.userId]);
  await audit(client, { tenantId: ids.tenantId, actorUser: ids.userId, action: "file.uploaded", entityType: "file", entityId: fileId, metadata: { filename: safeName, via: file.via } });
  return fileId;
}

/* ---- commands ----------------------------------------------------------------- */

const HELP = `Here's what I can do from here:

Just talk to me — "research our competitors", "write three Instagram posts about the food drive", "update my website's hero text", "create a task every Friday to send me the marketing report". Say "approve" or "reject" when I ask.

Shortcuts:
/status — what the team is working on
/tasks — open tasks
/agents — your teammates (address one with @Name)
/workspace — switch organization
/new — start a fresh conversation
/help — this list`;

async function runCommand(deps: Deps, client: PoolClient, args: { conn: ConnectionRow; ids: { tenantId: string; userId: string }; channel: { id: string }; command: { name: string; args: string }; reply: (t: string, b?: OutboundMessage["buttons"]) => Promise<string> }): Promise<boolean> {
  const { conn, ids, command, reply } = args;
  switch (command.name) {
    case "help": await reply(HELP); return true;
    case "agents": {
      await reply("Your Deedwell team:\n" + TEAMMATES.map((t) => `• ${t.name} — ${t.role} (@${t.name})`).join("\n") + "\n\nAddress one directly with @Name, or just ask and I'll route it.");
      return true;
    }
    case "tasks": {
      const tasks = await listTasks(client, ids.tenantId, { status: ["queued", "in_progress", "waiting_approval", "blocked"] });
      if (!tasks.length) { await reply(`No open tasks. Ask me to create one — "remind me every Monday to review donations".`); return true; }
      const lines = tasks.slice(0, 10).map((t) => `• ${t.title} — ${String(t.status).replace(/_/g, " ")}${t.agentName ? ` (${t.agentName})` : ""}${t.nextRunAt ? ` · next ${new Date(t.nextRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}`);
      await reply(`Open tasks (${tasks.length}):\n${lines.join("\n")}${tasks.length > 10 ? `\n…and ${tasks.length - 10} more in Deedwell.` : ""}\n${APP_ORIGIN}/dashboard/tasks`);
      return true;
    }
    case "new": {
      const fresh = await ensureLinkedChannel(client, conn, { fresh: true });
      forgetLink(fresh.id);
      await insertMessage(client, { tenantId: ids.tenantId, channelId: fresh.id, authorKind: "system", body: "Fresh conversation started. Earlier ones stay in Deedwell.", metadata: { via: conn.provider, system: true } });
      return true;
    }
    case "workspace": {
      const mine = await deps.adminPool.query(
        `SELECT c.id, o.name, c.tenant_id FROM connector_connections c JOIN organizations o ON o.id = c.tenant_id
          WHERE c.provider = $1 AND c.status <> 'disconnected' AND (c.connected_by_user_id = $2 OR c.metadata->'allowedSenders' @> $3::jsonb)
            AND ($1 <> 'telegram' OR c.provider_account_id = $4)
          ORDER BY o.name`,
        [conn.provider, ids.userId, JSON.stringify([{ userId: ids.userId }]), conn.provider_account_id]);
      const list = mine.rows as { id: string; name: string; tenant_id: string }[];
      const pick = command.args.trim();
      if (pick) {
        const idx = Number(pick) - 1;
        const chosen = list[idx] ?? list.find((w) => w.name.toLowerCase() === pick.toLowerCase());
        if (!chosen) { await reply(`I don't see that workspace. Reply /workspace to list them.`); return true; }
        await deps.adminPool.query("UPDATE messaging_identities SET active_connection_id = $3 WHERE channel = $1 AND user_id = $2", [conn.provider, ids.userId, chosen.id]);
        await reply(`Switched to ${chosen.name}. Messages here now go to that workspace.`);
        return true;
      }
      if (list.length <= 1) { await reply(`You're connected to ${list[0]?.name ?? "one workspace"} here. To use another organization from this chat, connect it from that workspace's Connectors page.`); return true; }
      await reply(`Your workspaces:\n${list.map((w, i) => `${i + 1}. ${w.name}${w.id === conn.id ? " ← active" : ""}`).join("\n")}\n\nReply /workspace <number> to switch.`);
      return true;
    }
    case "status": return false; // the runtime's own "status" intent answers this
    case "start": await reply("You're already connected. Tell me what you need, or /help."); return true;
    default: return false;
  }
}

/* =========================================================================
 * Outbound: pending events → provider.
 * ========================================================================= */

const MAX_ATTEMPTS = 5;

export async function flushOutbound(deps: Deps, connectionId: string | null, log: Log = noop, limit = 25): Promise<number> {
  const { rows } = await deps.adminPool.query<EventRow & { created_at: string }>(
    `UPDATE messaging_events SET status = 'sending', claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM messaging_events
         WHERE direction = 'out' AND status = 'pending' AND ($1::uuid IS NULL OR connection_id = $1)
           AND (claimed_at IS NULL OR claimed_at < now() - (least(attempts, 6) * interval '30 seconds'))
         ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [connectionId, limit]);
  let sent = 0;
  for (const ev of rows) {
    try {
      await sendOne(deps, ev);
      sent += 1;
    } catch (err) {
      const e = err as Error & { outsideWindow?: boolean; rateLimited?: boolean; code?: number };
      const terminal = e.outsideWindow || ev.attempts >= MAX_ATTEMPTS || (e.code !== undefined && e.code >= 400 && e.code < 500 && !e.rateLimited);
      await deps.adminPool.query("UPDATE messaging_events SET status = $2, error = $3 WHERE id = $1", [ev.id, terminal ? "failed" : "pending", e.message.slice(0, 300)]);
      if (ev.connection_id) await patchConnectionMeta(deps.adminPool, ev.connection_id, { lastError: `${new Date().toISOString()} ${e.message.slice(0, 160)}` }).catch(() => undefined);
      if (e.outsideWindow && ev.connection_id) await noteWindowClosed(deps, ev).catch(() => undefined);
      log.warn({ eventId: ev.id, channel: ev.channel, terminal, err: e.message }, "messaging send failed");
    }
  }
  return sent;
}

async function sendOne(deps: Deps, ev: EventRow): Promise<void> {
  const conn = ev.connection_id ? await loadConnection(deps.adminPool, ev.connection_id) : null;
  if (!conn) { await deps.adminPool.query("UPDATE messaging_events SET status = 'skipped', error = 'connection gone' WHERE id = $1", [ev.id]); return; }
  const adapter = await adapterFor(deps.appPool, conn.provider);
  const target = targetOf(conn, ev.external_chat_id);
  const p = ev.payload as { text?: string; buttons?: OutboundMessage["buttons"] | null; fileId?: string | null; imageFileIds?: string[]; reason?: string; authorAgent?: string | null };
  const out: OutboundMessage = { text: p.text ?? "", buttons: p.buttons ?? undefined };
  const fileId = p.fileId ?? p.imageFileIds?.[0] ?? null;
  if (fileId) {
    const { rows } = await deps.adminPool.query("SELECT filename, mime, storage_key, size_bytes FROM files WHERE id = $1 AND tenant_id = $2", [fileId, ev.tenant_id]);
    const f = rows[0];
    if (f && Number(f.size_bytes) <= 15_000_000) {
      const bytes = await deps.storage.get(f.storage_key).catch(() => null);
      if (bytes) out.media = { bytes, mime: f.mime, filename: f.filename, caption: undefined };
    }
  }
  // Agent messages that are just a link to something ("Open the artifact panel") still read fine as text.
  const res = await adapter.send(target, out);
  await deps.adminPool.query("UPDATE messaging_events SET status = 'sent', sent_at = now(), external_message_id = $2, error = NULL WHERE id = $1", [ev.id, res.externalMessageId]);
  await meter(deps.adminPool, ev.tenant_id, conn.provider, "out", conn.id);
  await patchConnectionMeta(deps.adminPool, conn.id, { lastActivityAt: new Date().toISOString(), lastError: null });
}

/** WhatsApp closed its 24-hour window: tell the person on the web, once per closure. */
async function noteWindowClosed(deps: Deps, ev: EventRow): Promise<void> {
  const conn = await loadConnection(deps.adminPool, ev.connection_id!);
  if (!conn?.metadata.channelId) return;
  await withContext(deps.appPool, { tenantId: conn.tenant_id, userId: conn.connected_by_user_id }, async (client) => {
    const recent = await client.query("SELECT 1 FROM messages WHERE channel_id = $1 AND metadata->>'windowClosed' = 'true' AND created_at > now() - interval '12 hours' LIMIT 1", [conn.metadata.channelId]);
    if (recent.rows[0]) return;
    await client.query(
      `INSERT INTO messages (id, tenant_id, channel_id, author_kind, body, metadata) VALUES ($1,$2,$3,'system',$4,$5)`,
      [uuidv7(), conn.tenant_id, conn.metadata.channelId,
       "WhatsApp only lets Deedwell reply within 24 hours of your last message there. The latest replies are here; send any message on WhatsApp to reopen the window.",
       JSON.stringify({ via: "whatsapp", system: true, windowClosed: true })]);
  });
}

/* =========================================================================
 * Worker
 * ========================================================================= */

export function startMessagingWorker(deps: Deps, opts: { log?: Log; everyMs?: number } = {}): () => void {
  const everyMs = opts.everyMs ?? Number(process.env.MESSAGING_POLL_MS ?? 3000);
  const log = opts.log ?? noop;
  let stopped = false; let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      // Stuck processing (a crash mid-turn) goes back to the queue.
      await deps.adminPool.query("UPDATE messaging_events SET status = 'received' WHERE direction = 'in' AND status = 'processing' AND claimed_at < now() - interval '5 minutes' AND attempts < 3");
      const { rows } = await deps.adminPool.query<EventRow>(
        `UPDATE messaging_events SET status = 'processing', claimed_at = now(), attempts = attempts + 1
          WHERE id IN (SELECT id FROM messaging_events WHERE direction = 'in' AND status = 'received' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
          RETURNING *`);
      for (const ev of rows) {
        if (stopped) break;
        try { await processInboundEvent(deps, ev, log); }
        catch (err) {
          const msg = (err as Error).message;
          log.warn({ eventId: ev.id, err: msg }, "messaging inbound failed");
          const giveUp = ev.attempts >= 3;
          await deps.adminPool.query("UPDATE messaging_events SET status = $2, error = $3, processed_at = CASE WHEN $2 = 'failed' THEN now() ELSE processed_at END WHERE id = $1", [ev.id, giveUp ? "failed" : "received", msg.slice(0, 300)]);
          if (giveUp && ev.connection_id) {
            const conn = await loadConnection(deps.adminPool, ev.connection_id);
            if (conn) {
              const adapter = await adapterFor(deps.appPool, conn.provider);
              await sendSystem(deps, adapter, conn, ev.external_chat_id ?? "", "I couldn't complete that. I've logged the issue — you can try again, or open Deedwell for details.", { userId: ev.user_id });
            }
          }
        }
      }
      await flushOutbound(deps, null, log);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "messaging worker tick failed");
    } finally { busy = false; }
  };
  const first = setTimeout(() => { void tick(); }, 4000);
  const timer = setInterval(() => { void tick(); }, everyMs);
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}

/* ---- helpers used by routes ---------------------------------------------------- */

export async function testConnection(deps: Deps, conn: ConnectionRow, userId: string): Promise<{ ok: boolean; detail: string | null }> {
  const adapter = await adapterFor(deps.appPool, conn.provider);
  const chatId = conn.provider === "telegram" ? conn.provider_account_id : (conn.metadata.allowedSenders?.find((s) => s.userId === userId)?.phone ?? conn.metadata.ownerPhone ?? null);
  if (!chatId) return { ok: false, detail: "Add your phone number to the allowed senders first." };
  try {
    await sendSystem(deps, adapter, conn, chatId, "Deedwell is connected. You can now message your AI team here.", { userId });
    const failed = await deps.adminPool.query("SELECT error FROM messaging_events WHERE connection_id = $1 AND direction = 'out' AND kind = 'system' ORDER BY created_at DESC LIMIT 1", [conn.id]);
    const err = failed.rows[0]?.error as string | null;
    if (err) return { ok: false, detail: /131047|131026|re-engagement|24 hours/i.test(err) ? "WhatsApp only lets us message you within 24 hours of your last message. Send any message to the business number first, then test again." : err };
    return { ok: true, detail: null };
  } catch (err) { return { ok: false, detail: (err as Error).message }; }
}

export async function healthOf(deps: Deps, conn: ConnectionRow): Promise<Record<string, unknown>> {
  const adapter = await adapterFor(deps.appPool, conn.provider);
  const h = await adapter.health(conn.provider === "whatsapp" ? targetOf(conn) : null).catch((err) => ({ ok: false, detail: (err as Error).message, facts: {} }));
  await patchConnectionMeta(deps.adminPool, conn.id, { health: { ...h, checkedAt: new Date().toISOString() } });
  if (!h.ok && conn.status === "connected") await setConnectionStatus(deps.adminPool, conn.id, "needs_attention", h.detail).catch(() => undefined);
  if (h.ok && conn.status === "needs_attention") await setConnectionStatus(deps.adminPool, conn.id, "connected", null).catch(() => undefined);
  return h as unknown as Record<string, unknown>;
}

export { connectionView, CHANNEL_LABEL };
export const signPayload = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("hex");
