import type { PoolClient } from "pg";

/**
 * Lightweight presence, from the dashboard's heartbeat plus the user's own
 * messages. Three states, derived rather than stored, so a crashed tab
 * simply ages into OFFLINE.
 */
export type Presence = "ONLINE_ACTIVE" | "ONLINE_IDLE" | "OFFLINE";

export const ACTIVE_WINDOW_MS = 3 * 60_000;
export const IDLE_WINDOW_MS = 15 * 60_000;

export function derivePresence(row: { last_active_at?: Date | string | null; presence?: string | null } | undefined, now = new Date()): Presence {
  const at = row?.last_active_at ? new Date(row.last_active_at).getTime() : 0;
  if (!at) return "OFFLINE";
  const age = now.getTime() - at;
  if (age <= ACTIVE_WINDOW_MS && row?.presence !== "idle") return "ONLINE_ACTIVE";
  if (age <= IDLE_WINDOW_MS) return "ONLINE_IDLE";
  return "OFFLINE";
}

export async function presenceOf(client: PoolClient, tenantId: string, userId: string, now = new Date()): Promise<Presence> {
  const { rows } = await client.query(
    "SELECT last_active_at, presence FROM organization_memberships WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId]
  );
  return derivePresence(rows[0], now);
}

export async function recordHeartbeat(client: PoolClient, tenantId: string, userId: string, state: "active" | "idle" | "offline"): Promise<void> {
  await client.query(
    `UPDATE organization_memberships SET presence = $3, last_active_at = CASE WHEN $3 = 'offline' THEN last_active_at ELSE now() END
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId, state]
  );
}
