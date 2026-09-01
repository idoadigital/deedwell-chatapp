import type { Pool, PoolClient } from "pg";
import { randomBytes, createHash } from "node:crypto";
import { audit, uuidv7 } from "@deedwell/database";
import { decryptSecret, encryptSecret } from "@deedwell/auth";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// Identity only — no Gmail/Drive/Calendar/Ads scope. Nothing in the
// automation calls a Google API today (it drives real Google pages with
// Playwright); requesting more than openid/email/profile would be asking
// for capability that doesn't exist yet.
const SCOPES = "openid email profile";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Same "off unless every var is present" convention as bootstrap.ts's
 *  AD_GRANTS_AUTOMATION flag — a route calls this and returns an honest
 *  "not configured yet" rather than crashing on a missing secret. */
export function loadOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * Starts the redirect: stores a single-use, hashed state row (PKCE verifier
 * included, same hashed-single-use-token pattern as google_connect_sessions)
 * and returns the URL to send the browser to. `redirectTo` is where the
 * user lands back in the app after the callback completes.
 */
export async function startGoogleOAuth(
  client: PoolClient,
  config: GoogleOAuthConfig,
  args: { tenantId: string; userId: string; redirectTo: string }
): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  await client.query(
    `INSERT INTO google_oauth_states (id, tenant_id, user_id, state_hash, code_verifier, redirect_to, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')`,
    [uuidv7(), args.tenantId, args.userId, sha(state), codeVerifier, args.redirectTo]
  );

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface RedeemedOAuthState {
  tenantId: string;
  userId: string;
  codeVerifier: string;
  redirectTo: string | null;
}

/** Atomic single-use redemption, same shape as ad-grants-connect-ws.ts's
 *  redeemToken — the callback arrives as a top-level browser navigation
 *  from Google, before any tenant context exists, so this runs against the
 *  admin pool rather than a tenant-scoped client. */
export async function redeemOAuthState(pool: Pool, state: string): Promise<RedeemedOAuthState | null> {
  if (!state || state.length > 128) return null;
  const { rows } = await pool.query(
    `UPDATE google_oauth_states SET status = 'consumed'
     WHERE state_hash = $1 AND status = 'pending' AND expires_at > now()
     RETURNING tenant_id, user_id, code_verifier, redirect_to`,
    [sha(state)]
  );
  const row = rows[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, userId: row.user_id, codeVerifier: row.code_verifier, redirectTo: row.redirect_to };
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface GoogleUserinfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface ExchangedGoogleIdentity {
  subjectId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
  refreshToken: string;
  accessToken: string;
  accessTokenExpiry: Date;
}

/** Trades the authorization code for tokens, then calls the userinfo
 *  endpoint to resolve the connected profile — never decodes the id_token
 *  itself, avoiding a JWT-verification dependency for a value we can just
 *  ask Google for directly. Throws on any failure; the callback route
 *  turns that into an honest error redirect, never a guessed identity. */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier: string
): Promise<ExchangedGoogleIdentity> {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const tokens = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token — reconnect with prompt=consent");
  }

  const userRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Google userinfo lookup failed (${userRes.status})`);
  const profile = (await userRes.json()) as GoogleUserinfo;

  return {
    subjectId: profile.sub,
    email: profile.email,
    name: profile.name ?? null,
    avatarUrl: profile.picture ?? null,
    scopes: tokens.scope.split(" ").filter(Boolean),
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

/** One active connection per org, same "just insert, read the most recent
 *  active row" convention as saveGoogleSession — no dangling secondary
 *  writes to reconcile. */
export async function saveOAuthConnection(
  client: PoolClient,
  args: { tenantId: string; connectedBy: string; identity: ExchangedGoogleIdentity }
): Promise<string> {
  const id = uuidv7();
  const plaintext = Buffer.from(args.identity.refreshToken, "utf8");
  const { ciphertext, iv, tag, keyVersion } = encryptSecret(plaintext);
  await client.query(
    `INSERT INTO google_oauth_connections
       (id, tenant_id, connected_by, google_subject_id, google_account_email, google_account_name,
        google_account_avatar_url, encrypted_refresh_token, enc_iv, enc_tag, key_version, granted_scopes,
        access_token_expiry)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, args.tenantId, args.connectedBy, args.identity.subjectId, args.identity.email, args.identity.name,
      args.identity.avatarUrl, ciphertext, iv, tag, keyVersion, args.identity.scopes,
      args.identity.accessTokenExpiry,
    ]
  );
  await audit(client, {
    tenantId: args.tenantId, actorUser: args.connectedBy, action: "google_oauth.connected",
    entityType: "google_oauth_connection", entityId: id, metadata: { email: args.identity.email },
  });
  return id;
}

