import type { Pool } from "pg";
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";

export type ProviderName = "openai";

export interface ProviderKeyStatus {
  configured: boolean;
  last4: string | null;
  setAt: string | null;
  /** True when the key comes from OPENAI_API_KEY rather than the admin store. */
  fromEnvironment: boolean;
}

/** Reads the admin-managed key, falling back to the environment so existing
 *  deployments keep working while the key is being moved into the console. */
export async function readProviderKey(pool: Pool, provider: ProviderName): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_key, key_iv, key_tag, key_version FROM platform_provider_keys
     WHERE provider = $1 AND status = 'active' LIMIT 1`,
    [provider]
  );
  const row = rows[0];
  if (row) {
    return decryptSecret({
      ciphertext: row.encrypted_key,
      iv: row.key_iv,
      tag: row.key_tag,
      keyVersion: row.key_version,
    }).toString("utf8");
  }
  return provider === "openai" ? process.env.OPENAI_API_KEY ?? null : null;
}

export async function getProviderKeyStatus(pool: Pool, provider: ProviderName): Promise<ProviderKeyStatus> {
  const { rows } = await pool.query(
    `SELECT key_last4, created_at FROM platform_provider_keys
     WHERE provider = $1 AND status = 'active' LIMIT 1`,
    [provider]
  );
  if (rows[0]) {
    return { configured: true, last4: rows[0].key_last4, setAt: rows[0].created_at, fromEnvironment: false };
  }
  const envKey = provider === "openai" ? process.env.OPENAI_API_KEY : undefined;
  return {
    configured: Boolean(envKey),
    last4: envKey ? envKey.slice(-4) : null,
    setAt: null,
    fromEnvironment: Boolean(envKey),
  };
}

/** Replaces any active key for the provider — the unique partial index makes
 *  "two active keys" unrepresentable, so the revoke must happen first. */
export async function saveProviderKey(
  pool: Pool,
  args: { provider: ProviderName; apiKey: string; setBy: string }
): Promise<{ last4: string }> {
  const enc = encryptSecret(Buffer.from(args.apiKey, "utf8"));
  const last4 = args.apiKey.slice(-4);
  await pool.query(
    `UPDATE platform_provider_keys SET status = 'revoked', revoked_at = now()
     WHERE provider = $1 AND status = 'active'`,
    [args.provider]
  );
  await pool.query(
    `INSERT INTO platform_provider_keys
       (id, provider, encrypted_key, key_iv, key_tag, key_version, key_last4, set_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), args.provider, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion, last4, args.setBy]
  );
  return { last4 };
}

export async function clearProviderKey(pool: Pool, provider: ProviderName): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE platform_provider_keys SET status = 'revoked', revoked_at = now()
     WHERE provider = $1 AND status = 'active'`,
    [provider]
  );
  return (rowCount ?? 0) > 0;
}
