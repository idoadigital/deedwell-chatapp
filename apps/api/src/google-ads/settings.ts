/**
 * Deedwell's own Google Ads credentials: the developer token, the manager
 * (MCC) customer id, and the manager Google user's refresh token. Stored in
 * google_ads_platform_settings (sealed), with environment variables as the
 * fallback so a deployment can be configured without the admin console.
 *
 * Nothing here is ever returned to a browser except masked hints and flags.
 */
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import { GoogleProvider, currentEnvironment, readPlatformCredentials, type IntegrationEnvironment } from "@deedwell/connectors";
import { uuidv7 } from "@deedwell/database";
import { DEFAULT_API_VERSION, normalizeCustomerId } from "@deedwell/google-ads-domain";
import type { Pool } from "pg";

export interface GoogleAdsSettings {
  environment: IntegrationEnvironment;
  apiVersion: string;
  managerCustomerId: string | null;
  developerToken: string | null;
  developerTokenHint: string | null;
  managerRefreshToken: string | null;
  managerAccountEmail: string | null;
  managerStatus: "not_connected" | "connected" | "needs_attention";
  managerStatusDetail: string | null;
  managerConnectedAt: Date | null;
  /** Which pieces came from the environment rather than the database. */
  fromEnv: { developerToken: boolean; managerCustomerId: boolean; managerRefreshToken: boolean };
}

const hint = (value: string): string => (value.length > 6 ? `••••${value.slice(-4)}` : "••••");

export async function readGoogleAdsSettings(pool: Pool, environment: IntegrationEnvironment = currentEnvironment()): Promise<GoogleAdsSettings> {
  const { rows } = await pool.query(`SELECT * FROM google_ads_platform_settings WHERE environment = $1`, [environment]);
  const row = rows[0];
  const unseal = (cipher: Buffer | null, iv: Buffer | null, tag: Buffer | null): string | null =>
    cipher && iv && tag ? decryptSecret({ ciphertext: cipher, iv, tag, keyVersion: row?.key_version ?? 1 }).toString("utf8") : null;

  const dbToken = row ? unseal(row.developer_token_encrypted, row.developer_token_iv, row.developer_token_tag) : null;
  const dbRefresh = row ? unseal(row.manager_refresh_encrypted, row.manager_refresh_iv, row.manager_refresh_tag) : null;
  const envToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
  const envManager = process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID ? normalizeCustomerId(process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID) : null;
  const envRefresh = process.env.GOOGLE_ADS_MANAGER_REFRESH_TOKEN || null;

  const developerToken = dbToken ?? envToken;
  const managerRefreshToken = dbRefresh ?? envRefresh;
  return {
    environment,
    apiVersion: row?.api_version ?? DEFAULT_API_VERSION,
    managerCustomerId: row?.manager_customer_id ?? envManager,
    developerToken,
    developerTokenHint: developerToken ? (row?.developer_token_hint ?? hint(developerToken)) : null,
    managerRefreshToken,
    managerAccountEmail: row?.manager_account_email ?? (envRefresh ? "(from environment)" : null),
    managerStatus: row?.manager_status ?? (envRefresh ? "connected" : "not_connected"),
    managerStatusDetail: row?.manager_status_detail ?? null,
    managerConnectedAt: row?.manager_connected_at ?? null,
    fromEnv: { developerToken: !dbToken && Boolean(envToken), managerCustomerId: !row?.manager_customer_id && Boolean(envManager), managerRefreshToken: !dbRefresh && Boolean(envRefresh) },
  };
}

/** Everything an administrator may see about the configuration. */
export function settingsView(s: GoogleAdsSettings) {
  return {
    environment: s.environment,
    apiVersion: s.apiVersion,
    managerCustomerId: s.managerCustomerId,
    developerTokenConfigured: Boolean(s.developerToken),
    developerTokenHint: s.developerTokenHint,
    manager: {
      status: s.managerRefreshToken ? s.managerStatus : "not_connected",
      detail: s.managerStatusDetail,
      accountEmail: s.managerAccountEmail,
      connectedAt: s.managerConnectedAt,
    },
    fromEnv: s.fromEnv,
    ready: Boolean(s.developerToken),
    managerReady: Boolean(s.developerToken && s.managerCustomerId && s.managerRefreshToken),
  };
}

async function ensureRow(pool: Pool, environment: string): Promise<void> {
  await pool.query(
    `INSERT INTO google_ads_platform_settings (id, environment) VALUES ($1, $2) ON CONFLICT (environment) DO NOTHING`,
    [uuidv7(), environment],
  );
}

