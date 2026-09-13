import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GoogleProvider, GOOGLE_SCOPE } from "@deedwell/connectors";
import { withContext } from "@deedwell/database";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** One Google connection per workspace, shared by every Google feature:
 *  the connector reports which services are granted, incremental
 *  authorization asks only for what is missing, the Ad Grants status reads
 *  the same connection, tokens refresh through the central service, and
 *  every authentication event lands in the audit log. */
describe("Google connection service", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;
  let refreshImpl: () => Promise<any> = async () => ({ accessToken: "fresh-access", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3600_000), scopes: [] });
  const identity = ["openid", GOOGLE_SCOPE.email, GOOGLE_SCOPE.profile];
  const base = [...identity, GOOGLE_SCOPE.gmailRead, GOOGLE_SCOPE.gmailSend];
  let grantedByGoogle = base;
  const revoke = vi.fn(async () => undefined);

  const audits = async (action: string) => (await env.adminPool.query("SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY seq", [orgId, action])).rows.map((r: any) => ({ text: JSON.stringify(r.metadata) }));
  const connectViaPopup = async (features?: string[]) => {
    const auth = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/google/authorize`, { token, body: features ? { features } : {} });
    expect(auth.status).toBe(200);
    if (auth.body.alreadyGranted) return auth.body;
    const url = new URL(auth.body.authorizeUrl);
    const state = url.searchParams.get("state")!;
    const cb = await env.app.inject({ method: "GET", url: `/v1/connectors/google/callback?code=abc&state=${state}` });
    expect(cb.body).toContain('"ok":true');
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const pending = list.body.connections.find((c: any) => c.provider === "google" && c.connectorType === "pending_selection");
    const sel = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/google/select`, { token, body: { pendingId: pending.id, accountIds: ["sub-1"] } });
    expect(sel.status).toBe(200);
    return { ...auth.body, url };
  };

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "google@example.org"));
    orgId = await createOrg(env.app, token, "google-org");
    vi.spyOn(GoogleProvider.prototype, "isConfigured").mockReturnValue(true);
    vi.spyOn(GoogleProvider.prototype, "exchangeCode").mockImplementation(async () => ({
      accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3600_000), scopes: grantedByGoogle,
    }));
    vi.spyOn(GoogleProvider.prototype, "listAccounts").mockResolvedValue([
      { connectorType: "google_account", providerAccountId: "sub-1", name: "Ada Lovelace", handle: "ada@riverbend.org", avatarUrl: "https://example.org/a.png" },
    ]);
    vi.spyOn(GoogleProvider.prototype, "refresh").mockImplementation(() => refreshImpl());
    vi.spyOn(GoogleProvider.prototype, "revoke").mockImplementation(revoke);
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });

  it("reports every Google service before anything is connected", async () => {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors/google/services`, { token });
    expect(r.status).toBe(200);
    expect(r.body.connection).toBeNull();
    expect(r.body.services.map((s: any) => s.key)).toEqual(["identity", "gmail", "drive", "calendar", "sheets", "googleads", "adgrants"]);
    expect(r.body.services.every((s: any) => s.granted === false)).toBe(true);
    expect(r.body.browserSession.connected).toBe(false);
    const ag = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(ag.body.googleOAuth).toBeNull(); // no Ad Grants project yet — unchanged shape
  });

  it("a base connection grants identity + Gmail, and the Ad Grants status reads it", async () => {
    await connectViaPopup();
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors/google/services`, { token });
    expect(r.body.connection).toMatchObject({ accountHandle: "ada@riverbend.org", status: "connected" });
    const byKey = Object.fromEntries(r.body.services.map((s: any) => [s.key, s]));
    expect(byKey.identity.granted).toBe(true);
    expect(byKey.gmail.granted).toBe(true);
    expect(byKey.adgrants.granted).toBe(true); // identity is all Ad Grants needs from OAuth
    expect(byKey.drive).toMatchObject({ granted: false, missing: [GOOGLE_SCOPE.driveFile] });
    expect(JSON.stringify(r.body)).not.toMatch(/access-1|refresh-1/);

    await api(env.app, "POST", `/v1/orgs/${orgId}/ad-grants/start`, { token });
    const ag = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(ag.body.googleOAuth).toMatchObject({ connected: true, email: "ada@riverbend.org", name: "Ada Lovelace", missingScopes: [] });
    expect(ag.body.googleOAuth.connectionId).toBe(r.body.connection.id);
    const started = await audits("workflow.started");
    expect(started[0]!.text).toContain("ada@riverbend.org");
    expect((await audits("google.reauthorized")).length + (await audits("google.scopes_granted")).length).toBe(1);
  });

  it("Drive refuses until the scope is granted, then incremental auth asks only for what is missing", async () => {
    const fileId = "00000000-0000-0000-0000-000000000000";
    const drive = await api(env.app, "POST", `/v1/orgs/${orgId}/files/${fileId}/drive`, { token });
    expect([404, 409]).toContain(drive.status); // no scope → 409 before the file lookup, or 404 for the missing file

    const first = await api(env.app, "POST", `/v1/orgs/${orgId}/connectors/google/authorize`, { token, body: { features: ["gmail"] } });
    expect(first.body).toMatchObject({ alreadyGranted: true, authorizeUrl: null });

    grantedByGoogle = [...base, GOOGLE_SCOPE.driveFile];
    const { url } = await connectViaPopup(["drive"]);
    const scope = url!.searchParams.get("scope")!.split(" ");
    expect(scope).toContain(GOOGLE_SCOPE.driveFile);
    expect(scope).not.toContain(GOOGLE_SCOPE.gmailSend); // already granted — not re-consented
    expect(url!.searchParams.get("include_granted_scopes")).toBe("true");

    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors/google/services`, { token });
    expect(r.body.services.find((s: any) => s.key === "drive").granted).toBe(true);
    expect(r.body.services.find((s: any) => s.key === "gmail").granted).toBe(true);
    const live = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    expect(live.body.connections.filter((c: any) => c.connectorType === "google_account")).toHaveLength(1); // replaced, not duplicated
    const grants = await audits("google.scopes_granted");
    expect(grants.at(-1)!.text).toContain("drive.file");
  });

  it("refreshes an expiring token through the central service and audits it; a failed refresh flags the connection", async () => {
    await env.adminPool.query("UPDATE connector_connections SET token_expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND connector_type = 'google_account' AND status = 'connected'", [orgId]);
    const access = await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      env.deps.googleConnections.require(c, orgId, { scopes: [GOOGLE_SCOPE.driveFile], actorUserId: userId, feature: "drive" })
    );
    expect(access.accessToken).toBe("fresh-access");
    expect(access.accountHandle).toBe("ada@riverbend.org");
    expect((await audits("google.token_refreshed")).length).toBe(1);

    await env.adminPool.query("UPDATE connector_connections SET token_expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND connector_type = 'google_account' AND status = 'connected'", [orgId]);
    refreshImpl = async () => { throw new Error("invalid_grant: Token has been expired or revoked."); };
    await expect(withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      env.deps.googleConnections.require(c, orgId, { scopes: [GOOGLE_SCOPE.driveFile], actorUserId: userId })
    )).rejects.toMatchObject({ code: "expired" });
    expect((await audits("google.refresh_failed")).length).toBe(1);
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors/google/services`, { token });
    expect(r.body.connection.status).toBe("expired");
    const mail = await env.adminPool.query("SELECT kind FROM email_outbox WHERE tenant_id = $1 AND kind = 'connector_attention'", [orgId]);
    expect(mail.rowCount).toBe(1);
    const ag = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(ag.body.googleOAuth).toMatchObject({ connected: false, status: "expired", email: "ada@riverbend.org" });
  });

  it("a scope the connection lacks is refused with the missing list and audited", async () => {
    await expect(withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      env.deps.googleConnections.require(c, orgId, { scopes: [GOOGLE_SCOPE.spreadsheets], actorUserId: userId, feature: "sheets" })
    )).rejects.toMatchObject({ code: "missing_scopes", missing: [GOOGLE_SCOPE.spreadsheets] });
    expect((await audits("google.access_denied"))[0]!.text).toContain("sheets");
  });

  it("disconnecting revokes at Google and is isolated to the tenant", async () => {
    const other = await registerUser(env.app, "other@example.org");
    const otherOrg = await createOrg(env.app, other.token, "other-org");
    const foreign = await api(env.app, "GET", `/v1/orgs/${otherOrg}/connectors/google/services`, { token: other.token });
    expect(foreign.body.connection).toBeNull();

    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors`, { token });
    const conn = list.body.connections.find((c: any) => c.connectorType === "google_account");
    const del = await api(env.app, "DELETE", `/v1/orgs/${orgId}/connectors/${conn.id}`, { token });
    expect(del.status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect((await audits("google.revoked")).length).toBe(1);
    expect((await audits("connector.disconnected")).length).toBe(1);
    const after = await api(env.app, "GET", `/v1/orgs/${orgId}/connectors/google/services`, { token });
    expect(after.body.connection).toBeNull();
  });
});
