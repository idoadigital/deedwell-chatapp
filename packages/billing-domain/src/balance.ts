import type { Pool, PoolClient } from "pg";
import { audit, uuidv7 } from "@deedwell/database";

type Queryable = Pool | PoolClient;

export async function getBalance(client: Queryable, tenantId: string): Promise<number> {
  const { rows } = await client.query(`SELECT token_balance FROM billing_accounts WHERE tenant_id = $1`, [tenantId]);
  return rows[0]?.token_balance !== undefined ? Number(rows[0].token_balance) : 0;
}

/** Single atomic upsert — the row lock Postgres holds for the statement's
 *  duration is what keeps a concurrent chat debit and a webhook credit
 *  race-safe, without a separate SELECT...FOR UPDATE round trip. */
async function adjustBalance(client: Queryable, tenantId: string, delta: number): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO billing_accounts (id, tenant_id, token_balance) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id) DO UPDATE SET token_balance = billing_accounts.token_balance + $3
     RETURNING token_balance`,
    [uuidv7(), tenantId, delta]
  );
  return Number(rows[0].token_balance);
}

export async function creditTokens(
  client: PoolClient,
  tenantId: string,
  tokens: number,
  meta: { actorUser?: string; reason: string }
): Promise<number> {
  const newBalance = await adjustBalance(client, tenantId, tokens);
  await audit(client, {
    tenantId, actorUser: meta.actorUser, action: "billing.credited",
    entityType: "billing_account", entityId: tenantId, metadata: { tokens, reason: meta.reason },
  });
  return newBalance;
}

/** No audit() here deliberately — a chat message can debit hundreds of
 *  times a day per org, and usage_ledger already carries the same
 *  tenantId/quantity/metadata as a queryable record of every debit. An
 *  audit_events row per chat message would just duplicate that at real
 *  storage cost for no additional signal. */
export async function debitTokens(client: PoolClient, tenantId: string, tokens: number): Promise<number> {
  return adjustBalance(client, tenantId, -tokens);
}

export interface BillingTransactionRow {
  id: string;
  packageId: string;
  tokenAmount: number;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export async function listTransactions(client: Queryable, tenantId: string, limit = 20): Promise<BillingTransactionRow[]> {
  const { rows } = await client.query(
    `SELECT id, package_id, token_amount, amount_cents, currency, status, created_at, completed_at
     FROM billing_transactions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit]
  );
  return rows.map((r) => ({
    id: r.id, packageId: r.package_id, tokenAmount: Number(r.token_amount), amountCents: r.amount_cents,
    currency: r.currency, status: r.status, createdAt: r.created_at, completedAt: r.completed_at,
  }));
}
