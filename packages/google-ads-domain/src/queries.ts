/** GAQL for the read-side sync, plus mappers from REST rows to snapshots. */
import type { AdGroupSnapshot, AdSnapshot, CampaignSnapshot, DailyMetric, KeywordSnapshot } from "./types.js";
import { normalizeCustomerId } from "./client.js";

const idOf = (resource: unknown): string => String(resource ?? "").split("/").pop() ?? "";
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export const CAMPAIGNS_QUERY = `
  SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
         campaign.advertising_channel_type, campaign.bidding_strategy_type,
         campaign.campaign_budget, campaign.start_date, campaign.end_date,
         campaign_budget.amount_micros
    FROM campaign
   WHERE campaign.status != 'REMOVED' OR campaign.status = 'REMOVED'`;

export const AD_GROUPS_QUERY = `
  SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ad_group.campaign
    FROM ad_group`;

export const ADS_QUERY = `
  SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
         ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
         ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1,
         ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.policy_summary.approval_status,
         ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries,
         ad_group_ad.ad_group, ad_group.campaign
    FROM ad_group_ad`;

export const KEYWORDS_QUERY = `
  SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
         ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.quality_info.quality_score,
         ad_group_criterion.ad_group, ad_group.campaign
    FROM ad_group_criterion
   WHERE ad_group_criterion.type = 'KEYWORD'`;

export const NEGATIVE_CAMPAIGN_KEYWORDS_QUERY = `
  SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type,
         campaign_criterion.status, campaign_criterion.negative, campaign_criterion.campaign
    FROM campaign_criterion
   WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`;

const METRIC_FIELDS = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";

export function metricsQuery(level: DailyMetric["level"], since: string, until: string): string {
  const range = `segments.date BETWEEN '${since}' AND '${until}'`;
  switch (level) {
    case "account": return `SELECT segments.date, ${METRIC_FIELDS} FROM customer WHERE ${range}`;
    case "campaign": return `SELECT campaign.id, segments.date, ${METRIC_FIELDS} FROM campaign WHERE ${range}`;
    case "ad_group": return `SELECT ad_group.id, segments.date, ${METRIC_FIELDS} FROM ad_group WHERE ${range}`;
    case "ad": return `SELECT ad_group_ad.ad.id, segments.date, ${METRIC_FIELDS} FROM ad_group_ad WHERE ${range}`;
  }
}

export function mapCampaign(row: Record<string, any>): CampaignSnapshot {
  const c = row.campaign ?? {};
  return {
    campaignId: String(c.id ?? ""), name: String(c.name ?? ""), status: String(c.status ?? "UNKNOWN"),
    servingStatus: c.servingStatus ?? null, advertisingChannelType: c.advertisingChannelType ?? null,
    biddingStrategyType: c.biddingStrategyType ?? null, budgetResource: c.campaignBudget ?? null,
    budgetMicros: row.campaignBudget?.amountMicros != null ? Number(row.campaignBudget.amountMicros) : null,
    startDate: c.startDate ?? null, endDate: c.endDate ?? null, raw: row,
  };
}

export function mapAdGroup(row: Record<string, any>): AdGroupSnapshot {
  const g = row.adGroup ?? {};
  return {
    adGroupId: String(g.id ?? ""), campaignId: idOf(g.campaign), name: String(g.name ?? ""),
    status: String(g.status ?? "UNKNOWN"), type: g.type ?? null,
    cpcBidMicros: g.cpcBidMicros != null ? Number(g.cpcBidMicros) : null, raw: row,
  };
}

export function mapAd(row: Record<string, any>): AdSnapshot {
  const aga = row.adGroupAd ?? {};
  const ad = aga.ad ?? {};
  const rsa = ad.responsiveSearchAd ?? {};
  const texts = (assets: unknown): string[] => (Array.isArray(assets) ? assets.map((a: any) => String(a?.text ?? "")).filter(Boolean) : []);
  return {
    adId: String(ad.id ?? ""), adGroupId: idOf(aga.adGroup), campaignId: idOf(row.adGroup?.campaign),
    adType: ad.type ?? null, status: String(aga.status ?? "UNKNOWN"), name: ad.name ?? null,
    headlines: texts(rsa.headlines), descriptions: texts(rsa.descriptions),
    finalUrls: Array.isArray(ad.finalUrls) ? ad.finalUrls.map(String) : [],
    paths: [rsa.path1, rsa.path2].filter(Boolean).map(String),
    approvalStatus: aga.policySummary?.approvalStatus ?? null, reviewStatus: aga.policySummary?.reviewStatus ?? null,
    policyTopics: Array.isArray(aga.policySummary?.policyTopicEntries) ? aga.policySummary.policyTopicEntries : [],
    raw: row,
  };
}

export function mapKeyword(row: Record<string, any>): KeywordSnapshot {
  const k = row.adGroupCriterion ?? {};
  return {
    criterionId: String(k.criterionId ?? ""), campaignId: idOf(row.adGroup?.campaign), adGroupId: idOf(k.adGroup) || null,
    text: String(k.keyword?.text ?? ""), matchType: k.keyword?.matchType ?? null, status: k.status ?? null,
    negative: Boolean(k.negative), qualityScore: k.qualityInfo?.qualityScore != null ? Number(k.qualityInfo.qualityScore) : null, raw: row,
  };
}

export function mapCampaignNegative(row: Record<string, any>): KeywordSnapshot {
  const k = row.campaignCriterion ?? {};
  return {
    criterionId: String(k.criterionId ?? ""), campaignId: idOf(k.campaign), adGroupId: null,
    text: String(k.keyword?.text ?? ""), matchType: k.keyword?.matchType ?? null, status: k.status ?? null,
    negative: true, qualityScore: null, raw: row,
  };
}

export function mapMetric(level: DailyMetric["level"], row: Record<string, any>): DailyMetric {
  const m = row.metrics ?? {};
  const entityId = level === "account" ? "account"
    : level === "campaign" ? String(row.campaign?.id ?? "")
    : level === "ad_group" ? String(row.adGroup?.id ?? "")
    : String(row.adGroupAd?.ad?.id ?? "");
  return {
    level, entityId, day: String(row.segments?.date ?? ""),
    impressions: num(m.impressions), clicks: num(m.clicks), costMicros: num(m.costMicros),
    conversions: num(m.conversions), conversionsValue: num(m.conversionsValue),
  };
}

export const customerResource = (customerId: string): string => `customers/${normalizeCustomerId(customerId)}`;
