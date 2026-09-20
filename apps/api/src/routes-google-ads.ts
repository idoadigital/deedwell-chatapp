/**
 * Customer-facing Google Ads: connect an account, see performance,
 * campaigns and the ads Deedwell created. Read-only apart from the
 * connection itself and "Sync now" — customers never edit campaigns here.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { GoogleAdsApiError, REQUEST_GOALS } from "@deedwell/google-ads-domain";
import { GoogleAdsCampaignRequestInput, GoogleAdsRequestAnswerInput, GoogleAdsRequestCancelInput, GoogleAdsSelectAccountInput } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";
import { GoogleAdsAccessError } from "./google-ads/access.js";
import { complianceReport } from "./google-ads/compliance.js";
import { connectionStatus, disconnectAccount, discoverAccounts, ensureManagerLink, selectAccount } from "./google-ads/connection.js";
import { campaignDetail, campaignsWithMetrics, deedwellAds, overview, resolveRange } from "./google-ads/reports.js";
import { RequestError, answerRequest, cancelRequest, createRequest, customerRequestView, listRequests, loadRequest, loadRequestCampaign, loadRequestEvents } from "./google-ads/requests.js";
import { accountView, activityQueryOf, listActivity, loadAccount } from "./google-ads/store.js";
import { syncAccount } from "./google-ads/sync.js";

const MIN_MANUAL_SYNC_MS = Number(process.env.GOOGLE_ADS_MANUAL_SYNC_MS ?? 5 * 60_000);

/** Turns the module's typed failures into HTTP responses. */
export function translateAdsError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof RequestError) throw new HttpError(err.status, err.message);
  if (err instanceof GoogleAdsAccessError) {
    const status = err.code === "not_configured" ? 503 : err.code === "unavailable" ? 503 : 409;
    throw new HttpError(status, err.message, { code: err.code });
  }
  if (err instanceof GoogleAdsApiError) {
    if (err.code === "unauthenticated") throw new HttpError(409, "The Google authorization expired — reconnect Google to continue.", { code: "expired" });
    if (err.code === "rate_limited" || err.code === "unavailable") throw new HttpError(503, "Google Ads is temporarily unavailable. Please try again shortly.", { code: err.code });
    throw new HttpError(502, err.message, { code: err.code });
  }
  if (err instanceof Error && !("statusCode" in err)) throw new HttpError(400, err.message);
  throw err;
}

const rangeOf = (req: FastifyRequest) => {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  return resolveRange({ range: q.range, from: q.from, to: q.to });
};

