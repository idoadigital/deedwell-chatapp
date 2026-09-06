import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MetaProvider } from "@deedwell/connectors";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** The provider redirects back with only `code` and `state`. The state row is
 *  what identifies the tenant, so the callback has to be able to find it
 *  before any tenant context exists — a regression here turns every
 *  authorization into "already used or expired". */
describe("Connectors: OAuth callback", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "connectors@example.org"));
    orgId = await createOrg(env.app, token, "connectors-org");
    vi.spyOn(MetaProvider.prototype, "isConfigured").mockReturnValue(true);
    vi.spyOn(MetaProvider.prototype, "exchangeCode").mockResolvedValue({
      providerUserId: "u1", accessToken: "tok", refreshToken: null, expiresAt: null, scopes: ["pages_manage_posts"],
    });
    vi.spyOn(MetaProvider.prototype, "listAccounts").mockResolvedValue([
      { connectorType: "facebook_page", providerAccountId: "page-1", name: "Deedwell Page", handle: null, avatarUrl: null,
        metadata: { pageAccessToken: "PAGE-SECRET" } },
    ]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });

  it("claims the state issued by authorize and stages the accounts once", async () => {
    const auth = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/authorize`, { token, body: {} });
    expect(auth.status).toBe(200);
    const state = new URL(auth.body.authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const cb = await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('"ok":true');
    expect(cb.body).not.toContain("already been used");

    // The authorization is staged against the right tenant.
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    expect(list.status).toBe(200);
    const pending = list.body.connections.find((c: any) => c.provider === "meta" && c.connectorType === "pending_selection");
    expect(pending).toBeTruthy();
    expect(cb.body).toContain(pending.id);
    // The staged candidates reach the picker, their page tokens do not.
    expect(pending.metadata.candidates).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("PAGE-SECRET");

    // Single use: replaying the redirect is refused.
    const replay = await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    expect(replay.body).toContain('"ok":false');
    expect(replay.body).toContain("already been used");
  });

  it("retires an abandoned authorization when a new one lands, and selection connects the page", async () => {
    const authorize = async () => {
      const auth = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/authorize`, { token, body: {} });
      const state = new URL(auth.body.authorizeUrl).searchParams.get("state");
      await env.app.inject({ method: "GET", url: `/v1/connectors/meta/callback?code=abc&state=${state}` });
    };
    await authorize();
    await authorize();
    let list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const pendings = list.body.connections.filter((c: any) => c.connectorType === "pending_selection");
    expect(pendings).toHaveLength(1);

    const sel = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/meta/select`, {
      token, body: { pendingId: pendings[0].id, accountIds: ["page-1"] },
    });
    expect(sel.status).toBe(200);
    list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const page = list.body.connections.find((c: any) => c.connectorType === "facebook_page");
    expect(page?.status).toBe("connected");
    expect(page.accountName).toBe("Deedwell Page");
    expect(JSON.stringify(list.body)).not.toContain("PAGE-SECRET");
    expect(list.body.connections.filter((c: any) => c.connectorType === "pending_selection")).toHaveLength(0);
  });
});
