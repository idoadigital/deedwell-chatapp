import type { ConnectorProvider, OAuthTokens, SelectableAccount } from "../types.js";

const GRAPH = process.env.META_GRAPH_BASE ?? "https://graph.facebook.com/v21.0";
const OAUTH = "https://www.facebook.com/v21.0/dialog/oauth";

/**
 * Meta (Facebook Pages + Instagram professional accounts) over Meta's own
 * OAuth and Graph API — not MCP. MCP can sit above this later for agentic
 * workflows; authentication and publishing use Meta's supported path.
 *
 * Note on scopes: instagram_content_publish and pages_manage_posts both
 * require Meta App Review before they work for anyone outside the app's own
 * test users. Connecting will succeed in development mode; publishing to a
 * real audience will not until that review passes.
 */
export class MetaProvider implements ConnectorProvider {
  readonly provider = "meta";
  readonly label = "Facebook & Instagram";
  // Exactly the four the code exercises, and no more. Over-requesting is one
  // of Meta's stated common causes of App Review rejection, and every extra
  // scope is another permission a nonprofit is asked to grant:
  //   pages_show_list          GET /me/accounts   (list the Pages to choose from)
  //   pages_manage_posts       POST /{page}/feed|photos|videos
  //   instagram_basic          read instagram_business_account off the Page
  //   instagram_content_publish POST /{ig}/media + /media_publish
  // Dropped: pages_read_engagement and business_management — nothing here
  // reads engagement metrics or touches Business Manager.
  readonly scopes = [
    "pages_show_list",
    "pages_manage_posts",
    "instagram_basic",
    "instagram_content_publish",
  ];

  // Credentials are injected from platform_integrations — the platform admin
  // configures the app once and every tenant authorizes against it.
  constructor(private readonly credentials?: { clientId: string; clientSecret: string } | null) {}

  private get appId(): string | undefined { return this.credentials?.clientId; }
  private get appSecret(): string | undefined { return this.credentials?.clientSecret; }

  isConfigured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(OAUTH);
    url.searchParams.set("client_id", this.appId ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(","));
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    const short = new URL(`${GRAPH}/oauth/access_token`);
    short.searchParams.set("client_id", this.appId ?? "");
    short.searchParams.set("client_secret", this.appSecret ?? "");
    short.searchParams.set("redirect_uri", redirectUri);
    short.searchParams.set("code", code);
    const shortRes = await fetchJson(short.toString());

    // Meta's short-lived user token lasts ~1 hour; the long-lived exchange
    // gives ~60 days, which is what makes scheduled publishing viable at all.
    const long = new URL(`${GRAPH}/oauth/access_token`);
    long.searchParams.set("grant_type", "fb_exchange_token");
    long.searchParams.set("client_id", this.appId ?? "");
    long.searchParams.set("client_secret", this.appSecret ?? "");
    long.searchParams.set("fb_exchange_token", String(shortRes.access_token));
    const longRes = await fetchJson(long.toString());

    const expiresIn = Number(longRes.expires_in ?? 0);
    // App-scoped user id: the same value Meta sends in a data-deletion
    // signed request, which is the only way to match one back to us.
    const me = await fetchJson(`${GRAPH}/me?fields=id&access_token=${encodeURIComponent(String(longRes.access_token))}`);
    return {
      accessToken: String(longRes.access_token),
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      scopes: this.scopes,
      providerUserId: me.id ? String(me.id) : null,
    };
  }

  /** Every Page the user administers, plus the Instagram professional account
   *  attached to it where one exists — the two are offered separately because
   *  a nonprofit may want only one of them managed. */
  async listAccounts(tokens: OAuthTokens): Promise<SelectableAccount[]> {
    const url = new URL(`${GRAPH}/me/accounts`);
    url.searchParams.set("access_token", tokens.accessToken);
    url.searchParams.set("fields", "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}");
    const res = await fetchJson(url.toString());
    const out: SelectableAccount[] = [];
    for (const page of (res.data ?? []) as Record<string, any>[]) {
      out.push({
        connectorType: "facebook_page",
        providerAccountId: String(page.id),
        name: String(page.name),
        avatarUrl: page.picture?.data?.url ?? null,
        // The Page access token is what actually publishes; it is stored
        // encrypted against the connection, never returned to the browser.
        metadata: { pageAccessToken: page.access_token },
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        out.push({
          connectorType: "instagram_account",
          providerAccountId: String(ig.id),
          name: String(ig.username ?? page.name),
          handle: ig.username ? `@${ig.username}` : null,
          avatarUrl: ig.profile_picture_url ?? null,
          metadata: { pageId: page.id, pageAccessToken: page.access_token },
        });
      }
    }
    return out;
  }

  async validate(tokens: OAuthTokens): Promise<{ ok: boolean; detail?: string }> {
    try {
      const url = new URL(`${GRAPH}/me`);
      url.searchParams.set("access_token", tokens.accessToken);
      url.searchParams.set("fields", "id");
      await fetchJson(url.toString());
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, any>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    // Meta puts the useful part in error.message; the token is in the URL, so
    // the URL itself is deliberately not included in the thrown message.
    throw new Error(body?.error?.message ?? `Meta request failed (${res.status})`);
  }
  return body;
}
