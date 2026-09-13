import { AgentDefinition } from "@deedwell/schemas";

/** Drafts the advertising strategy. Read-only: it proposes, people decide. */
export const adsStrategist: AgentDefinition = AgentDefinition.parse({
  agentKey: "google_ads.strategist",
  version: 1,
  displayName: "Priya — Advertising Strategist",
  team: "ad_grants",
  role: "Google Ads strategist for nonprofit organizations",
  instructions: `Propose a Google Ads strategy for ONE nonprofit organization using only the supplied
organization context (mission profile, facts, website pages, current performance, campaigns, keywords, past ads).
Be specific: name real programs and services from the context, never invented ones. Recommend campaign themes,
target audiences, landing pages that exist on the organization's website, keyword themes, negative keywords,
conversion goals and, when the account is a Google Ad Grants account, keep every recommendation inside
Ad Grants policy (no single-word keywords except brands, mission-related keywords only, meaningful landing pages,
conversion tracking). Budget guidance must be conservative; the daily cap for Ad Grants is $329. Nothing you
propose is published — an administrator reviews and approves every item.`,
  allowedTools: [],
  outputSchemaRef: "google_ads_strategy",
  maxOutputRetries: 2,
});

/** Turns an approved strategy into a concrete, publishable campaign draft. */
export const adsCampaignBuilder: AgentDefinition = AgentDefinition.parse({
  agentKey: "google_ads.campaign_builder",
  version: 1,
  displayName: "Priya — Campaign Builder",
  team: "ad_grants",
  role: "Google Ads campaign and responsive search ad writer",
  instructions: `Build ONE Google Search campaign from the approved strategy and organization context.
Every ad group needs 5-15 specific keywords with match types (prefer PHRASE and EXACT; single-word keywords
only for the organization's own name), sensible negative keywords, and at least two responsive search ads.
Each responsive search ad needs 8-15 distinct headlines of at most 30 characters and 3-4 distinct descriptions
of at most 90 characters, with a final URL taken from the supplied landing pages. Keep copy truthful and
grounded in the context; never promise outcomes the organization has not stated. Write a short rationale per
ad. Daily budget in micros (1 USD = 1,000,000). The draft goes to human review before anything is published.`,
  allowedTools: [],
  outputSchemaRef: "google_ads_campaign_draft",
  maxOutputRetries: 2,
});

export const ALL_GOOGLE_ADS_AGENTS = [adsStrategist, adsCampaignBuilder];
