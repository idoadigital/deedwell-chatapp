import type { Pool } from "pg";
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";

export type IntegrationEnvironment = "development" | "production";
export type IntegrationStatus = "not_configured" | "configured" | "needs_attention" | "disabled";

/** What an administrator is allowed to see. The secret is represented only by
 *  its masked tail — it is never selected into this shape. */
export interface PlatformIntegrationView {
  provider: string;
  environment: IntegrationEnvironment;
  status: IntegrationStatus;
  statusDetail: string | null;
  clientIdHint: string | null;
  secretHint: string | null;
  configuration: Record<string, unknown>;
  validatedAt: string | null;
  updatedAt: string | null;
  connectedWorkspaces: number;
}

export interface PlatformCredentials {
  clientId: string;
  clientSecret: string;
  environment: IntegrationEnvironment;
  configuration: Record<string, unknown>;
}

/** Deployment environment decides which row is live, so development can never
 *  silently borrow the production secret. */
export function currentEnvironment(): IntegrationEnvironment {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/** Masked for display: enough to recognise, useless if leaked. */
function mask(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export async function readPlatformCredentials(
  pool: Pool, provider: string, environment = currentEnvironment()
): Promise<PlatformCredentials | null> {
  const { rows } = await pool.query(
    `SELECT client_id, encrypted_client_secret, secret_iv, secret_tag, key_version, configuration, environment
       FROM platform_integrations
      WHERE provider = $1 AND environment = $2 AND status = 'configured'`,
    [provider, environment]
  );
  const row = rows[0];
  if (row?.client_id && row.encrypted_client_secret) {
    return {
      clientId: row.client_id,
      clientSecret: decryptSecret({
        ciphertext: row.encrypted_client_secret, iv: row.secret_iv,
        tag: row.secret_tag, keyVersion: row.key_version,
      }).toString("utf8"),
      environment: row.environment,
      configuration: row.configuration ?? {},
    };
  }
  // Environment fallback keeps an already-deployed configuration working while
  // it is being moved into the admin console.
  const envId = process.env[provider === "meta" ? "META_APP_ID" : "GOOGLE_OAUTH_CLIENT_ID"];
  const envSecret = process.env[provider === "meta" ? "META_APP_SECRET" : "GOOGLE_OAUTH_CLIENT_SECRET"];
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, environment, configuration: {} };
  }
  return null;
}

export async function listPlatformIntegrations(
  pool: Pool, providers: string[], environment = currentEnvironment()
): Promise<PlatformIntegrationView[]> {
  const { rows } = await pool.query(
    `SELECT p.*,
            (SELECT count(*) FROM connector_connections c
              WHERE c.provider = p.provider AND c.status <> 'disconnected') AS connected_workspaces
       FROM platform_integrations p WHERE p.environment = $1`,
    [environment]
  );
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return providers.map((provider) => {
    const row = byProvider.get(provider);
    if (!row) {
      return {
        provider, environment, status: "not_configured", statusDetail: null,
        clientIdHint: null, secretHint: null, configuration: {},
        validatedAt: null, updatedAt: null, connectedWorkspaces: 0,
      };
    }
    return {
      provider,
      environment: row.environment,
      status: row.status,
      statusDetail: row.status_detail,
      clientIdHint: row.client_id ? mask(row.client_id) : null,
      secretHint: row.secret_hint,
      configuration: row.configuration ?? {},
      validatedAt: row.validated_at,
      updatedAt: row.updated_at,
      connectedWorkspaces: Number(row.connected_workspaces ?? 0),
    };
  });
}

export async function savePlatformCredentials(
  pool: Pool,
  args: { provider: string; environment: IntegrationEnvironment; clientId: string; clientSecret: string; configuredBy: string }
): Promise<void> {
  const enc = encryptSecret(Buffer.from(args.clientSecret, "utf8"));
  await pool.query(
    `INSERT INTO platform_integrations
       (id, provider, environment, client_id, encrypted_client_secret, secret_iv, secret_tag,
        key_version, secret_hint, status, configured_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'configured',$10)
     ON CONFLICT (provider, environment) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       encrypted_client_secret = EXCLUDED.encrypted_client_secret,
       secret_iv = EXCLUDED.secret_iv,
       secret_tag = EXCLUDED.secret_tag,
       key_version = EXCLUDED.key_version,
       secret_hint = EXCLUDED.secret_hint,
       status = 'configured',
       status_detail = NULL,
       validated_at = NULL,
       configured_by = EXCLUDED.configured_by`,
    [uuidv7(), args.provider, args.environment, args.clientId, enc.ciphertext, enc.iv, enc.tag,
     enc.keyVersion, `••••${args.clientSecret.slice(-4)}`, args.configuredBy]
  );
}

export async function updateIntegrationConfiguration(
  pool: Pool, provider: string, environment: IntegrationEnvironment, patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE platform_integrations SET configuration = configuration || $3::jsonb
      WHERE provider = $1 AND environment = $2`,
    [provider, environment, JSON.stringify(patch)]
  );
}

export async function markIntegrationValidated(
  pool: Pool, provider: string, environment: IntegrationEnvironment, ok: boolean, detail?: string
): Promise<void> {
  await pool.query(
    `UPDATE platform_integrations
        SET validated_at = CASE WHEN $3 THEN now() ELSE validated_at END,
            status = CASE WHEN $3 THEN 'configured' ELSE 'needs_attention' END,
            status_detail = $4
      WHERE provider = $1 AND environment = $2`,
    [provider, environment, ok, detail ?? null]
  );
}

export async function disableIntegration(
  pool: Pool, provider: string, environment: IntegrationEnvironment
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE platform_integrations SET status = 'disabled' WHERE provider = $1 AND environment = $2`,
    [provider, environment]
  );
  return (rowCount ?? 0) > 0;
}
