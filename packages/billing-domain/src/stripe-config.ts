import type { Pool, PoolClient } from "pg";
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";

type Queryable = Pool | PoolClient;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

/**
 * Platform-wide, not per-org — one Stripe account collects payments across
 * every organization. The intended path is Platform Admin -> Payments
 * (encrypted at rest, same AES-256-GCM pattern as every other credential
 * this session); STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET env vars are only
 * a local-dev fallback, checked when no active DB row exists. Returns null
 * — never throws — when neither source is configured, so callers can show
 * an honest "not configured yet" state.
 */
export async function loadStripeConfig(pool: Queryable): Promise<StripeConfig | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_secret_key, secret_key_iv, secret_key_tag,
            encrypted_webhook_secret, webhook_iv, webhook_tag, key_version
     FROM platform_stripe_config WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  const row = rows[0];
  if (row) {
    const secretKey = decryptSecret({
      ciphertext: row.encrypted_secret_key, iv: row.secret_key_iv, tag: row.secret_key_tag, keyVersion: row.key_version,
    }).toString("utf8");
    const webhookSecret = decryptSecret({
      ciphertext: row.encrypted_webhook_secret, iv: row.webhook_iv, tag: row.webhook_tag, keyVersion: row.key_version,
    }).toString("utf8");
    return { secretKey, webhookSecret };
  }
  const envSecret = process.env.STRIPE_SECRET_KEY;
  const envWebhook = process.env.STRIPE_WEBHOOK_SECRET;
  if (envSecret && envWebhook) return { secretKey: envSecret, webhookSecret: envWebhook };
  return null;
}

export interface StripeConfigStatus {
  configured: boolean;
  secretKeyLast4: string | null;
  updatedAt: string | null;
}

export async function getStripeConfigStatus(pool: Pool): Promise<StripeConfigStatus> {
  const { rows } = await pool.query(
    `SELECT secret_key_last4, created_at FROM platform_stripe_config
     WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  const row = rows[0];
  if (!row) return { configured: false, secretKeyLast4: null, updatedAt: null };
  return { configured: true, secretKeyLast4: row.secret_key_last4, updatedAt: row.created_at };
}

/** Never mutates an existing row — inserts a new active one and revokes the
 *  old, same insert-new-never-mutate convention as saveOAuthConnection. */
export async function saveStripeConfig(
  pool: Pool,
  args: { secretKey: string; webhookSecret: string; setBy: string }
): Promise<{ secretKeyLast4: string }> {
  const secretKeyEnc = encryptSecret(Buffer.from(args.secretKey, "utf8"));
  const webhookEnc = encryptSecret(Buffer.from(args.webhookSecret, "utf8"));
  const last4 = args.secretKey.slice(-4);
  await pool.query(`UPDATE platform_stripe_config SET status = 'revoked', revoked_at = now() WHERE status = 'active'`);
  await pool.query(
    `INSERT INTO platform_stripe_config
       (id, encrypted_secret_key, secret_key_iv, secret_key_tag,
        encrypted_webhook_secret, webhook_iv, webhook_tag, key_version, secret_key_last4, set_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      uuidv7(), secretKeyEnc.ciphertext, secretKeyEnc.iv, secretKeyEnc.tag,
      webhookEnc.ciphertext, webhookEnc.iv, webhookEnc.tag, secretKeyEnc.keyVersion, last4, args.setBy,
    ]
  );
  return { secretKeyLast4: last4 };
}

export async function clearStripeConfig(pool: Pool): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE platform_stripe_config SET status = 'revoked', revoked_at = now() WHERE status = 'active'`
  );
  return (rowCount ?? 0) > 0;
}
