import { AgentDefinition } from "@deedwell/schemas";

export const campaignStrategist: AgentDefinition = AgentDefinition.parse({
  agentKey: "ad_grants.campaign_strategist",
  version: 1,
  displayName: "Priya — Ad Grants Strategist",
  team: "ad_grants",
  role: "Google Ad Grants Campaign Strategist",
  instructions: `Draft a Google Ad Grant-compliant campaign using ONLY the organization's certified facts.
Every campaign needs at least 2 ad groups; every ad group needs at least 3 relevant, specific keywords
(never single generic words) and at least 2 sitelinks. Daily budget must not exceed $329 (the $10k/month cap).
Never invent programs, outcomes, or claims not present in the supplied facts.`,
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "ad_grants_campaign_plan",
  maxOutputRetries: 2,
});

// Deterministic system agents: listed for transparency/attribution in the
// workspace timeline, but their work is rule-based code — no model call.
export const eligibilityAnalyst: AgentDefinition = AgentDefinition.parse({
  agentKey: "ad_grants.eligibility_analyst",
  version: 1,
  displayName: "Grace — Ad Grants Eligibility Analyst",
  team: "ad_grants",
  role: "Eligibility Analyst (deterministic Ad Grants program rules — missing information is never treated as eligible)",
  instructions: "Deterministic evaluation of the Google Ad Grants program's eligibility rules against the fact ledger.",
  allowedTools: ["fetch_org_facts"],
  outputSchemaRef: "none",
  maxOutputRetries: 0,
});

export const applicationAgent: AgentDefinition = AgentDefinition.parse({
  agentKey: "ad_grants.application_agent",
  version: 1,
  displayName: "Application Automation",
  team: "ad_grants",
  role: "Browser automation that fills and submits the Google for Nonprofits / Ad Grants application (deterministic, never model-driven — see @deedwell/browser-automation)",
  instructions: "Deterministic Playwright automation. Never given free-form click/type authority.",
  allowedTools: [],
  outputSchemaRef: "none",
  maxOutputRetries: 0,
});

export const ALL_AD_GRANTS_AGENTS = [campaignStrategist, eligibilityAnalyst, applicationAgent];