export interface StoredOAuthConnection {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
}

export async function loadActiveOAuthConnection(
  client: PoolClient,
  tenantId: string
): Promise<StoredOAuthConnection | null> {
  const { rows } = await client.query(
    `SELECT id, google_account_email, google_account_name, google_account_avatar_url, granted_scopes
     FROM google_oauth_connections WHERE tenant_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, email: row.google_account_email, name: row.google_account_name, avatarUrl: row.google_account_avatar_url, scopes: row.granted_scopes ?? [] };
}

/**
 * Mints a short-lived access token for the autonomous agent, on demand,
 * from the stored refresh token — the raw refresh token itself never
 * leaves this function. Always refreshes rather than caching a prior
 * access token, so there is nothing to invalidate on early revocation.
 * Returns null when there's no active connection (an honest absence, not
 * an error, so callers can park the same way needsGoogle() does) or when
 * OAuth isn't configured.
 *
 * IMPORTANT (per spec): this is identity/API access only. It must never be
 * assumed to produce a logged-in google.com browser session — that's a
 * structurally separate mechanism (google-session-store.ts / connect-flow),
 * because Google does not accept an OAuth access token as a substitute for
 * an interactive browser login.
 */
export async function getGoogleAccessToken(client: PoolClient, tenantId: string): Promise<string | null> {
  const config = loadOAuthConfig();
  if (!config) return null;
  const { rows } = await client.query(
    `SELECT id, encrypted_refresh_token, enc_iv, enc_tag, key_version
     FROM google_oauth_connections WHERE tenant_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  const refreshToken = decryptSecret({
    ciphertext: row.encrypted_refresh_token, iv: row.enc_iv, tag: row.enc_tag, keyVersion: row.key_version,
  }).toString("utf8");

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // A refresh failure means Google revoked or expired the grant on its
    // side — mark it revoked here too rather than leaving a connection
    // that looks active but can never mint a token again.
    await client.query(`UPDATE google_oauth_connections SET status = 'revoked' WHERE id = $1`, [row.id]);
    await audit(client, {
      tenantId, action: "google_oauth.refresh_failed",
      entityType: "google_oauth_connection", entityId: row.id, metadata: { status: res.status },
    });
    return null;
  }
  const tokens = (await res.json()) as GoogleTokenResponse;
  await audit(client, {
    tenantId, actorAgent: "ad-grants-automation", action: "google_oauth.token_minted",
    entityType: "google_oauth_connection", entityId: row.id, metadata: {},
  });
  return tokens.access_token;
}

export async function revokeOAuthConnection(
  client: PoolClient,
  tenantId: string,
  revokedBy: string
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT id, encrypted_refresh_token, enc_iv, enc_tag, key_version
     FROM google_oauth_connections WHERE tenant_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return false;

  const refreshToken = decryptSecret({
    ciphertext: row.encrypted_refresh_token, iv: row.enc_iv, tag: row.enc_tag, keyVersion: row.key_version,
  }).toString("utf8");
  // Best-effort: also invalidate the grant at Google so a disconnect here
  // really means disconnected there, not just "we stopped reading it."
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }).catch(() => undefined);

  await client.query(
    `UPDATE google_oauth_connections SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1`,
    [row.id, revokedBy]
  );
  await audit(client, {
    tenantId, actorUser: revokedBy, action: "google_oauth.disconnected",
    entityType: "google_oauth_connection", entityId: row.id, metadata: {},
  });
  return true;
}
