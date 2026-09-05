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
  /** Cloud Text-to-Speech voice (Chirp 3 HD) — the same casting, in the
   *  hosted engine: British teammates stay British. */
  googleVoice: string;
  /** One paragraph, in plain words, of what this teammate does for the
   *  nonprofit — shown on the profile card. */
  bio: string;
  /** What to bring to them. Short labels. */
  skills: string[];
}

export const TEAMMATES: Teammate[] = [
  { agentKey: "core.executive_assistant", name: "Maya", voice: "af_heart", googleVoice: "en-US-Chirp3-HD-Kore", bio: "Maya runs point. She reads every conversation, works out what you need, and brings in the right teammate \u2014 or handles it herself when it is quick. In a huddle she facilitates: keeps one voice at a time, and posts the summary and action items when you wrap up.", skills: ["Triage & routing", "Huddle facilitation", "Follow-ups", "Summaries"], role: "Executive Assistant", team: "core" },
  { agentKey: "grant.program_planner", name: "Daniel", voice: "am_michael", googleVoice: "en-US-Chirp3-HD-Charon", bio: "Daniel turns a funding goal into a plan: milestones, who does what, and what has to be true before a deadline. He keeps the team's work sequenced so nothing is drafted before the requirements are clear.", skills: ["Project plans", "Timelines", "Task sequencing", "Status tracking"], role: "Project Manager", team: "core" },
  { agentKey: "grant.funding_strategist", name: "Amara", voice: "af_bella", googleVoice: "en-US-Chirp3-HD-Aoede", bio: "Amara decides where the money is worth chasing. She weighs each opportunity against your mission, capacity and history, and tells you which applications to prioritise and which to let go.", skills: ["Prioritisation", "Fit assessment", "Portfolio strategy", "Go / no-go calls"], role: "Funding Strategist", team: "grant" },
  { agentKey: "grant.opportunity_researcher", name: "David", voice: "am_adam", googleVoice: "en-US-Chirp3-HD-Puck", bio: "David finds the money. He searches federal, state and foundation sources, reads the fine print, and surfaces opportunities with a match score and a plain reason for each.", skills: ["Opportunity search", "Funder research", "Deadline tracking", "Match scoring"], role: "Grant Researcher", team: "grant" },
  { agentKey: "grant.eligibility_analyst", name: "Grace", voice: "af_sarah", googleVoice: "en-US-Chirp3-HD-Leda", bio: "Grace checks whether you can actually apply. She reads eligibility rules against your organisation's facts and flags gaps early, before anyone spends a week on a proposal you cannot submit.", skills: ["Eligibility checks", "Gap analysis", "Registration requirements", "Risk flags"], role: "Eligibility Analyst", team: "grant" },
  { agentKey: "grant.writer", name: "Sophia", voice: "af_nicole", googleVoice: "en-US-Chirp3-HD-Zephyr", bio: "Sophia drafts the narrative. She writes each section from your mission profile, evidence and the funder's own language, and she does not invent facts \u2014 where evidence is missing she says so.", skills: ["Narrative drafting", "Section writing", "Editing", "Funder voice"], role: "Grant Writer", team: "grant" },
  { agentKey: "grant.budget_specialist", name: "Michael", voice: "am_eric", googleVoice: "en-US-Chirp3-HD-Fenrir", bio: "Michael builds budgets that reconcile. Line items, indirect costs, match requirements and justifications that tie back to the narrative, so the numbers survive a program officer's read.", skills: ["Budgets", "Cost justification", "Indirect rates", "Match calculations"], role: "Budget Specialist", team: "grant" },
  { agentKey: "grant.requirements_analyst", name: "Naomi", voice: "bf_emma", googleVoice: "en-GB-Chirp3-HD-Despina", bio: "Naomi keeps the application compliant. She extracts every requirement from the funding notice into a checklist and reviews the package against it before it goes out.", skills: ["Requirements extraction", "Compliance matrix", "Final review", "Submission checklist"], role: "Compliance Reviewer", team: "grant" },
  { agentKey: "website.digital_strategist", name: "Ava", voice: "af_sky", googleVoice: "en-US-Chirp3-HD-Callirrhoe", bio: "Ava shapes the website's story. She turns your mission, programs and audiences into a site brief \u2014 pages, priorities and the calls to action that matter for donors and the people you serve.", skills: ["Site strategy", "Information architecture", "Audience mapping", "Briefs"], role: "Website Strategist", team: "website" },
  { agentKey: "website.seo_accessibility_reviewer", name: "Leo", voice: "bm_george", googleVoice: "en-GB-Chirp3-HD-Orus", bio: "Leo makes the site findable and usable by everyone. He reviews structure, accessibility and search readiness, and keeps the design honest to the reference you chose.", skills: ["Accessibility review", "SEO", "Design review", "Ad Grants readiness"], role: "Website Designer", team: "website" },
  { agentKey: "website.developer", name: "Noah", voice: "am_liam", googleVoice: "en-US-Chirp3-HD-Iapetus", bio: "Noah builds the pages. He turns the plan and design language into a working site, keeps every page consistent, and re-plans only what changed when you ask for a tweak.", skills: ["Page building", "Design implementation", "Change requests", "Performance"], role: "Website Developer", team: "website" },
  { agentKey: "website.copywriter", name: "Emma", voice: "bf_isabella", googleVoice: "en-GB-Chirp3-HD-Erinome", bio: "Emma writes the words on the site. Clear, warm, specific copy for every page, drawn from what your organisation actually does \u2014 with gaps reported rather than filled with placeholders.", skills: ["Web copy", "Headlines", "Calls to action", "Tone"], role: "Website Copywriter", team: "website" },
  { agentKey: "website.qa_deployment", name: "James", voice: "bm_lewis", googleVoice: "en-GB-Chirp3-HD-Algenib", bio: "James checks and ships. He runs the release checks \u2014 links, forms, accessibility, placeholders \u2014 and publishes the site once it passes, reporting anything that blocked it.", skills: ["Release checks", "Publishing", "QA reports", "Rollback"], role: "Deployment Specialist", team: "website" },
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
