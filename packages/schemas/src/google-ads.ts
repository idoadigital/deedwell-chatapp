import { z } from "zod";

// ---------------------------------------------------------------------------
// Google Ads — model output contracts. Both are proposals for human review;
// neither can reach Google Ads without an administrator's approval and an
// explicit publish confirmation.
// ---------------------------------------------------------------------------

export const GoogleAdsStrategyOutput = z.object({
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(1200),
  audiences: z.array(z.object({ name: z.string().min(1).max(120), description: z.string().max(600) })).min(1).max(8),
  themes: z.array(z.object({ name: z.string().min(1).max(120), description: z.string().max(600) })).min(1).max(8),
  campaigns: z.array(z.object({
    name: z.string().min(1).max(120),
    objective: z.string().max(600),
    landingPage: z.string().max(500),
    keywordThemes: z.array(z.string().min(1).max(120)).max(12),
    adGroupIdeas: z.array(z.string().min(1).max(160)).max(12),
  })).min(1).max(8),
  landingPages: z.array(z.object({
    url: z.string().max(500), purpose: z.string().max(300), recommendations: z.array(z.string().max(300)).max(8),
  })).max(12),
  keywordThemes: z.array(z.object({ theme: z.string().min(1).max(120), examples: z.array(z.string().min(1).max(80)).max(12) })).max(16),
  negativeKeywords: z.array(z.string().min(1).max(80)).max(60),
  conversionGoals: z.array(z.object({ name: z.string().min(1).max(120), howToTrack: z.string().max(300) })).max(8),
  budget: z.object({ monthlyUsd: z.number().nonnegative().max(1_000_000), rationale: z.string().max(600) }).nullable(),
  opportunities: z.array(z.string().max(400)).max(12),
  adGrantsNotes: z.array(z.string().max(400)).max(12),
});
export type GoogleAdsStrategyOutput = z.infer<typeof GoogleAdsStrategyOutput>;

export const GoogleAdsKeywordMatchType = z.enum(["BROAD", "PHRASE", "EXACT"]);

export const GoogleAdsResponsiveSearchAd = z.object({
  title: z.string().min(1).max(120),
  // Soft limits: Google's real limits (30/90/15) are enforced by validateDraft
  // before approval; a slightly long line reaches the review UI with its
  // counter instead of failing the whole generation.
  headlines: z.array(z.string().min(1).max(60)).min(3).max(15),
  descriptions: z.array(z.string().min(1).max(150)).min(2).max(4),
  finalUrl: z.string().max(500),
  path1: z.string().max(30).nullable().optional(),
  path2: z.string().max(30).nullable().optional(),
  rationale: z.string().max(600).nullable().optional(),
});
export type GoogleAdsResponsiveSearchAd = z.infer<typeof GoogleAdsResponsiveSearchAd>;

export const GoogleAdsCampaignDraftOutput = z.object({
  name: z.string().min(1).max(255),
  objective: z.string().min(1).max(600),
  landingPage: z.string().max(500),
  dailyBudgetMicros: z.number().int().positive().max(100_000_000_000),
  geoTargets: z.array(z.string().min(1).max(120)).max(20),
  negativeKeywords: z.array(z.string().min(1).max(80)).max(100),
  adGroups: z.array(z.object({
    name: z.string().min(1).max(255),
    keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: GoogleAdsKeywordMatchType })).min(1).max(50),
    negativeKeywords: z.array(z.string().min(1).max(80)).max(50),
    ads: z.array(GoogleAdsResponsiveSearchAd).min(1).max(3),
  })).min(1).max(10),
  rationale: z.string().max(1500),
});
export type GoogleAdsCampaignDraftOutput = z.infer<typeof GoogleAdsCampaignDraftOutput>;

// ---- API inputs ------------------------------------------------------------

export const GoogleAdsSelectAccountInput = z.object({
  customerId: z.string().regex(/^[0-9-]{10,12}$/),
});

export const GoogleAdsStrategyPatchInput = z.object({
  title: z.string().min(1).max(160).optional(),
  content: GoogleAdsStrategyOutput.omit({ title: true }).partial().optional(),
});

export const GoogleAdsDraftAdPatchInput = z.object({
  title: z.string().min(1).max(120).optional(),
  headlines: z.array(z.string().max(60)).max(15).optional(),
  descriptions: z.array(z.string().max(150)).max(4).optional(),
  finalUrl: z.string().max(500).optional(),
  path1: z.string().max(30).nullable().optional(),
  path2: z.string().max(30).nullable().optional(),
});

export const GoogleAdsDraftPatchInput = z.object({
  name: z.string().min(1).max(255).optional(),
  content: z.object({
    objective: z.string().max(600).optional(),
    landingPage: z.string().max(500).optional(),
    dailyBudgetMicros: z.number().int().positive().optional(),
    geoTargets: z.array(z.string().max(120)).max(20).optional(),
    negativeKeywords: z.array(z.string().max(80)).max(100).optional(),
    adGroups: z.array(z.object({
      key: z.string().min(1).max(40),
      name: z.string().min(1).max(255),
      keywords: z.array(z.object({ text: z.string().max(80), matchType: GoogleAdsKeywordMatchType })).max(50),
      negativeKeywords: z.array(z.string().max(80)).max(50),
    })).max(10).optional(),
  }).optional(),
});

export const GoogleAdsPublishInput = z.object({
  /** The administrator re-types the campaign name in the confirmation modal. */
  confirmName: z.string().min(1).max(255),
  /** Campaigns are created paused unless the administrator explicitly opts in. */
  enableOnPublish: z.boolean().default(false),
});

export const GoogleAdsCampaignStatusInput = z.object({
  status: z.enum(["ENABLED", "PAUSED"]),
  confirmation: z.literal("CONFIRM"),
});

export const GoogleAdsBudgetInput = z.object({
  dailyBudgetMicros: z.number().int().positive().max(100_000_000_000),
  confirmation: z.literal("CONFIRM"),
});

export const GoogleAdsComplianceRulePatchInput = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().nullable().optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
});

export const GoogleAdsPlatformSettingsInput = z.object({
  developerToken: z.string().min(8).max(200).optional(),
  managerCustomerId: z.string().regex(/^[0-9-]{10,12}$/).nullable().optional(),
  apiVersion: z.string().regex(/^v\d{1,3}$/).optional(),
});
