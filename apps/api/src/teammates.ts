import { AgentDefinition } from "@deedwell/schemas";

/**
 * The default AI teammates every workspace starts with (interface spec §3).
 * Display identities live here; the underlying agent keys are wired into the
 * workflows. Teammates exist from workspace creation — no setup by the user.
 */
export interface Teammate {
  agentKey: string;
  name: string;
  role: string;
  team: "core" | "grant" | "website";
  /** Kokoro-82M voice id (open-source TTS) — distinct voice per teammate. */
  voice: string;
}

export const TEAMMATES: Teammate[] = [
  { agentKey: "core.executive_assistant", name: "Maya", voice: "af_heart", role: "Executive Assistant", team: "core" },
  { agentKey: "grant.program_planner", name: "Daniel", voice: "am_michael", role: "Project Manager", team: "core" },
  { agentKey: "grant.funding_strategist", name: "Amara", voice: "af_bella", role: "Funding Strategist", team: "grant" },
  { agentKey: "grant.opportunity_researcher", name: "David", voice: "am_adam", role: "Grant Researcher", team: "grant" },
  { agentKey: "grant.eligibility_analyst", name: "Grace", voice: "af_sarah", role: "Eligibility Analyst", team: "grant" },
  { agentKey: "grant.writer", name: "Sophia", voice: "af_nicole", role: "Grant Writer", team: "grant" },
  { agentKey: "grant.budget_specialist", name: "Michael", voice: "am_eric", role: "Budget Specialist", team: "grant" },
  { agentKey: "grant.requirements_analyst", name: "Naomi", voice: "bf_emma", role: "Compliance Reviewer", team: "grant" },
  { agentKey: "website.digital_strategist", name: "Ava", voice: "af_sky", role: "Website Strategist", team: "website" },
  { agentKey: "website.seo_accessibility_reviewer", name: "Leo", voice: "bm_george", role: "Website Designer", team: "website" },
  { agentKey: "website.developer", name: "Noah", voice: "am_liam", role: "Website Developer", team: "website" },
  { agentKey: "website.copywriter", name: "Emma", voice: "bf_isabella", role: "Website Copywriter", team: "website" },
  { agentKey: "website.qa_deployment", name: "James", voice: "bm_lewis", role: "Deployment Specialist", team: "website" },
];

export const teammateByKey = new Map(TEAMMATES.map((t) => [t.agentKey, t]));

export function displayName(agentKey: string | null | undefined): string {
  if (!agentKey) return "Deedwell";
  const mate = teammateByKey.get(agentKey);
  return mate ? `${mate.name} — ${mate.role}` : agentKey;
}

/** The Grant Researcher is a directory identity for the real discovery integration. */
export const opportunityResearcher: AgentDefinition = AgentDefinition.parse({
  agentKey: "grant.opportunity_researcher",
  version: 1,
  displayName: "David — Grant Researcher",
  team: "grant",
  role: "Grant Researcher: finds and monitors funding opportunities (live Grants.gov integration)",
  instructions: "Discovery runs through the GrantSourceProvider integration; results always carry source and retrieval date.",
  allowedTools: [],
  outputSchemaRef: "none",
  maxOutputRetries: 0,
});

/** Default channels every workspace starts with (interface spec §3). */
export const DEFAULT_CHANNELS: Array<{ key: string; name: string }> = [
  { key: "general", name: "general" },
  { key: "announcements", name: "announcements" },
  { key: "funding-opportunities", name: "funding-opportunities" },
  { key: "grant-work", name: "grant-work" },
  { key: "website", name: "website" },
  { key: "organization-information", name: "organization-information" },
];

export const MAYA_WELCOME =
  "Welcome to Deedwell. I'm Maya, your AI Executive Assistant, and your nonprofit's AI team is already here. " +
  "Tell me what you need to accomplish, or pick a teammate from the sidebar. " +
  'Try: "Find grants for our youth program" or "Build a website for our organization."';
