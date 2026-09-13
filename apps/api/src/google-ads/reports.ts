/** Read models for the customer page and the admin workspace — all from the
 *  snapshot tables, never from Google on a page render. */
import type { PoolClient } from "pg";

export type RangeKey = "7d" | "30d" | "90d" | "this_month" | "last_month" | "custom";

export interface DateRange { key: RangeKey; since: string; until: string; prevSince: string; prevUntil: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export function resolveRange(params: { range?: string; from?: string; to?: string }, now = new Date()): DateRange {
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const key = (params.range ?? "30d") as RangeKey;
  let since: Date; let until: Date = today;
  switch (key) {
    case "7d": since = addDays(today, -6); break;
    case "90d": since = addDays(today, -89); break;
    case "this_month": since = utc(today.getUTCFullYear(), today.getUTCMonth(), 1); break;
    case "last_month": since = utc(today.getUTCFullYear(), today.getUTCMonth() - 1, 1); until = addDays(utc(today.getUTCFullYear(), today.getUTCMonth(), 1), -1); break;
    case "custom": {
      const from = params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? new Date(`${params.from}T00:00:00Z`) : addDays(today, -29);
      const to = params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? new Date(`${params.to}T00:00:00Z`) : today;
      since = from <= to ? from : to; until = from <= to ? to : from;
      if (until.getTime() - since.getTime() > 366 * 86_400_000) since = addDays(until, -365);
      break;
    }
    default: since = addDays(today, -29);
  }
  const span = Math.round((until.getTime() - since.getTime()) / 86_400_000) + 1;
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -(span - 1));
  return { key: (["7d", "30d", "90d", "this_month", "last_month", "custom"].includes(key) ? key : "30d") as RangeKey, since: iso(since), until: iso(until), prevSince: iso(prevSince), prevUntil: iso(prevUntil) };
}

export interface Totals { impressions: number; clicks: number; costMicros: number; conversions: number; conversionsValue: number }

export function derive(t: Totals) {
  const cost = t.costMicros / 1_000_000;
  return {
    impressions: t.impressions, clicks: t.clicks, cost, conversions: t.conversions, conversionsValue: t.conversionsValue,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    conversionRate: t.clicks > 0 ? (t.conversions / t.clicks) * 100 : null,
    costPerConversion: t.conversions > 0 ? cost / t.conversions : null,
    averageCpc: t.clicks > 0 ? cost / t.clicks : null,
  };
}

const zero = (): Totals => ({ impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionsValue: 0 });
const rowTotals = (r: Record<string, any>): Totals => ({
  impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), costMicros: Number(r.cost_micros ?? 0),
  conversions: Number(r.conversions ?? 0), conversionsValue: Number(r.conversions_value ?? 0),
});

async function totalsFor(client: PoolClient, accountId: string, level: string, entityId: string | null, since: string, until: string): Promise<Totals> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(cost_micros),0) cost_micros,
            COALESCE(SUM(conversions),0) conversions, COALESCE(SUM(conversions_value),0) conversions_value
       FROM google_ads_metrics_daily
      WHERE account_id = $1 AND level = $2 AND ($3::text IS NULL OR entity_id = $3) AND day BETWEEN $4 AND $5`,
    [accountId, level, entityId, since, until]);
  return rows[0] ? rowTotals(rows[0]) : zero();
}

export function compare(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export async function seriesFor(client: PoolClient, accountId: string, level: string, entityId: string | null, range: DateRange) {
  const { rows } = await client.query(
    `SELECT day, SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
       FROM google_ads_metrics_daily
      WHERE account_id = $1 AND level = $2 AND ($3::text IS NULL OR entity_id = $3) AND day BETWEEN $4 AND $5
      GROUP BY day ORDER BY day`,
    [accountId, level, entityId, range.since, range.until]);
  const byDay = new Map(rows.map((r) => [iso(new Date(r.day)), rowTotals(r)]));
  const out: Array<{ day: string } & ReturnType<typeof derive>> = [];
  for (let d = new Date(`${range.since}T00:00:00Z`); iso(d) <= range.until; d = addDays(d, 1)) {
    out.push({ day: iso(d), ...derive(byDay.get(iso(d)) ?? zero()) });
  }
  return out;
}

export async function overview(client: PoolClient, account: Record<string, any>, range: DateRange) {
  const current = await totalsFor(client, account.id, "account", "account", range.since, range.until);
  const previous = await totalsFor(client, account.id, "account", "account", range.prevSince, range.prevUntil);
  const c = derive(current); const p = derive(previous);
  const kpi = (key: keyof typeof c) => ({ value: c[key], previous: p[key], change: compare(c[key], p[key]) });
  const { rows: counts } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ENABLED') AS enabled, COUNT(*) FILTER (WHERE status = 'PAUSED') AS paused, COUNT(*) AS total
       FROM google_ads_campaigns WHERE account_id = $1 AND status <> 'REMOVED'`, [account.id]);
  return {
    range,
    currencyCode: account.currency_code ?? "USD",
    kpis: {
      impressions: kpi("impressions"), clicks: kpi("clicks"), ctr: kpi("ctr"), cost: kpi("cost"), conversions: kpi("conversions"),
      conversionRate: kpi("conversionRate"), costPerConversion: kpi("costPerConversion"), conversionsValue: kpi("conversionsValue"),
    },
    series: await seriesFor(client, account.id, "account", "account", range),
    campaignCounts: { enabled: Number(counts[0]?.enabled ?? 0), paused: Number(counts[0]?.paused ?? 0), total: Number(counts[0]?.total ?? 0) },
    lastSyncAt: account.last_sync_at ?? null,
  };
}

