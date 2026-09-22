import type { Pool, PoolClient } from "pg";
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";
import type { ConnectionTarget, MessagingChannel } from "@deedwell/connectors";

/**
 * A channel connection is a connector_connections row:
 *   provider            'telegram' | 'whatsapp'
 *   connector_type      'telegram_chat' | 'whatsapp_number'
 *   provider_account_id Telegram chat id | WhatsApp phone number id
 *   sealed token        Telegram: per-connection random secret (unused by the
 *                       API, keeps the NOT NULL contract); WhatsApp: business token
 *   metadata            see ConnectionMeta
 */
export interface NotificationPrefs {
  agent: boolean;      // proactive teammate messages
  tasks: boolean;      // task completed / failed
  approvals: boolean;  // approval requests
  critical: boolean;   // failures needing attention
}
export const DEFAULT_PREFS: NotificationPrefs = { agent: true, tasks: true, approvals: true, critical: true };

export interface ConnectionMeta {
  channelId?: string | null;            // the linked dm channel
  notifications?: Partial<NotificationPrefs>;
  // Telegram
  telegramUserId?: string; username?: string | null; displayName?: string | null;
  // WhatsApp
  wabaId?: string | null; displayPhone?: string | null; verifiedName?: string | null;
  /** Phones allowed to talk to this number's Deedwell, each mapped to a Deedwell user. */
  allowedSenders?: { phone: string; userId: string; label?: string | null }[];
  ownerPhone?: string | null;
  connectMode?: "embedded_signup" | "manual";
  lastActivityAt?: string | null;
  lastInboundAt?: string | null;
  lastError?: string | null;
  health?: Record<string, unknown> | null;
}

export interface ConnectionRow {
  id: string; tenant_id: string; provider: MessagingChannel; connector_type: string;
  provider_account_id: string; provider_account_name: string | null; provider_account_handle: string | null;
  encrypted_access_token: Buffer; access_iv: Buffer; access_tag: Buffer; key_version: number;
  status: "connected" | "needs_attention" | "expired" | "disconnected"; status_detail: string | null;
  metadata: ConnectionMeta; connected_by_user_id: string; created_at: string; updated_at: string;
}

export function prefsOf(meta: ConnectionMeta | null | undefined): NotificationPrefs {
  return { ...DEFAULT_PREFS, ...(meta?.notifications ?? {}) };
}

export function targetOf(row: ConnectionRow, chatId?: string | null): ConnectionTarget {
  const token = row.provider === "whatsapp"
    ? decryptSecret({ ciphertext: row.encrypted_access_token, iv: row.access_iv, tag: row.access_tag, keyVersion: row.key_version }).toString("utf8")
    : null;
  return {
    channel: row.provider,
    chatId: chatId ?? (row.provider === "telegram" ? row.provider_account_id : (row.metadata.ownerPhone ?? "")),
    accountId: row.provider === "whatsapp" ? row.provider_account_id : null,
    accessToken: token,
  };
}

export const sealed = (plaintext: string) => {
  const s = encryptSecret(Buffer.from(plaintext, "utf8"));
  return { ciphertext: s.ciphertext, iv: s.iv, tag: s.tag, keyVersion: s.keyVersion };
};

/** By id, across tenants (worker / webhook), live rows only. */
export async function loadConnection(pool: Pool, id: string): Promise<ConnectionRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM connector_connections WHERE id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'", [id]);
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

