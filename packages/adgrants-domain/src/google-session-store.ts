import type { PoolClient } from "pg";
import { audit, uuidv7 } from "@deedwell/database";
import { decryptSecret, encryptSecret } from "@deedwell/auth";

export interface StoredGoogleSession {
  id: string;
  accountHint: string | null;
  storageState: unknown;
}

/**
 * Tenant-facing CRUD for google_sessions — the single write/read path, same
 * shape as grant-domain's writeOrgFact() owning org_facts. Every call is
 * audited: this is a shared org credential, not a personal preference.
 */
export async function saveGoogleSession(
  client: PoolClient,
  args: { tenantId: string; connectedBy: string; accountHint: string; storageState: unknown }
): Promise<string> {
  const id = uuidv7();
  const plaintext = Buffer.from(JSON.stringify(args.storageState), "utf8");
  const { ciphertext, iv, tag, keyVersion } = encryptSecret(plaintext);
  await client.query(
    `INSERT INTO google_sessions
       (id, tenant_id, google_account_hint, encrypted_state, enc_iv, enc_tag, key_version, connected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, args.tenantId, args.accountHint, ciphertext, iv, tag, keyVersion, args.connectedBy]
  );
  await audit(client, {
    tenantId: args.tenantId, actorUser: args.connectedBy, action: "google_session.connected",
    entityType: "google_session", entityId: id, metadata: { accountHint: args.accountHint },
  });
  return id;
}

export async function loadActiveGoogleSession(
  client: PoolClient,
  tenantId: string
): Promise<StoredGoogleSession | null> {
  const { rows } = await client.query(
    `SELECT id, google_account_hint, encrypted_state, enc_iv, enc_tag, key_version
     FROM google_sessions WHERE tenant_id = $1 AND status = 'active'
     ORDER BY connected_at DESC LIMIT 1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  const plaintext = decryptSecret({
    ciphertext: row.encrypted_state, iv: row.enc_iv, tag: row.enc_tag, keyVersion: row.key_version,
  });
  return {
    id: row.id,
    accountHint: row.google_account_hint,
    storageState: JSON.parse(plaintext.toString("utf8")),
  };
}

export async function markSessionUsed(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(
    `UPDATE google_sessions SET last_used_at = now(), last_verified_at = now()
     WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId]
  );
}

/** A step detected a login redirect — the session is no longer good. Never
 *  guessed: this is only called after an actual, observed auth failure. */
export async function markSessionExpired(client: PoolClient, tenantId: string): Promise<void> {
  const { rows } = await client.query(
    `UPDATE google_sessions SET status = 'expired' WHERE tenant_id = $1 AND status = 'active' RETURNING id`,
    [tenantId]
  );
  if (rows[0]) {
    await audit(client, {
      tenantId, action: "google_session.expired",
      entityType: "google_session", entityId: rows[0].id, metadata: {},
    });
  }
}

export async function revokeGoogleSession(
  client: PoolClient,
  tenantId: string,
  revokedBy: string
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE google_sessions SET status = 'revoked', revoked_at = now(), revoked_by = $2
     WHERE tenant_id = $1 AND status = 'active' RETURNING id`,
    [tenantId, revokedBy]
  );
  if (!rows[0]) return false;
  await audit(client, {
    tenantId, actorUser: revokedBy, action: "google_session.revoked",
    entityType: "google_session", entityId: rows[0].id, metadata: {},
  });
  return true;
}
