/** Shared shapes for drafts, strategies and snapshots. Stored as jsonb. */

export type KeywordMatchType = "BROAD" | "PHRASE" | "EXACT";

export interface DraftKeyword { text: string; matchType: KeywordMatchType }

export interface DraftAdGroup {
  /** Stable key linking google_ads_draft_ads rows to their ad group. */
  key: string;
  name: string;
  keywords: DraftKeyword[];
  negativeKeywords: string[];
  cpcBidMicros?: number | null;
}

export interface DraftContent {
  objective: string;
  channelType: "SEARCH";
  landingPage: string;
  dailyBudgetMicros: number;
  currencyCode: string;
  adGroups: DraftAdGroup[];
  negativeKeywords: string[];
  geoTargets: string[];
  rationale: string;
}

export interface DraftAdContent {
  adGroupKey: string;
  title: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
  path1?: string | null;
  path2?: string | null;
  rationale?: string | null;
}

export interface StrategyContent {
  objective: string;
  audiences: Array<{ name: string; description: string }>;
  themes: Array<{ name: string; description: string }>;
  campaigns: Array<{ name: string; objective: string; landingPage: string; keywordThemes: string[]; adGroupIdeas: string[] }>;
  landingPages: Array<{ url: string; purpose: string; recommendations: string[] }>;
  keywordThemes: Array<{ theme: string; examples: string[] }>;
  negativeKeywords: string[];
  conversionGoals: Array<{ name: string; howToTrack: string }>;
  budget: { monthlyUsd: number; rationale: string } | null;
  opportunities: string[];
  adGrantsNotes: string[];
}

export interface CampaignSnapshot {
  campaignId: string;
  name: string;
  status: string;
  servingStatus: string | null;
  advertisingChannelType: string | null;
  biddingStrategyType: string | null;
  budgetResource: string | null;
  budgetMicros: number | null;
  startDate: string | null;
  endDate: string | null;
  raw: Record<string, unknown>;
}

export interface AdGroupSnapshot {
  adGroupId: string; campaignId: string; name: string; status: string; type: string | null; cpcBidMicros: number | null; raw: Record<string, unknown>;
}

export interface AdSnapshot {
  adId: string; adGroupId: string; campaignId: string; adType: string | null; status: string; name: string | null;
  headlines: string[]; descriptions: string[]; finalUrls: string[]; paths: string[];
  approvalStatus: string | null; reviewStatus: string | null; policyTopics: Array<Record<string, unknown>>; raw: Record<string, unknown>;
}

export interface KeywordSnapshot {
  criterionId: string; campaignId: string; adGroupId: string | null; text: string; matchType: string | null; status: string | null;
  negative: boolean; qualityScore: number | null; raw: Record<string, unknown>;
}

export interface DailyMetric {
  level: "account" | "campaign" | "ad_group" | "ad";
  entityId: string;
  day: string; // YYYY-MM-DD
  impressions: number; clicks: number; costMicros: number; conversions: number; conversionsValue: number;
}
