/**
 * Who gets what. Every helper takes an explicit tenant id and puts it in the
 * WHERE clause, so the same code works on the tenant-scoped app pool (where
 * RLS would filter anyway) and on the admin pool used by workers.
 */
import { emailConfig } from "./config.js";
import { enqueueEmail, type Queryable } from "./outbox.js";
import type { EmailKind, EmailPayloads } from "./templates.js";

export interface Recipient { userId: string; email: string; displayName: string; role?: string }

export async function orgRecipients(client: Queryable, tenantId: string, roles: string[] = ["owner", "admin"]): Promise<Recipient[]> {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.display_name, m.role
       FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = ANY($2::text[]) AND u.suspended_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
    [tenantId, roles]
  );
  return (rows as Array<{ id: string; email: string; display_name: string; role: string }>)
    .map((r) => ({ userId: r.id, email: r.email, displayName: r.display_name, role: r.role }));
}

export async function userRecipient(client: Queryable, userId: string): Promise<Recipient | null> {
  const { rows } = await client.query("SELECT id, email, display_name FROM users WHERE id = $1 AND suspended_at IS NULL", [userId]);
  const r = rows[0] as { id: string; email: string; display_name: string } | undefined;
  return r ? { userId: r.id, email: r.email, displayName: r.display_name } : null;
}

export async function orgNameOf(client: Queryable, tenantId: string): Promise<string> {
  const { rows } = await client.query("SELECT name FROM organizations WHERE id = $1", [tenantId]);
  return (rows[0]?.name as string | undefined) ?? "your organization";
}

/** One email per owner/admin of the org. `dedupe` (if given) is suffixed
 *  with the recipient's user id so each person is deduped independently. */
export async function emailOrgAdmins<K extends EmailKind>(
  client: Queryable, tenantId: string, kind: K, payload: EmailPayloads[K] | ((r: Recipient) => EmailPayloads[K]),
  opts: { dedupe?: string | null; roles?: string[]; except?: string | null } = {}
): Promise<number> {
  const people = await orgRecipients(client, tenantId, opts.roles);
  let n = 0;
  for (const person of people) {
    if (opts.except && person.userId === opts.except) continue;
    const id = await enqueueEmail(client, {
      kind, payload: typeof payload === "function" ? payload(person) : payload, to: person.email, tenantId, userId: person.userId,
      dedupeKey: opts.dedupe ? `${opts.dedupe}:${person.userId}` : null,
    });
    if (id) n++;
  }
  return n;
}

/** One email to a specific user (looked up so a stale address is never used). */
export async function emailUser<K extends EmailKind>(
  client: Queryable, userId: string, kind: K, payload: EmailPayloads[K],
  opts: { tenantId?: string | null; dedupe?: string | null } = {}
): Promise<string | null> {
  const person = await userRecipient(client, userId);
  if (!person) return null;
  return enqueueEmail(client, { kind, payload, to: person.email, tenantId: opts.tenantId ?? null, userId, dedupeKey: opts.dedupe ?? null });
}

/** Internal alert to the ops inbox(es). */
export async function emailOps(client: Queryable, payload: EmailPayloads["ops_alert"], opts: { tenantId?: string | null; dedupe?: string | null } = {}): Promise<number> {
  const cfg = emailConfig();
  let n = 0;
  for (const to of cfg.opsTo) {
    const id = await enqueueEmail(client, { kind: "ops_alert", payload, to, tenantId: opts.tenantId ?? null, dedupeKey: opts.dedupe ? `${opts.dedupe}:${to}` : null });
    if (id) n++;
  }
  return n;
}
