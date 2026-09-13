/**
 * Read-side synchronization: campaigns, ad groups, ads (with policy status),
 * keywords and daily metrics are copied into the tenant's snapshot tables so
 * pages render from Postgres and Google is asked at most every few hours (or
 * on an explicit "Sync now").
 */
import { uuidv7, withContext } from "@deedwell/database";
import {
  AD_GROUPS_QUERY, ADS_QUERY, CAMPAIGNS_QUERY, GoogleAdsApiError, KEYWORDS_QUERY, NEGATIVE_CAMPAIGN_KEYWORDS_QUERY,
  mapAd, mapAdGroup, mapCampaign, mapCampaignNegative, mapKeyword, mapMetric, metricsQuery,
  type DailyMetric,
} from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { GoogleAdsAccessError, accessFor } from "./access.js";
import { emitOrgEvent, loadAccountById, logActivity, setAccountStatus, type AccountRow } from "./store.js";

export const SYNC_METRIC_DAYS = Number(process.env.GOOGLE_ADS_METRIC_DAYS ?? 120);

export interface SyncStats { campaigns: number; adGroups: number; ads: number; keywords: number; metricRows: number }

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Runs inside a tenant transaction: the caller owns the context. */
export async function syncAccountNow(deps: Deps, client: PoolClient, account: AccountRow, actorUserId: string | null = null, opts: { days?: number } = {}): Promise<SyncStats> {
  const tenantId: string = account.tenant_id;
  const access = await accessFor(deps, client, account, actorUserId);
  const cid = access.customerId;
  const api = access.client;
  const stats: SyncStats = { campaigns: 0, adGroups: 0, ads: 0, keywords: 0, metricRows: 0 };

  const campaigns = (await api.searchStream(cid, CAMPAIGNS_QUERY)).map(mapCampaign);
  for (const c of campaigns) {
    await client.query(
      `INSERT INTO google_ads_campaigns (id, tenant_id, account_id, campaign_id, name, status, serving_status, advertising_channel_type,
              bidding_strategy_type, budget_resource, budget_micros, start_date, end_date, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (account_id, campaign_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, serving_status = EXCLUDED.serving_status,
              advertising_channel_type = EXCLUDED.advertising_channel_type, bidding_strategy_type = EXCLUDED.bidding_strategy_type,
              budget_resource = EXCLUDED.budget_resource, budget_micros = EXCLUDED.budget_micros, start_date = EXCLUDED.start_date,
              end_date = EXCLUDED.end_date, raw = EXCLUDED.raw, synced_at = now()`,
      [uuidv7(), tenantId, account.id, c.campaignId, c.name, c.status, c.servingStatus, c.advertisingChannelType, c.biddingStrategyType,
        c.budgetResource, c.budgetMicros, c.startDate ? c.startDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : null,
        c.endDate ? c.endDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : null, JSON.stringify(c.raw)]);
    stats.campaigns++;
  }

  const adGroups = (await api.searchStream(cid, AD_GROUPS_QUERY)).map(mapAdGroup);
  for (const g of adGroups) {
    await client.query(
      `INSERT INTO google_ads_ad_groups (id, tenant_id, account_id, ad_group_id, campaign_id, name, status, type, cpc_bid_micros, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (account_id, ad_group_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, name = EXCLUDED.name, status = EXCLUDED.status,
              type = EXCLUDED.type, cpc_bid_micros = EXCLUDED.cpc_bid_micros, raw = EXCLUDED.raw, synced_at = now()`,
      [uuidv7(), tenantId, account.id, g.adGroupId, g.campaignId, g.name, g.status, g.type, g.cpcBidMicros, JSON.stringify(g.raw)]);
    stats.adGroups++;
  }

  const ads = (await api.searchStream(cid, ADS_QUERY)).map(mapAd);
  for (const a of ads) {
    await client.query(
      `INSERT INTO google_ads_ads (id, tenant_id, account_id, ad_id, ad_group_id, campaign_id, ad_type, status, name, headlines, descriptions,
              final_urls, paths, approval_status, review_status, policy_topics, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (account_id, ad_id) DO UPDATE SET ad_group_id = EXCLUDED.ad_group_id, campaign_id = EXCLUDED.campaign_id, ad_type = EXCLUDED.ad_type,
              status = EXCLUDED.status, name = EXCLUDED.name, headlines = EXCLUDED.headlines, descriptions = EXCLUDED.descriptions,
              final_urls = EXCLUDED.final_urls, paths = EXCLUDED.paths, approval_status = EXCLUDED.approval_status,
              review_status = EXCLUDED.review_status, policy_topics = EXCLUDED.policy_topics, raw = EXCLUDED.raw, synced_at = now()`,
      [uuidv7(), tenantId, account.id, a.adId, a.adGroupId, a.campaignId, a.adType, a.status, a.name, JSON.stringify(a.headlines),
        JSON.stringify(a.descriptions), JSON.stringify(a.finalUrls), JSON.stringify(a.paths), a.approvalStatus, a.reviewStatus,
        JSON.stringify(a.policyTopics), JSON.stringify(a.raw)]);
    stats.ads++;
  }

  const keywords = [
    ...(await api.searchStream(cid, KEYWORDS_QUERY)).map(mapKeyword),
    ...(await api.searchStream(cid, NEGATIVE_CAMPAIGN_KEYWORDS_QUERY)).map(mapCampaignNegative),
  ];
  await client.query(`DELETE FROM google_ads_keywords WHERE account_id = $1`, [account.id]);
  for (const k of keywords) {
    await client.query(
      `INSERT INTO google_ads_keywords (id, tenant_id, account_id, criterion_id, campaign_id, ad_group_id, text, match_type, status, negative, quality_score, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (account_id, campaign_id, ad_group_id, criterion_id) DO NOTHING`,
      [uuidv7(), tenantId, account.id, k.criterionId, k.campaignId, k.adGroupId, k.text, k.matchType, k.status, k.negative, k.qualityScore, JSON.stringify(k.raw)]);
    stats.keywords++;
  }

  const days = opts.days ?? SYNC_METRIC_DAYS;
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  for (const level of ["account", "campaign", "ad_group", "ad"] as DailyMetric["level"][]) {
    const rows = (await api.searchStream(cid, metricsQuery(level, isoDay(since), isoDay(until)))).map((r) => mapMetric(level, r));
    stats.metricRows += await upsertMetrics(client, tenantId, account.id, rows);
  }

  // Campaigns and ads that came from Deedwell drafts.
  await client.query(
    `UPDATE google_ads_campaigns c SET draft_id = d.id FROM google_ads_drafts d
      WHERE d.account_id = c.account_id AND d.published_campaign_id = c.campaign_id AND c.draft_id IS NULL`);
  await client.query(
    `UPDATE google_ads_ads a SET draft_ad_id = da.id FROM google_ads_draft_ads da
      WHERE da.account_id = a.account_id AND da.google_ad_id = a.ad_id AND a.draft_ad_id IS NULL`);

  await client.query(`UPDATE google_ads_accounts SET last_sync_at = now(), last_sync_error = NULL WHERE id = $1`, [account.id]);
  return stats;
}