export function registerGoogleAdsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const base = "/v1/orgs/:orgId/google-ads";

  app.get(`${base}/status`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, (client) => connectionStatus(ctx.deps, client, req.orgId!)).catch(translateAdsError);
  });

  app.post(`${base}/accounts/discover`, async (req) => {
    ctx.requireRole(req, "admin");
    const accounts = await ctx.inOrg(req, (client) => discoverAccounts(ctx.deps, client, req.orgId!, req.userId)).catch(translateAdsError);
    return { accounts };
  });

  app.post(`${base}/accounts/select`, async (req, reply) => {
    ctx.requireRole(req, "admin");
    const input = GoogleAdsSelectAccountInput.parse(req.body);
    const row = await ctx.inOrg(req, (client) => selectAccount(ctx.deps, client, req.orgId!, req.userId!, input.customerId)).catch(translateAdsError);
    // A first sync right away so the page has something to show; errors are
    // recorded on the account rather than failing the connection.
    if (row.status === "connected") void syncAccount(ctx.deps, req.orgId!, row.id, req.userId);
    return reply.status(201).send({ account: accountView(row) });
  });

  app.post(`${base}/link/check`, async (req) => {
    ctx.requireRole(req, "admin");
    const row = await ctx.inOrg(req, async (client) => {
      const account = await loadAccount(client, req.orgId!);
      if (!account) throw new HttpError(404, "No Google Ads account is selected yet.");
      return ensureManagerLink(ctx.deps, client, account, req.userId);
    }).catch(translateAdsError);
    if (row.status === "connected" && !row.last_sync_at) void syncAccount(ctx.deps, req.orgId!, row.id, req.userId);
    return { account: accountView(row) };
  });

  app.post(`${base}/disconnect`, async (req) => {
    ctx.requireRole(req, "admin");
    await ctx.inOrg(req, (client) => disconnectAccount(ctx.deps, client, req.orgId!, req.userId!));
    return { ok: true };
  });

  app.post(`${base}/sync`, async (req) => {
    ctx.requireRole(req, "member");
    const account = await ctx.inOrg(req, (client) => loadAccount(client, req.orgId!));
    if (!account || account.status !== "connected") throw new HttpError(409, "Google Ads is not connected.");
    if (account.last_sync_at && Date.now() - new Date(account.last_sync_at).getTime() < MIN_MANUAL_SYNC_MS) {
      return { ok: true, skipped: true, lastSyncAt: account.last_sync_at };
    }
    const result = await syncAccount(ctx.deps, req.orgId!, account.id, req.userId);
    if (!result.ok) throw new HttpError(502, result.error ?? "Sync failed");
    return { ok: true, stats: result.stats };
  });

  const withAccount = async <T>(req: FastifyRequest, fn: (client: Parameters<Parameters<AppContext["inOrg"]>[1]>[0], account: Record<string, any>) => Promise<T>): Promise<T> =>
    ctx.inOrg(req, async (client) => {
      const account = await loadAccount(client, req.orgId!);
      if (!account) throw new HttpError(404, "Google Ads is not connected.", { code: "not_connected" });
      return fn(client, account);
    });

  app.get(`${base}/overview`, async (req) => {
    ctx.requireRole(req, "viewer");
    return withAccount(req, (client, account) => overview(client, account, rangeOf(req)));
  });

  app.get(`${base}/campaigns`, async (req) => {
    ctx.requireRole(req, "viewer");
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const campaigns = await withAccount(req, (client, account) => campaignsWithMetrics(client, account, rangeOf(req), q.status?.toUpperCase()));
    return { campaigns };
  });

  app.get(`${base}/campaigns/:campaignId`, async (req) => {
    ctx.requireRole(req, "viewer");
    const { campaignId } = req.params as { campaignId: string };
    const detail = await withAccount(req, (client, account) => campaignDetail(client, account, campaignId, rangeOf(req)));
    if (!detail) throw new HttpError(404, "Campaign not found");
    return detail;
  });

  app.get(`${base}/ads`, async (req) => {
    ctx.requireRole(req, "viewer");
    const ads = await withAccount(req, (client, account) => deedwellAds(client, account, rangeOf(req)));
    return { ads };
  });

  app.get(`${base}/ads/:adId`, async (req) => {
    ctx.requireRole(req, "viewer");
    const { adId } = req.params as { adId: string };
    const [ad] = await withAccount(req, (client, account) => deedwellAds(client, account, rangeOf(req), { adId }));
    if (!ad) throw new HttpError(404, "Ad not found");
    return { ad };
  });

  /** Paged: ?limit=&offset=&q=&action=&from=&to= → { activity, total }. */
  app.get(`${base}/activity`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, (client) => listActivity(client, req.orgId!, activityQueryOf((req.query ?? {}) as Record<string, string | undefined>, 100)));
  });

  // ---- campaign requests --------------------------------------------------

  /** The goal catalogue and the organization's own pages, for the request flow. */
  app.get(`${base}/requests/meta`, async (req) => {
    ctx.requireRole(req, "viewer");
    const pages = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `SELECT s.slug AS site_slug, s.status AS site_status, p.slug, p.title FROM sites s JOIN site_pages p ON p.site_id = s.id
          WHERE s.tenant_id = $1 AND s.status IN ('published','preview') ORDER BY s.status = 'published' DESC, p.order_idx LIMIT 40`, [req.orgId]);
      const { rows: facts } = await client.query(`SELECT value FROM org_facts WHERE tenant_id = $1 AND fact_key = 'website_url' AND status <> 'rejected' LIMIT 1`, [req.orgId]);
      const websiteUrl = facts[0]?.value ? String(facts[0].value).replace(/\/+$/, "") : null;
      return rows.map((p) => ({ title: p.title, url: `${websiteUrl ?? `https://${p.site_slug}.${process.env.SITES_BASE_DOMAIN ?? "deedwell.org"}`}${p.slug === "home" || p.slug === "index" || p.slug === "" ? "/" : `/${p.slug}`}` }));
    });
    return { goals: Object.entries(REQUEST_GOALS).map(([key, g]) => ({ key, ...g })), pages };
  });

  app.get(`${base}/requests`, async (req) => {
    ctx.requireRole(req, "viewer");
    const requests = await ctx.inOrg(req, (client) => listRequests(client, req.orgId!));
    return { requests: requests.map((r) => customerRequestView(r)) };
  });

  app.post(`${base}/requests`, async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = GoogleAdsCampaignRequestInput.parse(req.body);
    const row = await withAccount(req, (client) => createRequest(ctx.deps, client, req.orgId!, req.userId!, input)).catch(translateAdsError);
    return reply.status(201).send({ request: customerRequestView(row) });
  });

  const customerDetail = async (req: FastifyRequest, id: string) => ctx.inOrg(req, async (client) => {
    const row = await loadRequest(client, req.orgId!, id);
    if (!row) throw new HttpError(404, "Request not found");
    return customerRequestView(row, { events: await loadRequestEvents(client, id), campaign: await loadRequestCampaign(client, row) });
  });

  app.get(`${base}/requests/:requestId`, async (req) => {
    ctx.requireRole(req, "viewer");
    const { requestId } = req.params as { requestId: string };
    return { request: await customerDetail(req, requestId) };
  });

  app.post(`${base}/requests/:requestId/answer`, async (req) => {
    ctx.requireRole(req, "member");
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestAnswerInput.parse(req.body);
    await ctx.inOrg(req, (client) => answerRequest(ctx.deps, client, req.orgId!, req.userId!, requestId, input.answers)).catch(translateAdsError);
    return { request: await customerDetail(req, requestId) };
  });

  app.post(`${base}/requests/:requestId/cancel`, async (req) => {
    ctx.requireRole(req, "member");
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestCancelInput.parse(req.body ?? {});
    await ctx.inOrg(req, (client) => cancelRequest(ctx.deps, client, req.orgId!, req.userId!, requestId, input.reason ?? null)).catch(translateAdsError);
    return { request: await customerDetail(req, requestId) };
  });

  app.get(`${base}/compliance`, async (req) => {
    ctx.requireRole(req, "viewer");
    return withAccount(req, (client, account) => complianceReport(client, account));
  });
}
