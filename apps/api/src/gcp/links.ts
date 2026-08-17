import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";
import type { GcpGrantPlatform, GcpIds } from "./platform.js";

/**
 * Tenancy mapping between this product and the grant platform.
 *
 * authenticated user → org membership (already verified by the API preHandler
 * and RLS) → gcp_org_links / gcp_user_links → backend organization_id/user_id.
 * All rows are created server-side from RLS-scoped state; nothing here ever
 * accepts a backend id from the client.
 */

export interface ChannelLink {
  id: string;
  channel_id: string;
  gcp_conversation_id: string;
  gcp_application_id: string | null;
  watch_state: Record<string, string>;
  watch_until: string | null;
}

/** Controlled preview: unset = every org may route; else a comma-separated slug list. */
export function orgAllowed(slug: string): boolean {
  const list = (process.env.GCP_GRANTS_ORG_ALLOWLIST ?? "").trim();
  if (!list) return true;
  return list.split(",").map((s) => s.trim()).filter(Boolean).includes(slug);
}

/**
 * Resolve (provisioning on first use) the backend ids for this tenant+user.
 * Provisioning is idempotent on the backend (org keyed on our tenant id, user
 * on email), so a lost link row can always be safely re-created.
 */
export async function ensureGcpIds(
  platform: GcpGrantPlatform,
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<GcpIds> {
  const orgRow = await client.query("SELECT gcp_organization_id FROM gcp_org_links WHERE tenant_id = $1", [tenantId]);
  const userRow = await client.query(
    "SELECT gcp_user_id FROM gcp_user_links WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
  if (orgRow.rows[0] && userRow.rows[0]) {
    return { organizationId: orgRow.rows[0].gcp_organization_id, userId: userRow.rows[0].gcp_user_id };
  }

  const org = await client.query("SELECT name FROM organizations WHERE id = $1", [tenantId]);
  const user = await client.query("SELECT email, display_name FROM users WHERE id = $1", [userId]);
  if (!org.rows[0] || !user.rows[0]) throw new Error("organization or user not found for provisioning");

  const ids = await platform.provision({
    externalOrgRef: tenantId,
    organizationName: org.rows[0].name,
    userEmail: user.rows[0].email,
    userDisplayName: user.rows[0].display_name,
  });

  if (!orgRow.rows[0]) {
    await client.query(
      `INSERT INTO gcp_org_links (id, tenant_id, gcp_organization_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [uuidv7(), tenantId, ids.organizationId]);
  }
  if (!userRow.rows[0]) {
    await client.query(
      `INSERT INTO gcp_user_links (id, tenant_id, user_id, gcp_user_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [uuidv7(), tenantId, userId, ids.userId]);
  }
  return ids;
}

export async function getChannelLink(client: PoolClient, channelId: string): Promise<ChannelLink | null> {
  const { rows } = await client.query(
    `SELECT id, channel_id, gcp_conversation_id, gcp_application_id, watch_state, watch_until
       FROM gcp_channel_conversations WHERE channel_id = $1`, [channelId]);
  return rows[0] ?? null;
}

/** Find the tenant's channel link bound to a given backend application, if any. */
export async function getApplicationChannelLink(
  client: PoolClient,
  applicationId: string
): Promise<ChannelLink | null> {
  const { rows } = await client.query(
    `SELECT id, channel_id, gcp_conversation_id, gcp_application_id, watch_state, watch_until
       FROM gcp_channel_conversations WHERE gcp_application_id = $1
       ORDER BY created_at ASC LIMIT 1`, [applicationId]);
  return rows[0] ?? null;
}

export async function ensureChannelConversation(
  platform: GcpGrantPlatform,
  client: PoolClient,
  tenantId: string,
  channelId: string,
  ids: GcpIds,
  applicationId?: string | null
): Promise<ChannelLink> {
  const existing = await getChannelLink(client, channelId);
  if (existing) return existing;
  const conversationId = await platform.createConversation(ids, applicationId);
  await client.query(
    `INSERT INTO gcp_channel_conversations (id, tenant_id, channel_id, gcp_conversation_id, gcp_application_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (channel_id) DO NOTHING`,
    [uuidv7(), tenantId, channelId, conversationId, applicationId ?? null]);
  return (await getChannelLink(client, channelId))!;
}

export async function bindApplication(client: PoolClient, channelId: string, applicationId: string): Promise<void> {
  await client.query(
    `UPDATE gcp_channel_conversations SET gcp_application_id = $2
      WHERE channel_id = $1 AND gcp_application_id IS DISTINCT FROM $2`,
    [channelId, applicationId]);
}

/** Ask the async bridge to watch this channel's backend tasks for a while. */
export async function watchChannel(client: PoolClient, channelId: string, forMs = 10 * 60 * 1000): Promise<void> {
  await client.query(
    `UPDATE gcp_channel_conversations SET watch_until = now() + ($2 || ' milliseconds')::interval
      WHERE channel_id = $1`,
    [channelId, String(forMs)]);
}

/**
 * Watch a specific document's ingestion. Ingestion runs on the platform's
 * document worker without a conversation binding, so the bridge tracks it via
 * a `doc:<id>` entry in the channel's watch state instead of task activity.
 */
export async function watchDocument(client: PoolClient, channelId: string, documentId: string): Promise<void> {
  await client.query(
    `UPDATE gcp_channel_conversations
        SET watch_state = watch_state || jsonb_build_object('doc:' || $2::text, 'PENDING'),
            watch_until = now() + interval '15 minutes'
      WHERE channel_id = $1`,
    [channelId, documentId]);
}