export async function campaignsWithMetrics(client: PoolClient, account: Record<string, any>, range: DateRange, status?: string) {
  const { rows } = await client.query(
    `SELECT c.*, m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value,
            d.name AS draft_name, d.status AS draft_status
       FROM google_ads_campaigns c
       LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = c.account_id AND md.level = 'campaign' AND md.entity_id = c.campaign_id AND md.day BETWEEN $2 AND $3
       ) m ON true
       LEFT JOIN google_ads_drafts d ON d.id = c.draft_id
      WHERE c.account_id = $1 AND ($4::text IS NULL OR c.status = $4)
      ORDER BY (c.status = 'ENABLED') DESC, COALESCE(m.cost_micros, 0) DESC, c.name`,
    [account.id, range.since, range.until, status && status !== "ALL" ? status : null]);
  return rows.map(campaignView);
}

export function campaignView(r: Record<string, any>) {
  return {
    id: r.campaign_id, name: r.name, status: r.status, servingStatus: r.serving_status, channelType: r.advertising_channel_type,
    biddingStrategy: r.bidding_strategy_type, dailyBudget: r.budget_micros != null ? Number(r.budget_micros) / 1_000_000 : null,
    startDate: r.start_date, endDate: r.end_date, managedByDeedwell: Boolean(r.draft_id), draftId: r.draft_id ?? null,
    metrics: derive(rowTotals(r)), syncedAt: r.synced_at,
  };
}

export async function campaignDetail(client: PoolClient, account: Record<string, any>, campaignId: string, range: DateRange) {
  const [campaign] = await campaignsWithMetrics(client, account, range).then((list) => list.filter((c) => c.id === campaignId));
  if (!campaign) return null;
  const { rows: groups } = await client.query(
    `SELECT g.*, m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value
       FROM google_ads_ad_groups g
       LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = g.account_id AND md.level = 'ad_group' AND md.entity_id = g.ad_group_id AND md.day BETWEEN $3 AND $4
       ) m ON true
      WHERE g.account_id = $1 AND g.campaign_id = $2 ORDER BY g.name`, [account.id, campaignId, range.since, range.until]);
  const { rows: keywords } = await client.query(
    `SELECT * FROM google_ads_keywords WHERE account_id = $1 AND campaign_id = $2 ORDER BY negative, ad_group_id, text`, [account.id, campaignId]);
  const ads = await adsForCampaign(client, account, campaignId, range);
  return {
    campaign,
    adGroups: groups.map((g) => ({ id: g.ad_group_id, name: g.name, status: g.status, type: g.type, cpcBid: g.cpc_bid_micros != null ? Number(g.cpc_bid_micros) / 1_000_000 : null, metrics: derive(rowTotals(g)) })),
    keywords: keywords.map((k) => ({ id: k.criterion_id, adGroupId: k.ad_group_id, text: k.text, matchType: k.match_type, status: k.status, negative: k.negative, qualityScore: k.quality_score })),
    ads,
    series: await seriesFor(client, account.id, "campaign", campaignId, range),
  };
}

async function adsForCampaign(client: PoolClient, account: Record<string, any>, campaignId: string, range: DateRange) {
  const { rows } = await client.query(
    `SELECT a.*, g.name AS ad_group_name, m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value
       FROM google_ads_ads a
       LEFT JOIN google_ads_ad_groups g ON g.account_id = a.account_id AND g.ad_group_id = a.ad_group_id
       LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = a.account_id AND md.level = 'ad' AND md.entity_id = a.ad_id AND md.day BETWEEN $3 AND $4
       ) m ON true
      WHERE a.account_id = $1 AND a.campaign_id = $2 ORDER BY a.status, a.ad_id`, [account.id, campaignId, range.since, range.until]);
  return rows.map((a) => ({
    id: a.ad_id, adGroupId: a.ad_group_id, adGroupName: a.ad_group_name, type: a.ad_type, status: a.status, headlines: a.headlines, descriptions: a.descriptions,
    finalUrls: a.final_urls, approvalStatus: a.approval_status, reviewStatus: a.review_status, policyTopics: a.policy_topics,
    managedByDeedwell: Boolean(a.draft_ad_id), metrics: derive(rowTotals(a)),
  }));
}

