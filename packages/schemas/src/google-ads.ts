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

/** Campaign-level creatives. Soft limits again (Google: sitelink text 25,
 *  sitelink descriptions 35, callout 25) — validateAsset enforces the real
 *  ones before approval. */
export const GoogleAdsSitelink = z.object({
  linkText: z.string().min(1).max(50),
  description1: z.string().max(70).nullable().optional(),
  description2: z.string().max(70).nullable().optional(),
  finalUrl: z.string().max(500),
});
export const GoogleAdsImageCreative = z.object({
  title: z.string().min(1).max(120),
  /** The brief for the image model: subject, setting, mood, no text overlay. */
  prompt: z.string().min(10).max(1500),
  altText: z.string().max(200).nullable().optional(),
});

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
  sitelinks: z.array(GoogleAdsSitelink).max(8).default([]),
  callouts: z.array(z.string().min(1).max(50)).max(10).default([]),
  /** Briefs for the generated image creatives; the build job renders one
   *  landscape (1.91:1) and one square (1:1) picture per brief. */
  imageCreatives: z.array(GoogleAdsImageCreative).max(3).default([]),
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

export const GoogleAdsDraftAssetPatchInput = z.object({
  title: z.string().min(1).max(120).optional(),
  linkText: z.string().max(50).optional(),
  description1: z.string().max(70).nullable().optional(),
  description2: z.string().max(70).nullable().optional(),
  finalUrl: z.string().max(500).optional(),
  text: z.string().max(50).optional(),
  altText: z.string().max(200).nullable().optional(),
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

// ---------------------------------------------------------------------------
// Campaign requests — a customer asks Deedwell for a campaign; the Ad Grants
// account-manager agent assesses the request and drafts the plan; people
// approve every step after that.
// ---------------------------------------------------------------------------

export const GoogleAdsRequestGoal = z.enum(["service_access", "volunteering", "donations", "events", "membership", "education", "partnerships", "awareness", "other"]);
export type GoogleAdsRequestGoal = z.infer<typeof GoogleAdsRequestGoal>;

export const GoogleAdsRequestStatus = z.enum(["submitted", "in_review", "needs_info", "in_progress", "planned", "building", "live", "completed", "declined", "cancelled"]);
export type GoogleAdsRequestStatus = z.infer<typeof GoogleAdsRequestStatus>;

const short = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => short(max).optional().nullable().transform((v) => (v ? v : null));

/** What the customer fills in across the request steps. */
export const GoogleAdsCampaignRequestInput = z.object({
  title: z.string().trim().min(3).max(120),
  goal: GoogleAdsRequestGoal,
  priority: z.enum(["normal", "urgent"]).default("normal"),
  program: z.string().trim().min(3).max(1500),
  audience: z.string().trim().min(3).max(1000),
  desiredAction: z.string().trim().min(3).max(600),
  landingPage: optionalText(500),
  landingPageNotes: optionalText(600),
  geography: z.string().trim().min(1).max(400),
  languages: optionalText(200),
  timing: z.object({
    start: z.enum(["asap", "date"]).default("asap"),
    startDate: optionalText(20),
    ongoing: z.boolean().default(true),
    endDate: optionalText(20),
    notes: optionalText(400),
  }).default({ start: "asap", ongoing: true }),
  budget: z.object({
    preference: z.enum(["deedwell_decides", "share", "specific"]).default("deedwell_decides"),
    monthlyUsd: z.number().nonnegative().max(1_000_000).optional().nullable(),
    notes: optionalText(400),
  }).default({ preference: "deedwell_decides" }),
  keyMessages: optionalText(1200),
  keywordIdeas: optionalText(600),
  avoid: optionalText(800),
  notes: optionalText(1500),
  contact: z.object({ name: optionalText(120), email: optionalText(200), phone: optionalText(40) }).optional().nullable(),
});
export type GoogleAdsCampaignRequestInput = z.infer<typeof GoogleAdsCampaignRequestInput>;

export const GoogleAdsRequestAnswerInput = z.object({
  answers: z.array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) })).min(1).max(12),
});

export const GoogleAdsRequestCancelInput = z.object({ reason: optionalText(600) });

export const GoogleAdsRequestHandoffInput = z.object({
  instructions: optionalText(2000),
});

export const GoogleAdsRequestAskInput = z.object({
  questions: z.array(z.object({ question: z.string().trim().min(1).max(300), why: optionalText(300) })).min(1).max(8),
  message: optionalText(1000),
});

export const GoogleAdsRequestDecisionInput = z.object({
  status: z.enum(["in_review", "in_progress", "completed", "declined"]),
  message: optionalText(1000),
  reason: optionalText(600),
});

export const GoogleAdsRequestNotesInput = z.object({
  adminNotes: optionalText(4000),
  customerMessage: optionalText(1000),
});

/** The account-manager agent's answer to a request: an assessment, either
 *  questions for the nonprofit or a plan (an ordinary strategy that an
 *  administrator then approves), plus the measurement and utilization notes
 *  the management prompt asks for. Nothing here reaches Google Ads. */
export const GoogleAdsRequestPlanOutput = z.object({
  decision: z.enum(["proceed", "needs_info", "decline_recommended"]),
  /** For the nonprofit, in plain words: what was understood, what happens next. */
  customerSummary: z.string().min(1).max(1500),
  /** For the Deedwell administrator: findings, constraints, decisions needed. */
  adminSummary: z.string().min(1).max(3000),
  assessment: z.object({
    missionRelevance: z.string().max(800),
    eligibility: z.array(z.string().max(300)).max(10),
    policyChecks: z.array(z.object({
      rule: z.string().min(1).max(120),
      status: z.enum(["pass", "warning", "fail", "unknown"]),
      evidence: z.string().max(400),
    })).max(24),
    landingPage: z.object({ url: z.string().max(500).nullable(), ready: z.boolean(), findings: z.array(z.string().max(300)).max(10) }),
    risks: z.array(z.string().max(300)).max(10),
  }),
  /** Only the inputs that block eligibility, targeting, measurement, claims or authorization. */
  questions: z.array(z.object({ question: z.string().min(1).max(300), why: z.string().max(300) })).max(8),
  /** Conversion registry proposals; PROPOSED until validated. */
  measurement: z.array(z.object({
    name: z.string().min(1).max(120), meaning: z.string().max(300), source: z.string().max(200),
    role: z.enum(["primary", "secondary"]), notes: z.string().max(300),
  })).max(8),
  utilization: z.object({
    suggestedDailyBudgetUsd: z.number().nonnegative().max(100_000).nullable(),
    bindingConstraint: z.string().max(300),
    notes: z.array(z.string().max(300)).max(8),
  }),
  plan: GoogleAdsStrategyOutput.nullable(),
  nextSteps: z.array(z.string().max(300)).max(12),
  declineReason: z.string().max(600).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.decision === "proceed" && !v.plan) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plan"], message: "decision 'proceed' requires a plan" });
  if (v.decision === "needs_info" && !v.questions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["questions"], message: "decision 'needs_info' requires at least one question" });
  if (v.decision === "decline_recommended" && !v.declineReason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["declineReason"], message: "decision 'decline_recommended' requires declineReason" });
});
export type GoogleAdsRequestPlanOutput = z.infer<typeof GoogleAdsRequestPlanOutput>;
