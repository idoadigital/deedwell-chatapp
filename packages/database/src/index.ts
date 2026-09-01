import { Pool, type PoolClient } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "@deedwell/observability";

export type { PoolClient } from "pg";
export { LocalFsStorage, GcsStorage, tenantFileKey, type StorageAdapter } from "./storage.js";

// ---------------------------------------------------------------------------
// Identifiers — UUIDv7-style time-ordered UUIDs, generated app-side.
// ---------------------------------------------------------------------------

export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number(ts >> 16n), 0, 4);
  bytes.writeUIntBE(Number(ts & 0xffffn), 4, 2);
  randomBytes(10).copy(bytes, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/** Admin pool: migrations and the workflow worker's cross-tenant run claiming ONLY. */
export function createAdminPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new Pool({ connectionString: url, max: 5 });
}

/** App pool: the RLS-bound role every request and every workflow step runs under. */
export function createAppPool(url = process.env.DATABASE_APP_URL): Pool {
  if (!url) throw new Error("DATABASE_APP_URL is not set");
  return new Pool({ connectionString: url, max: 10 });
}

// ---------------------------------------------------------------------------
// Tenant-scoped execution — the only sanctioned way to touch tenant data.
// ---------------------------------------------------------------------------

export interface TenantContext {
  tenantId: string | null;
  userId: string | null;
}

export async function withContext<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
      ctx.tenantId ?? "",
      ctx.userId ?? "",
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Runs as the admin role. Bootstraps the RLS-bound `deedwell_app` role (password
 * from APP_DB_PASSWORD) before applying migrations, since grants reference it.
 */
export async function migrate(pool: Pool, migrationsDir = MIGRATIONS_DIR): Promise<string[]> {
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!appPassword) throw new Error("APP_DB_PASSWORD is not set");
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deedwell_app') THEN
          CREATE ROLE deedwell_app LOGIN;
        END IF;
      END $$;`);
    await client.query(
      `ALTER ROLE deedwell_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}'`
    );
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Audit — append-only, hash-chained per tenant (threat model T9).
// ---------------------------------------------------------------------------

export interface AuditInput {
  tenantId: string;
  actorUser?: string | null;
  actorAgent?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: unknown;
}

export async function audit(client: PoolClient, input: AuditInput): Promise<void> {
  const { rows } = await client.query(
    "SELECT event_hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1",
    [input.tenantId]
  );
  const prevHash: string = rows[0]?.event_hash ?? "genesis";
  const metadata = summarize(input.metadata ?? {});
  const body = JSON.stringify({
    tenantId: input.tenantId,
    actorUser: input.actorUser ?? null,
    actorAgent: input.actorAgent ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata,
    prevHash,
  });
  const eventHash = createHash("sha256").update(body).digest("hex");
  await client.query(
    `INSERT INTO audit_events (id, tenant_id, actor_user, actor_agent, action,
       entity_type, entity_id, metadata, prev_hash, event_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      uuidv7(),
      input.tenantId,
      input.actorUser ?? null,
      input.actorAgent ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify({ summary: metadata }),
      prevHash,
      eventHash,
    ]
  );
}

// ---------------------------------------------------------------------------
// Webhook delivery — enqueue only. Lives here (like audit) rather than in
// apps/api because it's called from both API route handlers and workflow
// step code (packages/website-domain), which must never depend on an app.
// Actual HTTP delivery (needs decryptSecret + fetch) stays in
// apps/api/src/webhooks.ts and runs from a periodic sweep of 'pending' rows,
// so a delivery survives a process restart between enqueue and send.
// ---------------------------------------------------------------------------

export async function enqueueWebhookEvent(
  // Accepts anything query-capable — a transaction's PoolClient (the usual
  // case: enqueue alongside the state change that caused it) or a bare Pool
  // (routes-public.ts's /complete callback, which has no transaction of its
  // own since it writes through the untenanted admin pool).
  client: Pick<PoolClient, "query">,
  eventType: string,
  payload: Record<string, unknown>
): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT id FROM webhook_subscriptions WHERE is_active AND $1 = ANY(event_types)`,
    [eventType]
  );
  const deliveryIds: string[] = [];
  for (const row of rows as { id: string }[]) {
    const id = uuidv7();
    await client.query(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [id, row.id, eventType, JSON.stringify(payload)]
    );
    deliveryIds.push(id);
  }
  return deliveryIds;
}