/** The customer-facing state for a Deedwell-created ad, folding in what
 *  Google says once it is live. */
export function deedwellAdState(draftStatus: string, live: { status: string | null; approvalStatus: string | null } | null): string {
  if (draftStatus === "published" && live) {
    if (live.approvalStatus && live.approvalStatus !== "APPROVED" && live.approvalStatus !== "APPROVED_LIMITED") return "google_rejected";
    if (live.status === "PAUSED") return "paused";
    if (live.status === "REMOVED") return "removed";
    return "published";
  }
  return draftStatus; // draft | awaiting_approval | approved | rejected | publishing | published | failed
}

/** "Ads created by Deedwell": every draft ad with its live counterpart. */
export async function deedwellAds(client: PoolClient, account: Record<string, any>, range: DateRange) {
  const { rows } = await client.query(
    `SELECT da.*, d.name AS campaign_name, d.status AS draft_campaign_status, d.published_campaign_id, d.content AS draft_content,
            creator.display_name AS created_by_name, approver.display_name AS approved_by_name,
            a.status AS live_status, a.approval_status AS live_approval_status, a.review_status AS live_review_status, a.policy_topics AS live_policy_topics,
            g.name AS live_ad_group_name, c.name AS live_campaign_name,
            m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value
       FROM google_ads_draft_ads da
       JOIN google_ads_drafts d ON d.id = da.draft_id
       LEFT JOIN users creator ON creator.id = da.created_by
       LEFT JOIN users approver ON approver.id = da.approved_by
       LEFT JOIN google_ads_ads a ON a.account_id = da.account_id AND a.ad_id = da.google_ad_id
       LEFT JOIN google_ads_ad_groups g ON g.account_id = da.account_id AND g.ad_group_id = da.google_ad_group_id
       LEFT JOIN google_ads_campaigns c ON c.account_id = da.account_id AND c.campaign_id = da.google_campaign_id
       LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = da.account_id AND md.level = 'ad' AND md.entity_id = da.google_ad_id AND md.day BETWEEN $2 AND $3
       ) m ON true
      WHERE da.account_id = $1
      ORDER BY da.created_at DESC, da.position`, [account.id, range.since, range.until]);
  return rows.map((r) => {
    const groups = (r.draft_content?.adGroups ?? []) as Array<{ key: string; name: string }>;
    const live = r.google_ad_id ? { status: r.live_status ?? null, approvalStatus: r.live_approval_status ?? null } : null;
    return {
      id: r.id, draftId: r.draft_id, title: r.title, adType: r.ad_type,
      campaign: r.live_campaign_name ?? r.campaign_name, adGroup: r.live_ad_group_name ?? groups.find((g) => g.key === r.ad_group_key)?.name ?? r.ad_group_key,
      headlines: r.headlines, descriptions: r.descriptions, finalUrl: r.final_url, path1: r.path1, path2: r.path2,
      createdAt: r.created_at, createdBy: r.created_by_name ? `${r.created_by_name} (Deedwell)` : "Deedwell AI",
      approvalState: r.status, approvedBy: r.approved_by_name ?? null, approvedAt: r.approved_at, rejectedReason: r.rejected_reason,
      state: deedwellAdState(r.status, live),
      google: r.google_ad_id ? { adId: r.google_ad_id, status: r.live_status, approvalStatus: r.live_approval_status, reviewStatus: r.live_review_status, policyTopics: r.live_policy_topics ?? [] } : null,
      metrics: r.google_ad_id ? derive(rowTotals(r)) : null,
    };
  });
}

/** Admin list: every connected organization with 30-day totals. Runs on the
 *  admin pool because it spans tenants. */
export async function accountsAcrossTenants(pool: { query: PoolClient["query"] }, range: DateRange) {
  const { rows } = await pool.query(
    `SELECT a.*, o.name AS org_name, o.slug AS org_slug,
            (SELECT COUNT(*) FROM google_ads_campaigns c WHERE c.account_id = a.id AND c.status = 'ENABLED') AS active_campaigns,
            m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value
       FROM google_ads_accounts a
       JOIN organizations o ON o.id = a.tenant_id
       LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = a.id AND md.level = 'account' AND md.day BETWEEN $1 AND $2
       ) m ON true
      WHERE a.status <> 'disconnected'
      ORDER BY o.name`, [range.since, range.until]);
  return rows.map((r) => ({
    orgId: r.tenant_id, orgName: r.org_name, orgSlug: r.org_slug, accountId: r.id, accountName: r.descriptive_name,
    customerId: r.customer_id, status: r.status, statusDetail: r.status_detail, managerLinkStatus: r.manager_link_status,
    accountKind: r.account_kind, currencyCode: r.currency_code, activeCampaigns: Number(r.active_campaigns ?? 0),
    metrics: derive(rowTotals(r)), lastSyncAt: r.last_sync_at, lastSyncError: r.last_sync_error, connectedAt: r.connected_at,
  }));
}
