/** Account rows, their public view, and the activity log every action writes. */
import { audit, uuidv7 } from "@deedwell/database";
import { formatCustomerId } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";

export type AccountRow = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadAccount(client: PoolClient, tenantId: string): Promise<AccountRow | null> {
  const { rows } = await client.query(
    `SELECT * FROM google_ads_accounts WHERE tenant_id = $1 AND status <> 'disconnected' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  return rows[0] ?? null;
}

export async function loadAccountById(client: PoolClient, tenantId: string, id: string): Promise<AccountRow | null> {
  const { rows } = await client.query(`SELECT * FROM google_ads_accounts WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0] ?? null;
}

export function accountView(row: AccountRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: formatCustomerId(row.customer_id),
    customerIdRaw: row.customer_id,
    name: row.descriptive_name ?? null,
    currencyCode: row.currency_code ?? null,
    timeZone: row.time_zone ?? null,
    isManager: Boolean(row.is_manager),
    isTestAccount: Boolean(row.is_test_account),
    accountKind: row.account_kind ?? "unknown",
    status: row.status,
    statusDetail: row.status_detail ?? null,
    managerLinkStatus: row.manager_link_status ?? "unknown",
    connectedAt: row.connected_at ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastSyncError: row.last_sync_error ?? null,
  };
}

export async function setAccountStatus(
  client: PoolClient, id: string, status: string, detail: string | null = null, extra: Record<string, unknown> = {},
): Promise<void> {
  const sets = ["status = $2", "status_detail = $3"];
  const params: unknown[] = [id, status, detail];
  for (const [key, value] of Object.entries(extra)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  await client.query(`UPDATE google_ads_accounts SET ${sets.join(", ")} WHERE id = $1`, params);
}

export interface ActivityInput {
  tenantId: string;
  accountId?: string | null;
  customerId?: string | null;
  actorUserId?: string | null;
  actorKind?: "user" | "admin" | "system" | "ai";
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  previousState?: string | null;
  newState?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

/** One human-readable row in google_ads_activity plus the tenant's
 *  hash-chained audit trail. */
export async function logActivity(client: PoolClient, input: ActivityInput): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO google_ads_activity (id, tenant_id, account_id, customer_id, actor_user_id, actor_kind, action, entity_type, entity_id,
                                      previous_state, new_state, summary, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.tenantId, input.accountId ?? null, input.customerId ?? null, input.actorUserId ?? null, input.actorKind ?? "user",
      input.action, input.entityType ?? null, input.entityId ?? null, input.previousState ?? null, input.newState ?? null,
      input.summary ?? null, JSON.stringify(input.metadata ?? {})],
  );
  // audit_events.entity_id is a uuid; Google's own ids (customer ids,
  // resource names) travel in the metadata instead.
  const entityId = input.entityId && UUID.test(input.entityId) ? input.entityId : input.accountId ?? null;
  await audit(client, {
    tenantId: input.tenantId, actorUser: input.actorUserId ?? null, actorAgent: input.actorKind === "ai" ? "google_ads.ai" : null,
    action: `google_ads.${input.action}`, entityType: input.entityType ?? "google_ads_account", entityId,
    metadata: { customerId: input.customerId ?? null, googleEntityId: input.entityId ?? null, previousState: input.previousState ?? null, newState: input.newState ?? null },
  });
  return id;
}

export function emitOrgEvent(deps: Deps, tenantId: string, type: string, extra: Record<string, unknown> = {}): void {
  try {
    deps.engine.events.emit("event", { type, tenantId, ...extra } as never);
  } catch { /* SSE is best-effort */ }
}

export async function listActivity(client: PoolClient, tenantId: string, opts: { limit?: number; accountId?: string | null } = {}) {
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS actor_name, u.email AS actor_email
       FROM google_ads_activity a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.tenant_id = $1 AND ($2::uuid IS NULL OR a.account_id = $2)
      ORDER BY a.created_at DESC LIMIT $3`,
    [tenantId, opts.accountId ?? null, opts.limit ?? 100]);
  return rows.map((r) => ({
    id: r.id, action: r.action, actorKind: r.actor_kind, actor: r.actor_name ?? r.actor_email ?? null,
    entityType: r.entity_type, entityId: r.entity_id, previousState: r.previous_state, newState: r.new_state,
    summary: r.summary, metadata: r.metadata ?? {}, createdAt: r.created_at,
  }));
}
