/**
 * Platform-admin Google Ads management: every connected organization, one
 * organization's workspace (overview, strategy, campaigns, ads, AI drafts,
 * activity), the AI actions, review decisions, publishing, and Deedwell's
 * own credentials. Every tenant-scoped call runs under that tenant's RLS
 * context; the customer id always comes from the tenant's account row.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { GoogleProvider, GOOGLE_SCOPE } from "@deedwell/connectors";
import { uuidv7, withContext } from "@deedwell/database";
import { RSA_LIMITS } from "@deedwell/google-ads-domain";
import {
  GoogleAdsBudgetInput, GoogleAdsCampaignStatusInput, GoogleAdsComplianceRulePatchInput, GoogleAdsDraftAdPatchInput, GoogleAdsDraftAssetPatchInput,
  GoogleAdsDraftPatchInput, GoogleAdsPlatformSettingsInput, GoogleAdsPublishInput, GoogleAdsStrategyPatchInput,
  GoogleAdsRequestAskInput, GoogleAdsRequestDecisionInput, GoogleAdsRequestHandoffInput, GoogleAdsRequestNotesInput,
} from "@deedwell/schemas";
import type { PoolClient } from "pg";
import { HttpError, type AppContext } from "./app.js";
import { billingState } from "./billing-gate.js";
import { generateStrategy, loadStrategy, regenerateDraftAd, strategyView } from "./google-ads/ai.js";
import { enqueueBuilds, listBuilds, regenerateImageAsset } from "./google-ads/build.js";
import { complianceReport, loadComplianceRules } from "./google-ads/compliance.js";
import { ensureManagerLink } from "./google-ads/connection.js";
import { decideDraft, decideDraftAd, decideDraftAsset, jobView, listDrafts, loadDraft, patchDraft, patchDraftAd, patchDraftAsset } from "./google-ads/drafts.js";
import { publishPreview, requestPublish, setCampaignBudget, setCampaignStatus } from "./google-ads/publish.js";
import { accountsAcrossTenants, campaignDetail, campaignsWithMetrics, deedwellAds, overview, resolveRange } from "./google-ads/reports.js";
import { adminRequestDetail, adminRequestView, askCustomer, decideRequest, handoffRequest, listRequests, noteRequest, onStrategyApproved, requestsAcrossTenants } from "./google-ads/requests.js";
import { clearManagerConnection, managerOAuthClient, readGoogleAdsSettings, saveGoogleAdsSettings, saveManagerConnection, settingsView } from "./google-ads/settings.js";
import { accountView, activityQueryOf, listActivity, loadAccount, logActivity } from "./google-ads/store.js";
import { syncAccount } from "./google-ads/sync.js";
import { translateAdsError } from "./routes-google-ads.js";

const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://deedwell.org";
const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
const MANAGER_REDIRECT_URI = process.env.GOOGLE_ADS_REDIRECT_URI ?? `${API_ORIGIN}/v1/google-ads/manager/callback`;
const MANAGER_RETURN = `${APP_ORIGIN}/dashboard/admin/google-ads`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function registerAdminGoogleAdsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;
  const base = "/v1/admin/google-ads";

  const rangeOf = (req: FastifyRequest) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return resolveRange({ range: q.range, from: q.from, to: q.to });
  };

  /** Runs `fn` inside the target organization's context (RLS-scoped), with
   *  the organization's live Google Ads account when one is required. */
  const inTenant = async <T>(req: FastifyRequest, fn: (client: PoolClient, orgId: string) => Promise<T>): Promise<T> => {
    ctx.requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const org = await deps.adminPool.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]);
    if (!org.rows[0]) throw new HttpError(404, "Organization not found");
    return withContext(deps.appPool, { tenantId: orgId, userId: req.userId }, (client) => fn(client, orgId)).catch(translateAdsError);
  };
  const withAccount = <T>(req: FastifyRequest, fn: (client: PoolClient, account: Record<string, any>, orgId: string) => Promise<T>): Promise<T> =>
    inTenant(req, async (client, orgId) => {
      const account = await loadAccount(client, orgId);
      if (!account) throw new HttpError(404, "This organization has not connected Google Ads.", { code: "not_connected" });
      return fn(client, account, orgId);
    });
  const orgName = async (orgId: string): Promise<string> => {
    const { rows } = await deps.adminPool.query(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    return rows[0]?.name ?? "Organization";
  };

  // ---- all organizations -------------------------------------------------

  app.get(`${base}/accounts`, async (req) => {
    ctx.requirePlatformAdmin(req);
    const accounts = await accountsAcrossTenants(deps.adminPool, rangeOf(req));
    return { accounts, settings: settingsView(await readGoogleAdsSettings(deps.appPool)) };
  });

  // ---- Deedwell's own credentials ----------------------------------------

  app.get(`${base}/settings`, async (req) => {
    ctx.requirePlatformAdmin(req);
    return { settings: settingsView(await readGoogleAdsSettings(deps.appPool)), limits: RSA_LIMITS, managerRedirectUri: MANAGER_REDIRECT_URI };
  });

  app.put(`${base}/settings`, async (req) => {
    ctx.requirePlatformAdmin(req);
    const input = GoogleAdsPlatformSettingsInput.parse(req.body);
    await saveGoogleAdsSettings(deps.appPool, input, req.userId!);
    return { settings: settingsView(await readGoogleAdsSettings(deps.appPool)) };
  });

  app.post(`${base}/manager/authorize`, async (req) => {
    ctx.requirePlatformAdmin(req);
    const client = await managerOAuthClient(deps.appPool);
    if (!client) throw new HttpError(503, "Configure the Google OAuth client under Integrations first.");
    const state = randomBytes(32).toString("base64url");
    await deps.appPool.query(
      `INSERT INTO google_ads_manager_oauth_states (id, state_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [uuidv7(), hash(state), req.userId]);
    const provider = new GoogleProvider(client);
    const authorizeUrl = provider.authorizeUrl({ state, redirectUri: MANAGER_REDIRECT_URI, scopes: [GOOGLE_SCOPE.openid, GOOGLE_SCOPE.email, GOOGLE_SCOPE.adwords] });
    return { authorizeUrl };
  });

  // Public: Google redirects here. The state row is the only credential.
  app.get("/v1/google-ads/manager/callback", async (req, reply) => {
    const { code, state, error, scope } = (req.query ?? {}) as Record<string, string | undefined>;
    const back = (status: string, detail?: string) => reply.redirect(`${MANAGER_RETURN}?manager=${encodeURIComponent(status)}${detail ? `&detail=${encodeURIComponent(detail)}` : ""}`);
    if (error) return back("denied", error);
    if (!code || !state) return back("invalid");
    // Google lists the scopes the user actually granted (consent is per
    // scope). A manager token without the Ads scope is useless, so refuse it
    // here instead of storing a connection that fails on first use.
    if (scope && !scope.split(/\s+/).includes(GOOGLE_SCOPE.adwords)) {
      return back("missing_scope", "Google did not grant the Google Ads permission. Tick the Google Ads checkbox on the consent screen and sign in again.");
    }
    const claimed = await deps.adminPool.query(
      `UPDATE google_ads_manager_oauth_states SET consumed_at = now() WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING created_by`, [hash(state)]);
    const row = claimed.rows[0];
    if (!row) return back("expired");
    const client = await managerOAuthClient(deps.appPool);
    if (!client) return back("unconfigured");
    const provider = new GoogleProvider(client);
    try {
      const tokens = await provider.exchangeCode({ code, redirectUri: MANAGER_REDIRECT_URI });
      if (!tokens.refreshToken) return back("no_refresh_token");
      const [me] = await provider.listAccounts(tokens).catch(() => []);
      await saveManagerConnection(deps.appPool, { refreshToken: tokens.refreshToken, email: me?.handle ?? me?.name ?? null, userId: row.created_by });
      return back("connected");
    } catch (err) {
      return back("failed", (err as Error).message);
    }
  });

  app.delete(`${base}/manager`, async (req) => {
    ctx.requirePlatformAdmin(req);
    await clearManagerConnection(deps.appPool, req.userId!);
    return { ok: true };
  });

  app.get(`${base}/compliance-rules`, async (req) => {
    ctx.requirePlatformAdmin(req);
    return { rules: await loadComplianceRules(deps.appPool) };
  });

  app.patch(`${base}/compliance-rules/:key`, async (req) => {
    ctx.requirePlatformAdmin(req);
    const { key } = req.params as { key: string };
    const input = GoogleAdsComplianceRulePatchInput.parse(req.body);
    const { rowCount } = await deps.appPool.query(
      `UPDATE google_ads_compliance_rules SET enabled = COALESCE($2, enabled), threshold = CASE WHEN $4 THEN $3 ELSE threshold END,
              window_days = COALESCE($5, window_days), updated_by = $6 WHERE key = $1`,
      [key, input.enabled ?? null, input.threshold ?? null, input.threshold !== undefined, input.windowDays ?? null, req.userId]);
    if (!rowCount) throw new HttpError(404, "Rule not found");
    return { rules: await loadComplianceRules(deps.appPool) };
  });

  // ---- one organization --------------------------------------------------

  app.get(`${base}/orgs/:orgId`, async (req) => inTenant(req, async (client, orgId) => {
    const account = await loadAccount(client, orgId);
    const settings = await readGoogleAdsSettings(deps.appPool);
    const name = await orgName(orgId);
    if (!account) return { organization: { id: orgId, name }, account: null, overview: null, compliance: null, managerConfigured: Boolean(settings.managerCustomerId && settings.managerRefreshToken) };
    return {
      organization: { id: orgId, name },
      account: accountView(account),
      overview: await overview(client, account, rangeOf(req)),
      compliance: await complianceReport(client, account),
      managerConfigured: Boolean(settings.managerCustomerId && settings.managerRefreshToken),
    };
  }));

  app.post(`${base}/orgs/:orgId/sync`, async (req) => {
    const account = await withAccount(req, async (_client, acc) => acc);
    const result = await syncAccount(deps, account.tenant_id, account.id, req.userId);
    if (!result.ok) throw new HttpError(502, result.error ?? "Sync failed");
    return { ok: true, stats: result.stats };
  });

  app.post(`${base}/orgs/:orgId/link/check`, async (req) => withAccount(req, async (client, account) => ({ account: accountView(await ensureManagerLink(deps, client, account, req.userId)) })));

  app.get(`${base}/orgs/:orgId/campaigns`, async (req) => withAccount(req, async (client, account) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return { campaigns: await campaignsWithMetrics(client, account, rangeOf(req), q.status?.toUpperCase()) };
  }));

  app.get(`${base}/orgs/:orgId/campaigns/:campaignId`, async (req) => withAccount(req, async (client, account) => {
    const { campaignId } = req.params as { campaignId: string };
    const detail = await campaignDetail(client, account, campaignId, rangeOf(req));
    if (!detail) throw new HttpError(404, "Campaign not found");
    return detail;
  }));

  app.post(`${base}/orgs/:orgId/campaigns/:campaignId/status`, async (req) => withAccount(req, async (client, account) => {
    const { campaignId } = req.params as { campaignId: string };
    const input = GoogleAdsCampaignStatusInput.parse(req.body);
    await setCampaignStatus(deps, client, account, campaignId, input.status, req.userId!);
    return { ok: true };
  }));

  app.post(`${base}/orgs/:orgId/campaigns/:campaignId/budget`, async (req) => withAccount(req, async (client, account) => {
    const { campaignId } = req.params as { campaignId: string };
    const input = GoogleAdsBudgetInput.parse(req.body);
    await setCampaignBudget(deps, client, account, campaignId, input.dailyBudgetMicros, req.userId!);
    return { ok: true };
  }));

  app.get(`${base}/orgs/:orgId/ads`, async (req) => withAccount(req, async (client, account) => ({ ads: await deedwellAds(client, account, rangeOf(req)) })));

  app.get(`${base}/orgs/:orgId/ads/:adId`, async (req) => withAccount(req, async (client, account) => {
    const { adId } = req.params as { adId: string };
    const [ad] = await deedwellAds(client, account, rangeOf(req), { adId });
    if (!ad) throw new HttpError(404, "Ad not found");
    return { ad };
  }));

  /** Paged and filterable: ?limit=&offset=&q=&action=&actor=&entity=&from=&to= → { activity, total }. */
  app.get(`${base}/orgs/:orgId/activity`, async (req) => inTenant(req, async (client, orgId) =>
    listActivity(client, orgId, activityQueryOf((req.query ?? {}) as Record<string, string | undefined>, 200))));

  app.get(`${base}/orgs/:orgId/compliance`, async (req) => withAccount(req, (client, account) => complianceReport(client, account)));

  // ---- strategies --------------------------------------------------------

  app.get(`${base}/orgs/:orgId/strategies`, async (req) => withAccount(req, async (client, account) => {
    const { rows } = await client.query(
      `SELECT s.*, c.display_name AS created_by_name, a.display_name AS approved_by_name
         FROM google_ads_strategies s LEFT JOIN users c ON c.id = s.created_by LEFT JOIN users a ON a.id = s.approved_by
        WHERE s.account_id = $1 ORDER BY s.created_at DESC`, [account.id]);
    const builds = await listBuilds(client, account.id);
    const { rows: drafts } = await client.query(
      `SELECT id, strategy_id, status, name, (model_meta->>'campaignIndex')::int AS campaign_index FROM google_ads_drafts WHERE account_id = $1 AND strategy_id IS NOT NULL ORDER BY created_at DESC`, [account.id]);
    return {
      strategies: rows.map((r) => ({
        ...strategyView(r),
        builds: builds.filter((b) => b.strategyId === r.id),
        drafts: drafts.filter((d) => d.strategy_id === r.id).map((d) => ({ id: d.id, status: d.status, name: d.name, campaignIndex: d.campaign_index })),
      })),
    };
  }));

  app.get(`${base}/orgs/:orgId/strategies/:strategyId`, async (req) => withAccount(req, async (client, account) => {
    const { strategyId } = req.params as { strategyId: string };
    const { rows } = await client.query(`SELECT id FROM google_ads_strategies WHERE id = $1 AND account_id = $2`, [strategyId, account.id]);
    if (!rows[0]) throw new HttpError(404, "Strategy not found");
    const strategy = await loadStrategy(client, strategyId);
    const builds = await listBuilds(client, account.id, { strategyId });
    const { rows: drafts } = await client.query(
      `SELECT id, status, name, (model_meta->>'campaignIndex')::int AS campaign_index FROM google_ads_drafts WHERE account_id = $1 AND strategy_id = $2 ORDER BY created_at DESC`, [account.id, strategyId]);
    return { strategy: { ...strategy, builds, drafts: drafts.map((d) => ({ id: d.id, status: d.status, name: d.name, campaignIndex: d.campaign_index })) } };
  }));

  app.get(`${base}/orgs/:orgId/builds`, async (req) => withAccount(req, async (client, account) => {
    const q = (req.query ?? {}) as { strategyId?: string };
    return { builds: await listBuilds(client, account.id, { strategyId: q.strategyId }) };
  }));

  app.post(`${base}/orgs/:orgId/strategies/generate`, async (req, reply) => {
    const body = (req.body ?? {}) as { instructions?: string };
    const strategy = await withAccount(req, async (client, account, orgId) => {
      await requireTokensFor(ctx, client, orgId);
      return generateStrategy(deps, client, orgId, account, req.userId!, { instructions: body.instructions?.slice(0, 2000) });
    });
    return reply.status(201).send({ strategy });
  });

  app.patch(`${base}/orgs/:orgId/strategies/:strategyId`, async (req) => withAccount(req, async (client, account) => {
    const { strategyId } = req.params as { strategyId: string };
    const input = GoogleAdsStrategyPatchInput.parse(req.body);
    const { rows } = await client.query(`SELECT * FROM google_ads_strategies WHERE id = $1 AND account_id = $2`, [strategyId, account.id]);
    const current = rows[0];
    if (!current) throw new HttpError(404, "Strategy not found");
    if (current.status === "archived") throw new HttpError(409, "An archived strategy cannot be edited");
    const content = { ...current.content, ...(input.content ?? {}) };
    await client.query(`UPDATE google_ads_strategies SET title = $2, content = $3, status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`,
      [strategyId, input.title ?? current.title, JSON.stringify(content)]);
    await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId: req.userId, actorKind: "admin", action: "strategy_edited", entityType: "strategy", entityId: strategyId, previousState: current.status, newState: "draft", summary: input.title ?? current.title });
    return { strategy: await loadStrategy(client, strategyId) };
  }));

  for (const decision of ["approve", "archive"] as const) {
    app.post(`${base}/orgs/:orgId/strategies/:strategyId/${decision}`, async (req) => withAccount(req, async (client, account, orgId) => {
      const { strategyId } = req.params as { strategyId: string };
      const { rows } = await client.query(`SELECT * FROM google_ads_strategies WHERE id = $1 AND account_id = $2`, [strategyId, account.id]);
      const current = rows[0];
      if (!current) throw new HttpError(404, "Strategy not found");
      let builds: Awaited<ReturnType<typeof enqueueBuilds>> = [];
      if (decision === "approve") {
        if (current.status !== "draft") throw new HttpError(409, "Only a draft strategy can be approved");
        await client.query(`UPDATE google_ads_strategies SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [strategyId, req.userId]);
        // An approved strategy becomes campaigns without another click: one
        // build per recommendation, run by the worker, reviewed in the workspace.
        await requireTokensFor(ctx, client, orgId);
        builds = await enqueueBuilds(client, account as never, { ...current, status: "approved" }, req.userId!);
        await onStrategyApproved(deps, client, current, req.userId!);
      } else {
        await client.query(`UPDATE google_ads_strategies SET status = 'archived', archived_at = now() WHERE id = $1`, [strategyId]);
      }
      await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId: req.userId, actorKind: "admin", action: decision === "approve" ? "strategy_approved" : "strategy_archived", entityType: "strategy", entityId: strategyId, previousState: current.status, newState: decision === "approve" ? "approved" : "archived", summary: current.title });
      return { strategy: await loadStrategy(client, strategyId), builds };
    }));
  }

  /** Queues a (re)build of one recommendation; the worker drafts it and
   *  renders its creatives. 202 with the build to poll. */
  app.post(`${base}/orgs/:orgId/strategies/:strategyId/generate-campaign`, async (req, reply) => {
    const { strategyId } = req.params as { strategyId: string };
    const body = (req.body ?? {}) as { campaignIndex?: number; instructions?: string };
    const build = await withAccount(req, async (client, account, orgId) => {
      await requireTokensFor(ctx, client, orgId);
      const { rows } = await client.query(`SELECT * FROM google_ads_strategies WHERE id = $1 AND account_id = $2`, [strategyId, account.id]);
      if (!rows[0]) throw new HttpError(404, "Strategy not found");
      if (rows[0].status !== "approved") throw new HttpError(400, "Only an approved strategy can generate campaigns");
      const [job] = await enqueueBuilds(client, account as never, rows[0], req.userId!, { indexes: [body.campaignIndex ?? 0], instructions: body.instructions?.slice(0, 2000) });
      return job;
    });
    return reply.status(202).send({ build });
  });

  // ---- campaign requests --------------------------------------------------

  /** Every organization's requests; ?open=1 keeps only the ones still moving. */
  app.get(`${base}/requests`, async (req) => {
    ctx.requirePlatformAdmin(req);
    const q = (req.query ?? {}) as { open?: string; limit?: string };
    return { requests: await requestsAcrossTenants(deps.adminPool, { open: q.open === "1" || q.open === "true", limit: Number(q.limit) || undefined }) };
  });

  app.get(`${base}/orgs/:orgId/requests`, async (req) => inTenant(req, async (client, orgId) => ({ requests: (await listRequests(client, orgId)).map((r) => adminRequestView(r)) })));

  const requestDetail = (req: FastifyRequest, requestId: string) => inTenant(req, async (client, orgId) => {
    const request = await adminRequestDetail(client, orgId, requestId, await orgName(orgId));
    if (!request) throw new HttpError(404, "Request not found");
    return { request };
  });

  app.get(`${base}/orgs/:orgId/requests/:requestId`, async (req) => requestDetail(req, (req.params as { requestId: string }).requestId));

  /** Hands the request to the Ad Grants account manager (or re-runs it with guidance). 202: the worker does the work. */
  app.post(`${base}/orgs/:orgId/requests/:requestId/handoff`, async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestHandoffInput.parse(req.body ?? {});
    const { run } = await inTenant(req, async (client, orgId) => {
      await requireTokensFor(ctx, client, orgId);
      return handoffRequest(deps, client, orgId, req.userId!, requestId, input.instructions ?? null);
    });
    return reply.status(202).send({ ...(await requestDetail(req, requestId)), run: { id: run.id, status: run.status } });
  });

  app.post(`${base}/orgs/:orgId/requests/:requestId/ask`, async (req) => {
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestAskInput.parse(req.body);
    await inTenant(req, (client, orgId) => askCustomer(deps, client, orgId, req.userId!, requestId, input.questions, input.message ?? null));
    return requestDetail(req, requestId);
  });

  app.post(`${base}/orgs/:orgId/requests/:requestId/decide`, async (req) => {
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestDecisionInput.parse(req.body);
    await inTenant(req, (client, orgId) => decideRequest(deps, client, orgId, req.userId!, requestId, input.status, input.message ?? null, input.reason ?? null));
    return requestDetail(req, requestId);
  });

  app.patch(`${base}/orgs/:orgId/requests/:requestId`, async (req) => {
    const { requestId } = req.params as { requestId: string };
    const input = GoogleAdsRequestNotesInput.parse(req.body);
    await inTenant(req, (client, orgId) => noteRequest(client, orgId, req.userId!, requestId, input));
    return requestDetail(req, requestId);
  });

  // ---- drafts (the review workspace) --------------------------------------

  app.get(`${base}/orgs/:orgId/drafts`, async (req) => withAccount(req, async (client, account) => ({ drafts: await listDrafts(client, account.id) })));

  app.get(`${base}/orgs/:orgId/drafts/:draftId`, async (req) => withAccount(req, async (client, account) => {
    const { draftId } = req.params as { draftId: string };
    const draft = await loadDraft(client, account.id, draftId);
    if (!draft) throw new HttpError(404, "Draft not found");
    return { draft, limits: RSA_LIMITS };
  }));

  app.patch(`${base}/orgs/:orgId/drafts/:draftId`, async (req) => withAccount(req, async (client, account) => {
    const { draftId } = req.params as { draftId: string };
    const input = GoogleAdsDraftPatchInput.parse(req.body);
    await patchDraft(client, account, draftId, input as never, req.userId!);
    return { draft: await loadDraft(client, account.id, draftId) };
  }));

  for (const decision of ["approve", "reject"] as const) {
    app.post(`${base}/orgs/:orgId/drafts/:draftId/${decision}`, async (req) => withAccount(req, async (client, account) => {
      const { draftId } = req.params as { draftId: string };
      const body = (req.body ?? {}) as { reason?: string };
      await decideDraft(client, account, draftId, decision, req.userId!, body.reason);
      return { draft: await loadDraft(client, account.id, draftId) };
    }));
    app.post(`${base}/orgs/:orgId/drafts/:draftId/ads/:adId/${decision}`, async (req) => withAccount(req, async (client, account) => {
      const { draftId, adId } = req.params as { draftId: string; adId: string };
      const body = (req.body ?? {}) as { reason?: string };
      await decideDraftAd(client, account, draftId, adId, decision, req.userId!, body.reason);
      return { draft: await loadDraft(client, account.id, draftId) };
    }));
  }

  app.patch(`${base}/orgs/:orgId/drafts/:draftId/ads/:adId`, async (req) => withAccount(req, async (client, account) => {
    const { draftId, adId } = req.params as { draftId: string; adId: string };
    const input = GoogleAdsDraftAdPatchInput.parse(req.body);
    const validation = await patchDraftAd(client, account, draftId, adId, input, req.userId!);
    return { validation, draft: await loadDraft(client, account.id, draftId) };
  }));

  app.post(`${base}/orgs/:orgId/drafts/:draftId/ads/:adId/regenerate`, async (req) => withAccount(req, async (client, account, orgId) => {
    const { draftId, adId } = req.params as { draftId: string; adId: string };
    const body = (req.body ?? {}) as { instructions?: string };
    await requireTokensFor(ctx, client, orgId);
    await regenerateDraftAd(deps, client, orgId, account, draftId, adId, req.userId!, body.instructions?.slice(0, 1000));
    return { draft: await loadDraft(client, account.id, draftId) };
  }));

  // ---- creatives (images, sitelinks, callouts) ----------------------------

  for (const decision of ["approve", "reject"] as const) {
    app.post(`${base}/orgs/:orgId/drafts/:draftId/creatives/:assetId/${decision}`, async (req) => withAccount(req, async (client, account) => {
      const { draftId, assetId } = req.params as { draftId: string; assetId: string };
      const body = (req.body ?? {}) as { reason?: string };
      await decideDraftAsset(client, account as never, draftId, assetId, decision, req.userId!, body.reason);
      return { draft: await loadDraft(client, account.id, draftId) };
    }));
  }

  app.patch(`${base}/orgs/:orgId/drafts/:draftId/creatives/:assetId`, async (req) => withAccount(req, async (client, account) => {
    const { draftId, assetId } = req.params as { draftId: string; assetId: string };
    const input = GoogleAdsDraftAssetPatchInput.parse(req.body);
    const validation = await patchDraftAsset(client, account as never, draftId, assetId, input, req.userId!);
    return { validation, draft: await loadDraft(client, account.id, draftId) };
  }));

  /** Re-renders one image (with optional guidance). Runs inline — one
   *  picture — so the reviewer sees the new one when the call returns. */
  app.post(`${base}/orgs/:orgId/drafts/:draftId/creatives/:assetId/regenerate`, async (req) => {
    const { draftId, assetId } = req.params as { draftId: string; assetId: string };
    const body = (req.body ?? {}) as { instructions?: string };
    const { account, orgId } = await withAccount(req, async (client, account, orgId) => {
      await requireTokensFor(ctx, client, orgId);
      const { rows } = await client.query(`SELECT id FROM google_ads_drafts WHERE id = $1 AND account_id = $2`, [draftId, account.id]);
      if (!rows[0]) throw new HttpError(404, "Draft not found");
      return { account, orgId };
    });
    const stats = await regenerateImageAsset(deps, orgId, account as never, draftId, assetId, req.userId!, body.instructions?.slice(0, 1000)).catch(translateAdsError);
    return withAccount(req, async (client, acc) => ({ stats, draft: await loadDraft(client, acc.id, draftId) }));
  });

  /** The rendered image itself, for the review workspace. */
  app.get(`${base}/orgs/:orgId/drafts/:draftId/creatives/:assetId/content`, async (req, reply) => {
    const { draftId, assetId } = req.params as { draftId: string; assetId: string };
    const row = await withAccount(req, async (client, account) => {
      const { rows } = await client.query(`SELECT storage_key, mime FROM google_ads_draft_assets WHERE id = $1 AND draft_id = $2 AND account_id = $3`, [assetId, draftId, account.id]);
      return rows[0] ?? null;
    });
    if (!row?.storage_key) throw new HttpError(404, "No image rendered for this creative");
    const bytes = await deps.storage.get(row.storage_key);
    return reply.header("content-type", row.mime ?? "image/png").header("cache-control", "private, max-age=300").send(bytes);
  });

  // ---- publishing --------------------------------------------------------

  app.get(`${base}/orgs/:orgId/drafts/:draftId/publish-preview`, async (req) => withAccount(req, async (client, account, orgId) => {
    const { draftId } = req.params as { draftId: string };
    return { preview: await publishPreview(client, account, draftId, await orgName(orgId)) };
  }));

  app.post(`${base}/orgs/:orgId/drafts/:draftId/publish`, async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const input = GoogleAdsPublishInput.parse(req.body);
    const job = await withAccount(req, async (client, account, orgId) => requestPublish(deps, client, account, draftId, req.userId!, input, await orgName(orgId)));
    return reply.status(202).send({ job });
  });

  app.get(`${base}/orgs/:orgId/publish-jobs/:jobId`, async (req) => withAccount(req, async (client, account) => {
    const { jobId } = req.params as { jobId: string };
    const { rows } = await client.query(`SELECT * FROM google_ads_publish_jobs WHERE id = $1 AND account_id = $2`, [jobId, account.id]);
    if (!rows[0]) throw new HttpError(404, "Job not found");
    return { job: jobView(rows[0]) };
  }));
}

/** The billing gate for AI calls made by an administrator on an
 *  organization's behalf: the organization pays, so its balance applies. */
async function requireTokensFor(_ctx: AppContext, client: PoolClient, orgId: string): Promise<void> {
  const state = await billingState(client, orgId);
  if (state.blocked) throw new HttpError(402, "This organization is out of tokens; top up or mark it exempt before generating.", { code: "payment_required", tokenBalance: state.tokenBalance });
}