export async function saveGoogleAdsSettings(
  pool: Pool,
  patch: { developerToken?: string; managerCustomerId?: string | null; apiVersion?: string },
  userId: string,
  environment: IntegrationEnvironment = currentEnvironment(),
): Promise<void> {
  await ensureRow(pool, environment);
  if (patch.developerToken !== undefined) {
    const sealed = encryptSecret(Buffer.from(patch.developerToken, "utf8"));
    await pool.query(
      `UPDATE google_ads_platform_settings
          SET developer_token_encrypted = $2, developer_token_iv = $3, developer_token_tag = $4, developer_token_hint = $5,
              key_version = $6, updated_by = $7
        WHERE environment = $1`,
      [environment, sealed.ciphertext, sealed.iv, sealed.tag, hint(patch.developerToken), sealed.keyVersion, userId],
    );
  }
  if (patch.managerCustomerId !== undefined) {
    await pool.query(`UPDATE google_ads_platform_settings SET manager_customer_id = $2, updated_by = $3 WHERE environment = $1`,
      [environment, patch.managerCustomerId ? normalizeCustomerId(patch.managerCustomerId) : null, userId]);
  }
  if (patch.apiVersion !== undefined) {
    await pool.query(`UPDATE google_ads_platform_settings SET api_version = $2, updated_by = $3 WHERE environment = $1`,
      [environment, patch.apiVersion, userId]);
  }
}

export async function saveManagerConnection(
  pool: Pool, args: { refreshToken: string; email: string | null; userId: string }, environment: IntegrationEnvironment = currentEnvironment(),
): Promise<void> {
  await ensureRow(pool, environment);
  const sealed = encryptSecret(Buffer.from(args.refreshToken, "utf8"));
  await pool.query(
    `UPDATE google_ads_platform_settings
        SET manager_refresh_encrypted = $2, manager_refresh_iv = $3, manager_refresh_tag = $4, key_version = $5,
            manager_account_email = $6, manager_status = 'connected', manager_status_detail = NULL,
            manager_connected_by = $7, manager_connected_at = now(), updated_by = $7
      WHERE environment = $1`,
    [environment, sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyVersion, args.email, args.userId],
  );
  managerTokenCache.delete(environment);
}

export async function clearManagerConnection(pool: Pool, userId: string, environment: IntegrationEnvironment = currentEnvironment()): Promise<void> {
  await pool.query(
    `UPDATE google_ads_platform_settings
        SET manager_refresh_encrypted = NULL, manager_refresh_iv = NULL, manager_refresh_tag = NULL, manager_account_email = NULL,
            manager_status = 'not_connected', manager_status_detail = NULL, manager_connected_by = NULL, manager_connected_at = NULL, updated_by = $2
      WHERE environment = $1`, [environment, userId]);
  managerTokenCache.delete(environment);
}

export async function markManagerAttention(pool: Pool, detail: string, environment: IntegrationEnvironment = currentEnvironment()): Promise<void> {
  await pool.query(`UPDATE google_ads_platform_settings SET manager_status = 'needs_attention', manager_status_detail = $2 WHERE environment = $1`,
    [environment, detail]);
  managerTokenCache.delete(environment);
}

/** OAuth client for the manager sign-in: GOOGLE_ADS_CLIENT_ID/SECRET when
 *  set, otherwise the platform's Google integration (the same client the
 *  connector uses). */
export async function managerOAuthClient(pool: Pool): Promise<{ clientId: string; clientSecret: string } | null> {
  if (process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_ADS_CLIENT_ID, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET };
  }
  const creds = await readPlatformCredentials(pool, "google");
  return creds ? { clientId: creds.clientId, clientSecret: creds.clientSecret } : null;
}

const managerTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** A live access token for the manager account, refreshed on demand and
 *  cached in memory until shortly before it expires. */
export async function managerAccessToken(pool: Pool, settings?: GoogleAdsSettings): Promise<string | null> {
  const s = settings ?? await readGoogleAdsSettings(pool);
  if (!s.managerRefreshToken) return null;
  const cached = managerTokenCache.get(s.environment);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const client = await managerOAuthClient(pool);
  if (!client) return null;
  const provider = new GoogleProvider(client);
  try {
    const refreshed = await provider.refresh({ accessToken: "", refreshToken: s.managerRefreshToken, scopes: [], expiresAt: null });
    managerTokenCache.set(s.environment, { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt?.getTime() ?? Date.now() + 50 * 60_000 });
    if (s.managerStatus === "needs_attention" && !s.fromEnv.managerRefreshToken) {
      await pool.query(`UPDATE google_ads_platform_settings SET manager_status = 'connected', manager_status_detail = NULL WHERE environment = $1`, [s.environment]);
    }
    return refreshed.accessToken;
  } catch (err) {
    if (!s.fromEnv.managerRefreshToken) await markManagerAttention(pool, (err as Error).message, s.environment);
    return null;
  }
}

export function resetManagerTokenCache(): void { managerTokenCache.clear(); }