/** A user's live channel connections in a tenant (for notifications). */
export async function connectionsForUser(client: PoolClient | Pool, tenantId: string, userId: string): Promise<ConnectionRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM connector_connections
      WHERE tenant_id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'
        AND (connected_by_user_id = $2 OR metadata->'allowedSenders' @> $3::jsonb)`,
    [tenantId, userId, JSON.stringify([{ userId }])]);
  return rows as ConnectionRow[];
}

/** The WhatsApp connection that owns a phone number id, across tenants. */
export async function connectionForPhoneNumberId(pool: Pool, phoneNumberId: string): Promise<ConnectionRow | null> {
  const { rows } = await pool.query(
    "SELECT * FROM connector_connections WHERE provider = 'whatsapp' AND provider_account_id = $1 AND status <> 'disconnected' ORDER BY created_at DESC LIMIT 1",
    [phoneNumberId]);
  return (rows[0] as ConnectionRow | undefined) ?? null;
}

export async function patchConnectionMeta(client: PoolClient | Pool, id: string, patch: Partial<ConnectionMeta>): Promise<void> {
  await client.query("UPDATE connector_connections SET metadata = metadata || $2::jsonb WHERE id = $1", [id, JSON.stringify(patch)]);
}

export async function setConnectionStatus(client: PoolClient | Pool, id: string, status: ConnectionRow["status"], detail: string | null): Promise<void> {
  await client.query("UPDATE connector_connections SET status = $2, status_detail = $3, disconnected_at = CASE WHEN $2 = 'disconnected' THEN now() ELSE disconnected_at END WHERE id = $1", [id, status, detail]);
}

export const CHANNEL_LABEL: Record<MessagingChannel, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };

/**
 * The conversation a connection talks into: a dm channel with the executive
 * assistant, created once and remembered on the connection. `/new` rotates
 * to a fresh one; the old stays visible on the web.
 */
export async function ensureLinkedChannel(client: PoolClient, row: ConnectionRow, opts: { fresh?: boolean } = {}): Promise<{ id: string; key: string; name: string; kind: string; project_id: string | null; agent_key: string | null; project_type: string | null }> {
  if (!opts.fresh && row.metadata.channelId) {
    const { rows } = await client.query("SELECT id, key, name, kind, project_id, agent_key, NULL AS project_type FROM channels WHERE id = $1", [row.metadata.channelId]);
    if (rows[0]) return rows[0];
  }
  const { rows: count } = await client.query("SELECT count(*)::int AS n FROM channels WHERE external_connection_id = $1", [row.id]);
  const n = (count[0]?.n ?? 0) + 1;
  const id = uuidv7();
  const key = `ext:${row.provider}:${row.id}:${n}`;
  const name = n === 1 ? CHANNEL_LABEL[row.provider] : `${CHANNEL_LABEL[row.provider]} · ${n}`;
  await client.query(
    `INSERT INTO channels (id, tenant_id, key, name, kind, agent_key, source, external_connection_id)
     VALUES ($1,$2,$3,$4,'dm','core.executive_assistant',$5,$6)`,
    [id, row.tenant_id, key, name, row.provider, row.id]);
  await patchConnectionMeta(client, row.id, { channelId: id });
  row.metadata.channelId = id;
  return { id, key, name, kind: "dm", project_id: null, agent_key: "core.executive_assistant", project_type: null };
}

/** What the browser may see. Never the token. */
export function connectionView(row: ConnectionRow, extra: Record<string, unknown> = {}) {
  const m = row.metadata ?? {};
  return {
    id: row.id, channel: row.provider, status: row.status, statusDetail: row.status_detail,
    accountName: row.provider_account_name, accountHandle: row.provider_account_handle,
    accountId: row.provider === "whatsapp" ? row.provider_account_id : null,
    displayPhone: m.displayPhone ?? null, verifiedName: m.verifiedName ?? null, wabaId: m.wabaId ?? null,
    connectMode: m.connectMode ?? null,
    channelId: m.channelId ?? null,
    notifications: prefsOf(m),
    allowedSenders: (m.allowedSenders ?? []).map((s) => ({ phone: s.phone, userId: s.userId, label: s.label ?? null })),
    connectedAt: row.created_at, lastActivityAt: m.lastActivityAt ?? null, lastInboundAt: m.lastInboundAt ?? null,
    lastError: m.lastError ?? null, health: m.health ?? null,
    connectedBy: row.connected_by_user_id,
    ...extra,
  };
}
