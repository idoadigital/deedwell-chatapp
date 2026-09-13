import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GoogleProvider, GOOGLE_SCOPE } from "@deedwell/connectors";
import { setGoogleAdsClientFactory } from "../../apps/api/src/google-ads/access.js";
import { runGoogleAdsTick } from "../../apps/api/src/google-ads/worker.js";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/**
 * Google Ads managed by Deedwell: a customer connects their account through
 * the Google connector and picks the customer id, the manager link is
 * established, snapshots and metrics sync, an administrator drives the AI
 * strategy → campaign draft → review → publish flow, and every mutation
 * lands in exactly the customer's own account.
 */

const CUSTOMER = "5556667777";
const OTHER = "9998887777";
const MANAGER = "1112223333";

/** A fake Google Ads API that records every call. */
function fakeApi() {
  const state = { linkStatus: "NONE" as "NONE" | "PENDING" | "ACTIVE", mutations: [] as Array<{ creds: any; cid: string; ops: any[]; validateOnly: boolean }>, clients: [] as any[] };
  const make = (creds: any) => {
    const client = {
      creds,
      apiVersion: "v25",
      async listAccessibleCustomers() { return [CUSTOMER, OTHER]; },
      async describeCustomer(cid: string) {
        if (cid === OTHER) return { customerId: OTHER, descriptiveName: "Someone else", currencyCode: "USD", timeZone: "America/New_York", manager: true, testAccount: false, status: "ENABLED" };
        return { customerId: cid, descriptiveName: "Riverbend Ads", currencyCode: "USD", timeZone: "America/Chicago", manager: false, testAccount: true, status: "ENABLED" };
      },
      async managerLinks() { return state.linkStatus === "NONE" ? [] : [{ resourceName: `customers/${CUSTOMER}/customerManagerLinks/${MANAGER}~1`, managerCustomerId: MANAGER, linkId: "1", status: state.linkStatus }]; },
      async clientLinks() { return state.linkStatus === "NONE" ? [] : [{ resourceName: `customers/${MANAGER}/customerClientLinks/${CUSTOMER}~1`, clientCustomerId: CUSTOMER, linkId: "1", status: state.linkStatus }]; },
      async inviteClient() { state.linkStatus = "PENDING"; return `customers/${MANAGER}/customerClientLinks/${CUSTOMER}~1`; },
      async acceptManagerLink(_cid: string, resource: string) { state.linkStatus = "ACTIVE"; return resource; },
      async searchStream(cid: string, query: string) {
        expect(cid).toBe(CUSTOMER);
        if (/FROM campaign\b/.test(query) && !/segments\.date/.test(query)) return [{ campaign: { id: "100", name: "Existing search", status: "ENABLED", servingStatus: "SERVING", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", campaignBudget: `customers/${cid}/campaignBudgets/7`, startDate: "2026-01-01" }, campaignBudget: { amountMicros: "20000000" } }];
        if (/FROM ad_group\b/.test(query) && !/segments\.date/.test(query)) return [{ adGroup: { id: "200", name: "Group A", status: "ENABLED", type: "SEARCH_STANDARD", cpcBidMicros: "1000000", campaign: `customers/${cid}/campaigns/100` } }];
        if (/FROM ad_group_ad\b/.test(query) && !/segments\.date/.test(query)) return [{ adGroupAd: { adGroup: `customers/${cid}/adGroups/200`, status: "ENABLED", ad: { id: "300", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://riverbend.org/"], responsiveSearchAd: { headlines: [{ text: "Hello" }], descriptions: [{ text: "World" }] } }, policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" } }, adGroup: { campaign: `customers/${cid}/campaigns/100` } }];
        if (/FROM ad_group_criterion/.test(query)) return [{ adGroupCriterion: { criterionId: "400", adGroup: `customers/${cid}/adGroups/200`, keyword: { text: "youth programs", matchType: "PHRASE" }, status: "ENABLED", negative: false, qualityInfo: { qualityScore: 7 } }, adGroup: { campaign: `customers/${cid}/campaigns/100` } }];
        if (/FROM campaign_criterion/.test(query)) return [];
        if (/FROM geo_target_constant/.test(query)) return [{ geoTargetConstant: { resourceName: "geoTargetConstants/2840" } }];
        if (/segments\.date/.test(query)) {
          const days = [0, 1, 2].map((n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10));
          const metrics = { impressions: "1000", clicks: "50", costMicros: "25000000", conversions: "5", conversionsValue: "500" };
          if (/FROM customer\b/.test(query)) return days.map((date) => ({ segments: { date }, metrics }));
          if (/FROM campaign\b/.test(query)) return days.map((date) => ({ campaign: { id: "100" }, segments: { date }, metrics }));
          if (/FROM ad_group\b/.test(query)) return days.map((date) => ({ adGroup: { id: "200" }, segments: { date }, metrics }));
          if (/FROM ad_group_ad\b/.test(query)) return days.map((date) => ({ adGroupAd: { ad: { id: "300" } }, segments: { date }, metrics }));
        }
        return [];
      },
      async mutate(cid: string, resource: string, operations: any[]) { state.mutations.push({ creds, cid, ops: [{ resource, operations }], validateOnly: false }); return operations.map((_o, i) => ({ resourceName: `customers/${cid}/${resource}/${900 + i}` })); },
      async mutateAll(cid: string, ops: any[], opts: { validateOnly?: boolean } = {}) {
        state.mutations.push({ creds, cid, ops, validateOnly: Boolean(opts.validateOnly) });
        return ops.map((op, i) => {
          const key = Object.keys(op)[0]!.replace("Operation", "Result");
          const kind = key.replace("Result", "");
          const path = { campaignBudget: "campaignBudgets", campaign: "campaigns", adGroup: "adGroups", adGroupCriterion: "adGroupCriteria", campaignCriterion: "campaignCriteria", adGroupAd: "adGroupAds" }[kind] ?? kind;
          return { [key]: { resourceName: `customers/${cid}/${path}/${5000 + i}` } };
        });
      },
    };
    state.clients.push(client);
    return client;
  };
  return { state, make };
}

describe("Google Ads management", () => {
  let env: TestEnv;
  let token: string; let orgId: string; let userId: string;
  let otherToken: string; let otherOrgId: string;
  const fake = fakeApi();
  const grantedByGoogle = ["openid", GOOGLE_SCOPE.email, GOOGLE_SCOPE.profile, GOOGLE_SCOPE.gmailRead, GOOGLE_SCOPE.gmailSend, GOOGLE_SCOPE.adwords];

  const connectGoogle = async (t: string, org: string) => {
    const auth = await api(env.app, "POST", `/v1/orgs/${org}/connectors/google/authorize`, { token: t, body: { features: ["googleads"] } });
    expect(auth.status).toBe(200);
    const state = new URL(auth.body.authorizeUrl).searchParams.get("state")!;
    const cb = await env.app.inject({ method: "GET", url: `/v1/connectors/google/callback?code=abc&state=${state}` });
    expect(cb.body).toContain('"ok":true');
    const list = await api(env.app, "GET", `/v1/orgs/${org}/connectors`, { token: t });
    const pending = list.body.connections.find((c: any) => c.provider === "google" && c.connectorType === "pending_selection");
    const sel = await api(env.app, "POST", `/v1/orgs/${org}/connectors/google/select`, { token: t, body: { pendingId: pending.id, accountIds: ["sub-1"] } });
    expect(sel.status).toBe(200);
  };

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token-test";
    process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID = "111-222-3333";
    process.env.GOOGLE_ADS_MANAGER_REFRESH_TOKEN = "manager-refresh";
    process.env.GOOGLE_ADS_CLIENT_ID = "ads-client";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "ads-secret";
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "ads-admin@example.org"));
    orgId = await createOrg(env.app, token, "ads-org");
    ({ token: otherToken } = await registerUser(env.app, "other@example.org"));
    otherOrgId = await createOrg(env.app, otherToken, "other-org");
    await env.adminPool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [userId]);
    vi.spyOn(GoogleProvider.prototype, "isConfigured").mockReturnValue(true);
    vi.spyOn(GoogleProvider.prototype, "exchangeCode").mockImplementation(async () => ({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3600_000), scopes: grantedByGoogle }));
    vi.spyOn(GoogleProvider.prototype, "listAccounts").mockResolvedValue([{ connectorType: "google_account", providerAccountId: "sub-1", name: "Ada", handle: "ada@riverbend.org", avatarUrl: null }]);
    vi.spyOn(GoogleProvider.prototype, "refresh").mockImplementation(async (t: any) => ({ accessToken: t.refreshToken === "manager-refresh" ? "manager-access" : "fresh-access", refreshToken: t.refreshToken, expiresAt: new Date(Date.now() + 3600_000), scopes: t.scopes }));
    setGoogleAdsClientFactory((creds) => fake.make(creds) as never);
    await connectGoogle(token, orgId);
  });
  afterAll(async () => { setGoogleAdsClientFactory(null); vi.restoreAllMocks(); await env.close(); });

  it("reports oauth_connected once the adwords scope is granted", async () => {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/status`, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "oauth_connected", account: null, platformReady: true, managerConfigured: true });
    const o = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/overview`, { token });
    expect(o.status).toBe(404);
  });

  it("discovers the accessible accounts, never trusts a customer id, and connects through the manager link", async () => {
    const d = await api(env.app, "POST", `/v1/orgs/${orgId}/google-ads/accounts/discover`, { token });
    expect(d.status).toBe(200);
    expect(d.body.accounts.map((a: any) => a.customerId)).toEqual([CUSTOMER, OTHER]);
    expect(d.body.accounts[1].isManager).toBe(true);

    const bogus = await api(env.app, "POST", `/v1/orgs/${orgId}/google-ads/accounts/select`, { token, body: { customerId: "1234567890" } });
    expect(bogus.status).toBe(409);

    const s = await api(env.app, "POST", `/v1/orgs/${orgId}/google-ads/accounts/select`, { token, body: { customerId: "555-666-7777" } });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.account).toMatchObject({ customerId: "555-666-7777", name: "Riverbend Ads", status: "connected", managerLinkStatus: "active" });
    expect(fake.state.linkStatus).toBe("ACTIVE");

    const activity = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/activity`, { token });
    expect(activity.body.activity.map((a: any) => a.action)).toEqual(expect.arrayContaining(["account_selected", "manager_link_invited", "manager_link_accepted", "connected"]));
    const audits = await env.adminPool.query(`SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'google_ads.%'`, [orgId]);
    expect(audits.rows.length).toBeGreaterThan(2);
    const mail = await env.adminPool.query(`SELECT kind FROM email_outbox WHERE tenant_id = $1 AND kind = 'google_ads_connected'`, [orgId]);
    expect(mail.rows.length).toBeGreaterThan(0);
  });

  it("syncs snapshots and serves the customer overview, campaigns and compliance from Postgres", async () => {
    await new Promise((r) => setTimeout(r, 300)); // the background first sync
    const sync = await api(env.app, "POST", `/v1/orgs/${orgId}/google-ads/sync`, { token });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const o = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/overview?range=7d`, { token });
    expect(o.status).toBe(200);
    expect(o.body.kpis.clicks.value).toBe(150);
    expect(o.body.kpis.cost.value).toBe(75);
    expect(o.body.kpis.ctr.value).toBeCloseTo(5, 3);
    expect(o.body.series).toHaveLength(7);
    expect(o.body.lastSyncAt).toBeTruthy();
    const c = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/campaigns?range=7d&status=enabled`, { token });
    expect(c.body.campaigns).toHaveLength(1);
    expect(c.body.campaigns[0]).toMatchObject({ id: "100", name: "Existing search", status: "ENABLED", dailyBudget: 20, managedByDeedwell: false });
    const detail = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/campaigns/100`, { token });
    expect(detail.body.adGroups).toHaveLength(1);
    expect(detail.body.keywords[0].text).toBe("youth programs");
    expect(detail.body.ads[0].approvalStatus).toBe("APPROVED");
    const comp = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/compliance`, { token });
    expect(comp.status).toBe(200);
    expect(comp.body.results.every((r: any) => r.status === "disabled")).toBe(true); // nothing hard-coded
    // Every read went to the manager credential, addressed to this customer.
    const managerCalls = fake.state.clients.filter((cl) => cl.creds.loginCustomerId === MANAGER);
    expect(managerCalls.length).toBeGreaterThan(0);
    expect(fake.state.clients.every((cl) => cl.creds.developerToken === "dev-token-test")).toBe(true);
  });

  it("another organization sees nothing of this account", async () => {
    const r = await api(env.app, "GET", `/v1/orgs/${otherOrgId}/google-ads/status`, { token: otherToken });
    expect(r.body).toMatchObject({ state: "not_connected", account: null });
    const o = await api(env.app, "GET", `/v1/orgs/${otherOrgId}/google-ads/campaigns`, { token: otherToken });
    expect(o.status).toBe(404);
    const cross = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/overview`, { token: otherToken });
    expect(cross.status).toBe(404);
  });

  let strategyId: string; let draftId: string; let adId: string;

  it("admin: generates a strategy (draft), approves it, then generates a campaign draft awaiting review", async () => {
    const list = await api(env.app, "GET", `/v1/admin/google-ads/accounts`, { token });
    expect(list.status).toBe(200);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0]).toMatchObject({ orgId, customerId: CUSTOMER, status: "connected", activeCampaigns: 1 });
    expect(JSON.stringify(list.body)).not.toMatch(/dev-token-test|manager-refresh|manager-access/);

    const forbidden = await api(env.app, "GET", `/v1/admin/google-ads/accounts`, { token: otherToken });
    expect(forbidden.status).toBe(403);

    const gen = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/strategies/generate`, { token, body: {} });
    expect(gen.status).toBe(201);
    expect(gen.body.strategy.status).toBe("draft");
    expect(gen.body.strategy.content.campaigns.length).toBeGreaterThan(0);
    strategyId = gen.body.strategy.id;
    const usage = await env.adminPool.query(`SELECT metadata FROM usage_ledger WHERE tenant_id = $1 AND metadata->>'source' = 'google_ads'`, [orgId]);
    expect(usage.rows.length).toBe(1);

    const early = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/strategies/${strategyId}/generate-campaign`, { token, body: {} });
    expect(early.status).toBe(400); // not approved yet

    const patch = await api(env.app, "PATCH", `/v1/admin/google-ads/orgs/${orgId}/strategies/${strategyId}`, { token, body: { title: "Riverbend search strategy v1" } });
    expect(patch.body.strategy.title).toBe("Riverbend search strategy v1");
    const approve = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/strategies/${strategyId}/approve`, { token });
    expect(approve.body.strategy.status).toBe("approved");

    const camp = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/strategies/${strategyId}/generate-campaign`, { token, body: {} });
    expect(camp.status).toBe(201);
    expect(camp.body.draft.status).toBe("awaiting_approval");
    expect(camp.body.draft.ads.length).toBeGreaterThanOrEqual(2);
    expect(camp.body.draft.validation.ok).toBe(true);
    draftId = camp.body.draft.id;
    adId = camp.body.draft.ads[0].id;
    expect(fake.state.mutations).toHaveLength(0); // nothing touched Google
  });

  it("admin: edits are validated against Google's limits and re-open review", async () => {
    const bad = await api(env.app, "PATCH", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/ads/${adId}`, { token, body: { headlines: ["This headline is far longer than thirty characters", "Short one", "Another"] } });
    expect(bad.status).toBe(200);
    expect(bad.body.validation.ok).toBe(false);
    expect(bad.body.validation.issues[0].message).toMatch(/limit is 30/);
    const approveBad = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/ads/${adId}/approve`, { token });
    expect(approveBad.status).toBe(400);
    const fix = await api(env.app, "PATCH", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/ads/${adId}`, { token, body: { headlines: ["Riverbend Youth Programs", "After School Support", "Join Us Today"] } });
    expect(fix.body.validation.ok).toBe(true);
    const preview = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/publish-preview`, { token });
    expect(preview.body.preview.blockers).toContain("The campaign has not been approved.");
    const publishEarly = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/publish`, { token, body: { confirmName: "x" } });
    expect(publishEarly.status).toBe(400);
  });

  it("admin: approves the draft and publishes it, paused, into exactly this customer's account", async () => {
    const approve = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/approve`, { token });
    expect(approve.status).toBe(200);
    expect(approve.body.draft.status).toBe("approved");
    expect(approve.body.draft.ads.every((a: any) => a.status === "approved")).toBe(true);
    const preview = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/publish-preview`, { token });
    expect(preview.body.preview.blockers).toEqual([]);
    expect(preview.body.preview.account.customerId).toBe("555-666-7777");
    expect(preview.body.preview.campaign.initialStatus).toBe("PAUSED");

    const wrongName = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/publish`, { token, body: { confirmName: "nope" } });
    expect(wrongName.status).toBe(400);
    const publish = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}/publish`, { token, body: { confirmName: preview.body.preview.campaign.name } });
    expect(publish.status).toBe(202);
    expect(publish.body.job.status).toBe("queued");
    expect(fake.state.mutations).toHaveLength(0); // queued, not yet executed

    const stats = await runGoogleAdsTick(env.deps);
    expect(stats.jobs).toBe(1);
    const job = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${orgId}/publish-jobs/${publish.body.job.id}`, { token });
    expect(job.body.job.status).toBe("completed");
    expect(job.body.job.result.campaignId).toBe("5001");

    const writes = fake.state.mutations;
    expect(writes).toHaveLength(2);
    expect(writes[0]!.validateOnly).toBe(true);
    expect(writes[1]!.validateOnly).toBe(false);
    for (const w of writes) {
      expect(w.cid).toBe(CUSTOMER);
      expect(w.creds.loginCustomerId).toBe(MANAGER);
      expect(w.ops[1].campaignOperation.create.status).toBe("PAUSED");
      expect(w.ops[1].campaignOperation.create.containsEuPoliticalAdvertising).toBe("DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
      expect(w.ops.filter((o: any) => o.adGroupAdOperation).length).toBe(approve.body.draft.ads.length);
    }
    const draft = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${orgId}/drafts/${draftId}`, { token });
    expect(draft.body.draft.status).toBe("published");
    expect(draft.body.draft.ads.every((a: any) => a.status === "published" && a.google?.adId)).toBe(true);

    const ads = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/ads`, { token });
    expect(ads.body.ads.length).toBe(approve.body.draft.ads.length);
    expect(ads.body.ads[0]).toMatchObject({ state: "published", createdBy: expect.stringContaining("Deedwell") });
    const campaigns = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/campaigns`, { token });
    expect(campaigns.body.campaigns.find((c: any) => c.id === "5001")).toMatchObject({ status: "PAUSED", managedByDeedwell: true });
    const mail = await env.adminPool.query(`SELECT kind FROM email_outbox WHERE tenant_id = $1 AND kind = 'google_ads_published'`, [orgId]);
    expect(mail.rows.length).toBeGreaterThan(0);
  });

  it("enabling a campaign or changing its budget needs an explicit confirmation and is logged", async () => {
    const noConfirm = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/campaigns/5001/status`, { token, body: { status: "ENABLED" } });
    expect(noConfirm.status).toBe(400);
    const enable = await api(env.app, "POST", `/v1/admin/google-ads/orgs/${orgId}/campaigns/5001/status`, { token, body: { status: "ENABLED", confirmation: "CONFIRM" } });
    expect(enable.status).toBe(200);
    const last = fake.state.mutations.at(-1)!;
    expect(last.cid).toBe(CUSTOMER);
    expect(last.ops[0]).toMatchObject({ resource: "campaigns" });
    const activity = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${orgId}/activity`, { token });
    const enabled = activity.body.activity.find((a: any) => a.action === "campaign_enabled");
    expect(enabled).toMatchObject({ previousState: "PAUSED", newState: "ENABLED", actorKind: "admin" });
  });

  it("admin cannot act on an organization that has no account, and drafts never cross tenants", async () => {
    const r = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${otherOrgId}/drafts`, { token });
    expect(r.status).toBe(404);
    const cross = await api(env.app, "GET", `/v1/admin/google-ads/orgs/${otherOrgId}/drafts/${draftId}`, { token });
    expect(cross.status).toBe(404);
  });

  it("disconnecting stops everything and the connector reflects it", async () => {
    const d = await api(env.app, "POST", `/v1/orgs/${orgId}/google-ads/disconnect`, { token });
    expect(d.status).toBe(200);
    const s = await api(env.app, "GET", `/v1/orgs/${orgId}/google-ads/status`, { token });
    expect(s.body.state).toBe("oauth_connected");
    expect(s.body.account).toBeNull();
  });
});
