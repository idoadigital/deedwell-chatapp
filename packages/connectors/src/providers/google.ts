import type { ConnectorProvider, OAuthTokens, SelectableAccount } from "../types.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE = "https://oauth2.googleapis.com/revoke";

/**
 * A general Google connector, not a Gmail one. The base connection asks only
 * for identity plus Gmail read/send; Calendar, Drive, Docs and Sheets are
 * declared here but requested incrementally, when the user actually switches
 * that feature on — Google shows every scope on the consent screen, and asking
 * a nonprofit for Drive access before anything uses it is how consent gets
 * refused.
 */
export class GoogleProvider implements ConnectorProvider {
  readonly provider = "google";
  readonly label = "Google";
  readonly scopes = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ];

  /** Requested later, per feature, via the same connect flow with extra scopes. */
  static readonly OPTIONAL_SCOPES: Record<string, string[]> = {
    calendar: ["https://www.googleapis.com/auth/calendar.events"],
    drive: ["https://www.googleapis.com/auth/drive.file"],
    sheets: ["https://www.googleapis.com/auth/spreadsheets"],
  };

  // Credentials are injected from platform_integrations — one Deedwell OAuth
  // client authorizes Google accounts for every workspace.
  constructor(private readonly credentials?: { clientId: string; clientSecret: string } | null) {}

  private get clientId(): string | undefined { return this.credentials?.clientId; }
  private get clientSecret(): string | undefined { return this.credentials?.clientSecret; }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl({ state, redirectUri, extraScopes = [] }: { state: string; redirectUri: string; extraScopes?: string[] }): string {
    const url = new URL(AUTH);
    url.searchParams.set("client_id", this.clientId ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", [...this.scopes, ...extraScopes].join(" "));
    // offline + consent is what actually returns a refresh token; without it
    // the connection dies in an hour and scheduled work stops.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId ?? "",
        client_secret: this.clientSecret ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(body?.error_description ?? `Google token exchange failed (${res.status})`);
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ?? null,
      expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000) : null,
      scopes: String(body.scope ?? "").split(" ").filter(Boolean),
    };
  }

  async listAccounts(tokens: OAuthTokens): Promise<SelectableAccount[]> {
    const res = await fetch(USERINFO, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google profile lookup failed (${res.status})`);
    const me = (await res.json()) as Record<string, any>;
    // Exactly one account per authorization — no selection step needed.
    return [{
      connectorType: "google_account",
      providerAccountId: String(me.sub),
      name: String(me.name ?? me.email),
      handle: me.email ?? null,
      avatarUrl: me.picture ?? null,
    }];
  }

  async validate(tokens: OAuthTokens): Promise<{ ok: boolean; detail?: string }> {
    const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    return res.ok ? { ok: true } : { ok: false, detail: `Google returned ${res.status}` };
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new Error("No refresh token stored for this Google connection");
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: tokens.refreshToken,
        client_id: this.clientId ?? "",
        client_secret: this.clientSecret ?? "",
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(body?.error_description ?? "Google refresh failed");
    return {
      accessToken: String(body.access_token),
      refreshToken: tokens.refreshToken,
      expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000) : null,
      scopes: tokens.scopes,
    };
  }

  async revoke(tokens: OAuthTokens): Promise<void> {
    await fetch(`${REVOKE}?token=${encodeURIComponent(tokens.refreshToken ?? tokens.accessToken)}`, {
      method: "POST",
    }).catch(() => { /* local disconnect proceeds regardless */ });
  }
}