async function upsertMetrics(client: PoolClient, tenantId: string, accountId: string, rows: DailyMetric[]): Promise<number> {
  const clean = rows.filter((r) => r.entityId && r.day);
  const CHUNK = 400;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, idx) => {
      const base = idx * 10;
      values.push(tenantId, accountId, r.level, r.entityId, r.day, r.impressions, r.clicks, r.costMicros, r.conversions, r.conversionsValue);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},now())`;
    });
    await client.query(
      `INSERT INTO google_ads_metrics_daily (tenant_id, account_id, level, entity_id, day, impressions, clicks, cost_micros, conversions, conversions_value, synced_at)
       VALUES ${tuples.join(",")}
       ON CONFLICT (account_id, level, entity_id, day) DO UPDATE SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
              cost_micros = EXCLUDED.cost_micros, conversions = EXCLUDED.conversions, conversions_value = EXCLUDED.conversions_value, synced_at = now()`,
      values);
  }
  return clean.length;
}

/** Full sync in its own tenant transaction, recording the outcome on the
 *  account row. Errors are absorbed into `last_sync_error` / status. */
export async function syncAccount(deps: Deps, tenantId: string, accountId: string, actorUserId: string | null = null): Promise<{ ok: boolean; stats?: SyncStats; error?: string }> {
  return withContext(deps.appPool, { tenantId, userId: actorUserId }, async (client) => {
    const account = await loadAccountById(client, tenantId, accountId);
    if (!account || account.status === "disconnected") return { ok: false, error: "Account is not connected." };
    try {
      const stats = await syncAccountNow(deps, client, account, actorUserId);
      await logActivity(client, { tenantId, accountId, customerId: account.customer_id, actorUserId, actorKind: actorUserId ? "user" : "system", action: "synced", summary: `${stats.campaigns} campaigns, ${stats.ads} ads, ${stats.metricRows} metric rows`, metadata: stats as unknown as Record<string, unknown> });
      emitOrgEvent(deps, tenantId, "google_ads:synced", { accountId });
      return { ok: true, stats };
    } catch (err) {
      const message = (err as Error).message;
      let status = account.status;
      if (err instanceof GoogleAdsApiError && err.code === "unauthenticated") status = "authorization_expired";
      if (err instanceof GoogleAdsAccessError && (err.code === "expired" || err.code === "missing_scopes" || err.code === "not_connected")) status = "authorization_expired";
      if (err instanceof GoogleAdsApiError && err.code === "permission_denied" && account.manager_link_status === "active") {
        status = "manager_link_pending";
        await client.query(`UPDATE google_ads_accounts SET manager_link_status = 'inactive' WHERE id = $1`, [accountId]);
      }
      await client.query(`UPDATE google_ads_accounts SET last_sync_error = $2, status = $3, status_detail = CASE WHEN $3 <> status THEN $2 ELSE status_detail END WHERE id = $1`, [accountId, message, status]);
      await logActivity(client, { tenantId, accountId, customerId: account.customer_id, actorUserId, actorKind: "system", action: "sync_failed", previousState: account.status, newState: status, summary: message });
      return { ok: false, error: message };
    }
  });
}
