import type { ModelProvider, ModelRequest, ModelResponse } from "./index.js";
import { designCritique, designLanguage, designTokens, pageComposition, siteContent, siteHtml, sitePage, sitePatch, websiteBrief } from "./mock-website.js";
import { mockIntent } from "./mock-intent.js";
import type {
  AdGrantsCampaignPlanOutput,
  BudgetOutput,
  ExtractedFact,
  ExtractedRequirement,
  FactExtractionOutput,
  LogicModelOutput,
  OrgFact,
  RequirementsExtractionOutput,
  ReviewPanelOutput,
  SectionClaim,
  SectionDraftOutput,
  SectionPlanOutput,
} from "@deedwell/schemas";

/**
 * ============================ MOCK IMPLEMENTATION ===========================
 * Deterministic, rule-based stand-in for a real model provider (ADR-0003).
 * It exists so the harness — schemas, retries, budgets, gateways, approvals,
 * durability — can be built and tested hermetically. It is NOT a language
 * model and its content quality is not representative of the product.
 * ==========================================================================
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const generators: Record<ModelRequest["outputSchemaRef"], (r: ModelRequest) => unknown> = {
      content_strategy: contentStrategy,
      requirements_extraction: extractRequirements,
      fact_extraction: extractFacts,
      section_draft: draftSection,
      section_plan: planSections,
      budget: buildBudget,
      logic_model: buildLogicModel,
      review_panel: reviewPanel,
      website_brief: websiteBrief,
      site_content: siteContent,
      site_page: sitePage,
      site_patch: sitePatch,
      intent: mockIntent,
      ad_grants_campaign_plan: draftAdGrantsCampaign,
      google_ads_strategy: googleAdsStrategy,
      google_ads_campaign_draft: googleAdsCampaignDraft,
      site_html: siteHtml,
      design_language: designLanguage,
      design_tokens: designTokens,
      page_composition: pageComposition,
      design_critique: designCritique,
      logo_brief: logoBrief,
      logo_concepts: logoConcepts,
      proactive_message: proactiveMessage,
      agent_task_result: agentTaskResult,
      task_schedule_reply: taskScheduleReply,
    };
    const produced = generators[request.outputSchemaRef](request);
    // The designer answers with a document, not a JSON object.
    const text = typeof produced === "string" ? produced : JSON.stringify(produced);
    const inputChars =
      request.system.length +
      request.task.length +
      request.dataBlocks.reduce((n, b) => n + b.content.length, 0);
    return { text, tokensEstimated: Math.ceil((inputChars + text.length) / 4) };
  }
}

const MANDATORY = /\b(must|shall|required|require[sd]?)\b/i;
const ADVISORY = /\b(should|encouraged|recommended|may include)\b/i;

const KIND_RULES: Array<[RegExp, ExtractedRequirement["kind"]]> = [
  [/\beligib|501\s*\(\s*c\s*\)|nonprofit status|registered|tax[- ]exempt|incorporat/i, "eligibility"],
  [/\bbudget|cost|match(ing)? funds?|indirect|line[- ]item/i, "budget"],
  [/\battach|upload|letter of support|form [A-Z0-9-]+|appendix/i, "attachment"],
  [/\bfont|margin|page limit|single[- ]spaced|double[- ]spaced|file (format|type)|pdf format/i, "formatting"],
  [/\bdeadline|due (by|date|no later)|submit(ted)? by/i, "deadline"],
  [/\bnarrative|describe|statement|section|explain|demonstrate/i, "narrative"],
];

function classify(line: string): ExtractedRequirement["kind"] {
  for (const [re, kind] of KIND_RULES) if (re.test(line)) return kind;
  return "other";
}

function extractRequirements(request: ModelRequest): RequirementsExtractionOutput {
  const doc = request.dataBlocks.find((b) => b.label === "document")?.content ?? "";
  const lines = doc.split(/\r?\n/);
  const requirements: ExtractedRequirement[] = [];

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (line.length < 12) return;
    const mandatory = MANDATORY.test(line);
    if (!mandatory && !ADVISORY.test(line)) return;
    const wordLimitMatch = line.match(/(\d{2,6})\s*words?\b/i);
    requirements.push({
      text: line.slice(0, 4000),
      kind: classify(line),
      mandatory,
      sourceLocation: { line: idx + 1, quote: line.slice(0, 2000) },
      wordLimit: wordLimitMatch ? Number(wordLimitMatch[1]) : null,
    });
  });

  if (requirements.length === 0) {
    // Schema requires >= 1; surface an explicit "nothing found" requirement so
    // the workflow can fail loudly rather than invent content.
    requirements.push({
      text: "NO REQUIREMENTS DETECTED — document may not be a grant announcement",
      kind: "other",
      mandatory: false,
      sourceLocation: { line: 1, quote: lines[0]?.slice(0, 200) || "(empty document)" },
      wordLimit: null,
    });
  }

  return {
    requirements,
    documentSummary: `Detected ${requirements.length} candidate requirement(s) across ${lines.length} lines. [mock provider]`,
  };
}

/** "Label: value" lines only — deterministic and easy to control from tests.
 *  Content quality is not the point; exercising the extraction→provenance
 *  harness path is. */
function extractFacts(request: ModelRequest): FactExtractionOutput {
  const doc = request.dataBlocks.find((b) => b.label === "document")?.content ?? "";
  const lines = doc.split(/\r?\n/);
  const facts: ExtractedFact[] = [];

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /'-]{2,60}):\s*(.{1,200})$/);
    if (!match) return;
    const label = match[1]!;
    const value = match[2]!;
    if (!value.trim()) return;
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!key) return;
    facts.push({
      key,
      value: value.trim(),
      sourceLocation: { line: idx + 1, quote: line.slice(0, 2000) },
    });
  });

  return {
    facts,
    documentSummary: `Detected ${facts.length} candidate fact(s) across ${lines.length} lines. [mock provider]`,
  };
}

function draftSection(request: ModelRequest): SectionDraftOutput {
  const facts: OrgFact[] = JSON.parse(
    request.dataBlocks.find((b) => b.label === "org_facts")?.content ?? "[]"
  );
  const requirements: Array<{ text: string; wordLimit: number | null }> = JSON.parse(
    request.dataBlocks.find((b) => b.label === "requirements")?.content ?? "[]"
  );
  const titleMatch = request.task.match(/section titled "([^"]+)"/i);
  const title = titleMatch?.[1] ?? "Draft Section";

  const claims: SectionClaim[] = [];
  const paragraphs: string[] = [];

  for (const fact of facts) {
    const sentence = `Our organization's ${fact.key.replace(/_/g, " ")} is ${fact.value}.`;
    const supported = fact.status === "verified" || fact.status === "user_certified";
    claims.push({
      text: sentence,
      factKey: fact.key,
      support: fact.status,
      flagged: !supported,
    });
    paragraphs.push(sentence);
  }

  // A deliberately unsupported claim: real models produce these; the harness
  // must catch and flag them rather than let them pass silently.
  const unsupported = `This program is projected to reach significantly more participants than comparable initiatives.`;
  claims.push({ text: unsupported, factKey: null, support: "unsupported", flagged: true });
  paragraphs.push(unsupported);

  paragraphs.push(
    `This section responds to ${requirements.length} extracted requirement(s). [mock provider draft]`
  );
  const body = paragraphs.join("\n\n");
  return {
    title,
    body,
    claims,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 generators — deterministic stand-ins, same caveats as above.
// ---------------------------------------------------------------------------

function block(request: ModelRequest, label: string): string {
  return request.dataBlocks.find((b) => b.label === label)?.content ?? "";
}

function jsonBlock<T>(request: ModelRequest, label: string, fallback: T): T {
  try {
    return JSON.parse(block(request, label)) as T;
  } catch {
    return fallback;
  }
}

const STANDARD_SECTIONS: Array<{ title: string; match: RegExp; objective: string }> = [
  { title: "Statement of Need", match: /need|problem|population|communit/i,
    objective: "Establish the problem and the population served, grounded in evidence." },
  { title: "Program Design", match: /program|design|activit|implement|approach|intervention/i,
    objective: "Describe the intervention, activities, and implementation plan." },
  { title: "Organizational Capacity", match: /capacity|experience|staff|qualifi|organiza/i,
    objective: "Demonstrate the organization's ability to deliver the program." },
  { title: "Evaluation Plan", match: /evaluat|outcome|measur|monitor|indicator|demonstrate/i,
    objective: "Explain how outputs and outcomes will be measured and reported." },
];

function planSections(request: ModelRequest): SectionPlanOutput {
  const requirements = jsonBlock<ExtractedRequirement[]>(request, "requirements", []);
  const narrative = requirements.filter((r) => r.kind === "narrative");
  const sections = STANDARD_SECTIONS.map((s) => {
    const matched = narrative.filter((r) => s.match.test(r.text));
    return {
      title: s.title,
      objective: s.objective,
      wordLimit: matched.find((r) => r.wordLimit)?.wordLimit ?? null,
      requirementLines: matched.map((r) => r.sourceLocation.line),
    };
  }).filter((s, idx) => idx < 2 || s.requirementLines.length > 0);
  return {
    sections: sections.length ? sections : [STANDARD_SECTIONS[0]!].map((s) => ({
      title: s.title, objective: s.objective, wordLimit: null, requirementLines: [],
    })),
    activities: [
      "Participant outreach and enrollment",
      "Core program delivery",
      "Staff training and supervision",
      "Monitoring, evaluation, and reporting",
    ],
  };
}

function buildBudget(request: ModelRequest): BudgetOutput {
  const activities = jsonBlock<string[]>(request, "activities", ["Core program delivery"]);
  const items: BudgetOutput["items"] = activities.flatMap((activity, i) => [
    {
      category: "personnel" as const,
      description: `Program staff time — ${activity.toLowerCase()}`,
      activity,
      quantity: 1,
      unitCost: 12000 + i * 1500,
    },
    {
      category: "direct" as const,
      description: `Materials and services — ${activity.toLowerCase()}`,
      activity,
      quantity: 1,
      unitCost: 3000 + i * 500,
    },
  ]);
  items.push({
    category: "indirect",
    description: "Indirect costs (10% de minimis)",
    activity: "Administration",
    quantity: 1,
    unitCost: Math.round(items.reduce((n, it) => n + it.quantity * it.unitCost, 0) * 0.1),
  });
  return {
    currency: "USD",
    items,
    narrative:
      "Each line item is tied to a planned activity; personnel costs reflect staff time and " +
      "direct costs cover materials and services. Indirect costs use the 10% de minimis rate. " +
      "[mock provider]",
  };
}

function buildLogicModel(request: ModelRequest): LogicModelOutput {
  const activities = jsonBlock<string[]>(request, "activities", ["Core program delivery"]);
  const facts = jsonBlock<OrgFact[]>(request, "org_facts", []);
  const mission = facts.find((f) => f.key === "mission")?.value ?? "the organization's mission";
  const outcomes = [
    "Participants demonstrate improved program-specific outcomes",
    "Organizational service capacity is strengthened",
  ];
  return {
    problem: `The community need addressed by ${mission}. [mock provider]`,
    inputs: ["Program staff", "Grant funding", "Community partnerships", "Facilities"],
    activities,
    outputs: activities.map((a) => `Completed: ${a.toLowerCase()} (count tracked quarterly)`),
    outcomes,
    impact: "Sustained improvement in wellbeing for the served population.",
    indicators: outcomes.map((outcome, i) => ({
      outcome,
      indicator: i === 0 ? "% of participants meeting outcome benchmark" : "# of participants served per quarter",
      baseline: "To be established at intake",
      target: i === 0 ? "70% by end of grant year" : "25% increase over prior year",
      source: "Program records and participant assessments",
      frequency: "Quarterly",
    })),
  };
}

function reviewPanel(request: ModelRequest): ReviewPanelOutput {
  const requirements = jsonBlock<ExtractedRequirement[]>(request, "requirements", []);
  const coverage = jsonBlock<{ coveredLines: number[]; flaggedClaims: number }>(
    request, "coverage", { coveredLines: [], flaggedClaims: 0 }
  );
  const mandatory = requirements.filter((r) => r.mandatory).slice(0, 4);
  const reviewers = ["program", "financial", "compliance", "skeptic"] as const;
  const reviews: ReviewPanelOutput["reviews"] = reviewers.map((reviewer, i) => {
    const req = mandatory[i % Math.max(mandatory.length, 1)];
    const covered = req ? coverage.coveredLines.includes(req.sourceLocation.line) : false;
    const skepticPenalty = reviewer === "skeptic" ? 1 : 0;
    return {
      reviewer,
      criterion: req ? req.text.slice(0, 300) : "Overall responsiveness to the announcement",
      score: Math.max(0, (covered ? 4 : 2) - skepticPenalty),
      maxScore: 5 as const,
      strengths: covered
        ? "The application addresses this requirement with traceable content."
        : "The application structure is clear.",
      weaknesses: covered
        ? reviewer === "skeptic"
          ? "Evidence depth is thinner than top-scoring applications typically show."
          : "Could cite stronger comparative evidence."
        : "This requirement is not clearly addressed by any drafted section.",
      fatalFlaw: !covered && (req?.mandatory ?? false) && reviewer === "compliance",
    };
  });
  const recommendations: string[] = [];
  if (coverage.flaggedClaims > 0) {
    recommendations.push(
      `Resolve ${coverage.flaggedClaims} flagged claim(s) with verified evidence before submission.`
    );
  }
  for (const r of reviews.filter((r) => r.fatalFlaw)) {
    recommendations.push(`Address unmet mandatory requirement: ${r.criterion.slice(0, 120)}`);
  }
  return { reviews, revisionRecommendations: recommendations };
}

// ---------------------------------------------------------------------------
// Google Ad Grants — deterministic campaign-plan stand-in.
// ---------------------------------------------------------------------------

function draftAdGrantsCampaign(request: ModelRequest): AdGrantsCampaignPlanOutput {
  const facts = jsonBlock<OrgFact[]>(request, "org_facts", []);
  const byKey = new Map(facts.map((f) => [f.key, f.value]));
  const legalName = byKey.get("legal_name") ?? "Our organization";
  const mission = byKey.get("mission") ?? "our mission";
  const website = byKey.get("website_url") ?? "https://example.org";
  const service = byKey.get("service_area") ?? "the communities we serve";

  return {
    campaignName: `${legalName} — Mission Awareness`,
    dailyBudgetUsd: 300,
    adGroups: [
      {
        name: "Programs and Services",
        keywords: [
          `${legalName} programs`,
          `nonprofit ${service}`,
          `donate to ${legalName}`,
        ],
        headlines: [
          `${legalName}`,
          `Support ${service}`,
          `Learn About Our Mission`,
        ],
        descriptions: [
          `${legalName} works to advance ${mission}. [mock provider]`,
          `Discover how ${legalName} serves ${service}.`,
        ],
        finalUrl: website,
      },
      {
        name: "Volunteer and Get Involved",
        keywords: [
          `volunteer ${service}`,
          `${legalName} volunteer`,
          `help ${service}`,
        ],
        headlines: [
          `Volunteer With Us`,
          `Get Involved Today`,
          `Join ${legalName}`,
        ],
        descriptions: [
          `Find volunteer opportunities with ${legalName}. [mock provider]`,
          `Make a difference in ${service} today.`,
        ],
        finalUrl: website,
      },
    ],
    sitelinks: [
      { text: "Our Programs", url: website },
      { text: "Donate", url: website },
    ],
    geoTargets: [service],
    notes: "Deterministic mock campaign plan — content quality is not representative of the product.",
  };
}

/** Deterministic stand-in so the Content Studio pipeline is exercisable end to
 *  end without a paid key. Four briefs, because four is the contract's floor. */
function contentStrategy(request: ModelRequest): unknown {
  const ask = request.dataBlocks.find((b) => b.label === "staff request")?.content ?? "your campaign";
  const angles = ["Portrait-led", "Typographic", "Botanical", "Documentary"];
  return {
    audience: "Local supporters and volunteers",
    message: ask.slice(0, 140),
    tone: "Warm, plain-spoken, unhurried",
    palette: "Deep green ground, cream type, one warm accent",
    designs: angles.map((angle) => ({
      caption: `${angle} treatment`,
      prompt: `${angle} design for: ${ask}. Editorial serif headline, generous margins, restrained palette.`,
      postText: `${ask.slice(0, 80)}\n\nThis is the ${angle.toLowerCase()} take — made for the people who show up. Join us, share this, or give what you can.\n\n#nonprofit #community #${angle.toLowerCase().replace(/[^a-z]/g, "")}`,
    })),
  };
}

/** A brief that reads like one, from whatever the request and context say —
 *  so the logo generator's whole flow runs in mock mode. */
function logoBrief(request: ModelRequest): unknown {
  const ask = request.dataBlocks.find((b) => b.label === "logo request")?.content ?? "";
  const context = request.dataBlocks.find((b) => b.label === "organization context")?.content ?? "";
  const name = (/^legal_name: (.+)$/m.exec(context) ?? /^Organization: (.+)$/m.exec(context))?.[1]?.trim() || "Your organization";
  const primary = /brand_primary_color: (#[0-9a-fA-F]{6})/.exec(context)?.[1];
  const accent = /brand_accent_color: (#[0-9a-fA-F]{6})/.exec(context)?.[1];
  const wantsWordmark = /wordmark/i.test(ask);
  return {
    organizationName: name,
    tagline: /^tagline: (.+)$/m.exec(context)?.[1]?.trim() ?? null,
    description: (/^mission: (.+)$/m.exec(context)?.[1] ?? `${name} is a nonprofit.`).slice(0, 1200),
    objectives: ["trust", "human connection", "progress"],
    audience: "Supporters, partners and the people the organization serves",
    personality: ["Modern", "Human", "Trustworthy"],
    logoType: wantsWordmark ? "wordmark" : "ai_choice",
    visualStyle: ["Minimal", "Contemporary"],
    colors: primary
      ? { mode: "existing", palette: [primary, ...(accent ? [accent] : [])], notes: null }
      : { mode: "suggested", palette: ["#0d5527", "#dae470"], notes: "Deep green with a warm lime accent." },
    symbolism: ["growth", "connection"],
    avoid: ["overly corporate", "generic heart icons", "gradients"],
    designerNotes: `Develop a modern, human-centred identity for ${name}. ${ask.slice(0, 200)}`.trim(),
  };
}

function logoConcepts(request: ModelRequest): unknown {
  const brief = request.dataBlocks.find((b) => b.label === "approved brief")?.content ?? "";
  const fixed = /"logoType":\s*"(wordmark|lettermark|emblem|symbol_wordmark|combination)"/.exec(brief)?.[1];
  const set: Array<[string, string, string]> = [
    ["Clear Voice", "Typography-led", "wordmark"],
    ["Rising Path", "Abstract symbol", "symbol_wordmark"],
    ["Common Ground", "Geometric", "combination"],
    ["Open Hand", "Organic", "symbol_wordmark"],
    ["Keystone", "Minimal emblem", "emblem"],
  ];
  return {
    concepts: set.map(([title, approach, type]) => ({
      title,
      approach,
      logoType: fixed ?? type,
      direction: `${approach} direction: a single clean mark with the organization name set in a modern sans-serif, generous margins, flat colour.`,
    })),
  };
}

/** Phrases the orchestrator's brief as a short teammate message; declines
 *  when the brief itself says nothing is left for the user to do. */
function proactiveMessage(request: ModelRequest): unknown {
  const brief = request.dataBlocks.find((b) => b.label === "situation")?.content ?? "";
  const next = /next expected action: (.+)/i.exec(brief)?.[1]?.trim();
  const goal = /goal: (.+)/i.exec(brief)?.[1]?.trim();
  const type = /type: (.+)/i.exec(brief)?.[1]?.trim();
  const nothing = /nothing for the user to do/i.test(brief);
  const draft = /Draft from the agent: (.+)/i.exec(brief)?.[1]?.trim();
  const combined = /Also waiting for the user \(combine briefly\): (.+)/i.exec(brief)?.[1]?.trim();
  const message = draft
    ? `${draft}${combined ? ` There is also something else waiting for you: ${combined.replace(/^\d+\. /, "")}` : ""}`
    : type === "work_completed"
    ? `I finished ${goal ? `the work on ${goal}` : "what we discussed"}. Want me to show you?`
    : next
      ? `Quick update on ${goal ?? "our work"} — I'm still waiting on one thing: ${next.replace(/\.$/, "")}. Want to finish that now?`
      : `We started on ${goal ?? "something"} and haven't finished. Do you still want to continue?`;
  return { message, summary: message.slice(0, 120), shouldSend: !nothing, reason: nothing ? "No user action is pending." : null };
}

/** A believable deliverable from the task's own words, so tests and demos
 *  see the full runner path (document, notes, optional image, question). */
function agentTaskResult(request: ModelRequest): unknown {
  const task = request.dataBlocks.find((b) => b.label === "task")?.content ?? "";
  const title = /title: (.+)/i.exec(task)?.[1]?.trim() ?? "Task";
  const instructions = /instructions: ([\s\S]+?)(\n[a-z ]+:|$)/i.exec(task)?.[1]?.trim() ?? "";
  const wantsImage = /\b(image|graphic|poster|flyer|logo|design)\b/i.test(`${title} ${instructions}`);
  const needs = /\[needs user\]/i.test(instructions) ? "Which program should this cover?" : null;
  return {
    summary: `Completed "${title}": researched the request, drafted the deliverable, and noted follow-ups.`,
    progressNotes: ["Reviewed the mission profile and instructions", "Drafted the deliverable", "Checked it against the request"],
    deliverables: needs ? [] : [{ title, body: `# ${title}\n\n${instructions || "Summary of the work."}\n\n## Findings\n\n- Point one\n- Point two\n\n## Next steps\n\n1. Review\n2. Share` }],
    imageRequests: wantsImage && !needs ? [{ title: `${title} image`, prompt: `A clean, warm illustration for: ${title}` }] : [],
    needsFromUser: needs,
    handoffs: /\[hand off to ([a-z_.]+)\]/i.test(instructions)
      ? [{ agentKey: /\[hand off to ([a-z_.]+)\]/i.exec(instructions)![1]!, title: `Follow-up for ${title}`, instructions: "Take the part that fits your specialty." }]
      : [],
  };
}

/** Rule-based reading of a scheduling reply, mirroring mock-intent's style. */
function taskScheduleReply(request: ModelRequest): unknown {
  const reply = (request.dataBlocks.find((b) => b.label === "reply")?.content ?? "").toLowerCase();
  const recurring = /\b(recurring|repeat|every|each|weekly|daily|monthly|routine)\b/.test(reply) ? true
    : /\b(one[- ]?time|once|just once|one[- ]?off|single)\b/.test(reply) ? false : null;
  let cron: string | null = null;
  const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(reply);
  let hour = at ? Number(at[1]) : 9; const minute = at?.[2] ? Number(at[2]) : 0;
  if (at?.[3] === "pm" && hour < 12) hour += 12; if (at?.[3] === "am" && hour === 12) hour = 0;
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const day = dayNames.findIndex((d) => reply.includes(d));
  if (/\bweekday/.test(reply)) cron = `${minute} ${hour} * * 1-5`;
  else if (day >= 0) cron = `${minute} ${hour} * * ${day}`;
  else if (/\b(daily|every day)\b/.test(reply)) cron = `${minute} ${hour} * * *`;
  else if (/\b(monthly|every month|first of)\b/.test(reply)) cron = `${minute} ${hour} 1 * *`;
  else if (/\bweekly\b/.test(reply)) cron = `${minute} ${hour} * * 1`;
  const confirm = /\b(yes|confirm|go ahead|looks good|create it|do it|sounds good|ok(ay)?|yep|sure)\b/.test(reply) ? true
    : /\b(cancel|never ?mind|stop|forget it|no thanks)\b/.test(reply) ? false : null;
  const priority = /\burgent\b/.test(reply) ? "urgent" : /\bhigh priority\b/.test(reply) ? "high" : /\blow priority\b/.test(reply) ? "low" : null;
  return { recurring, cron, runAt: null, confirm, changes: { title: null, instructions: null, agentKey: null, priority, requiresApproval: /\b(approval|approve first|check with me)\b/.test(reply) ? true : null } };
}


// ---- Google Ads ------------------------------------------------------------
// Deterministic stand-ins that read the organization block the real prompt
// gets, so tests exercise the same plumbing (validation, review, publish).

function googleAdsOrgName(request: ModelRequest): string {
  const ctx = jsonBlock<{ name?: string; websiteUrl?: string | null; pages?: Array<{ url: string; title: string }> }>(request, "organization", {});
  return ctx.name || "The organization";
}

function googleAdsLanding(request: ModelRequest): string {
  const ctx = jsonBlock<{ websiteUrl?: string | null; pages?: Array<{ url: string; title: string }> }>(request, "organization", {});
  return ctx.pages?.[0]?.url || ctx.websiteUrl || "https://example.org/";
}

function googleAdsStrategy(request: ModelRequest): unknown {
  const name = googleAdsOrgName(request);
  const landing = googleAdsLanding(request);
  return {
    title: `${name} — search strategy`,
    objective: `Reach people looking for the services ${name} provides and turn that interest into contact, sign-ups and donations.`,
    audiences: [{ name: "People seeking help", description: "Individuals and families searching for the programs the organization runs." },
      { name: "Supporters", description: "Local donors and volunteers who search for ways to help." }],
    themes: [{ name: "Programs and services", description: "Searches that match the organization's core programs." },
      { name: "Get involved", description: "Volunteering and donation intent." }],
    campaigns: [{ name: `${name} — Programs`, objective: "Drive program enquiries", landingPage: landing, keywordThemes: ["programs", "services near me"], adGroupIdeas: ["Core program", "Who we serve"] }],
    landingPages: [{ url: landing, purpose: "Program overview", recommendations: ["Add a clear call to action above the fold", "State who is eligible"] }],
    keywordThemes: [{ theme: "programs", examples: ["community support program", "free help for families"] }],
    negativeKeywords: ["jobs", "salary", "free download"],
    conversionGoals: [{ name: "Contact form submission", howToTrack: "Google Ads conversion action on the thank-you page." }],
    budget: { monthlyUsd: 3000, rationale: "Conservative start; scale with performance." },
    opportunities: ["No conversion tracking is recorded yet — set it up before scaling."],
    adGrantsNotes: ["Keep keywords mission-related and avoid single-word keywords."],
  };
}

function googleAdsCampaignDraft(request: ModelRequest): unknown {
  const name = googleAdsOrgName(request);
  const landing = googleAdsLanding(request);
  const short = name.slice(0, 18).trim();
  const ad = (title: string) => ({
    title,
    headlines: [`${short} Programs`, "Support In Your Community", "Free Help For Families", "Talk To Our Team Today", "Local Nonprofit Services", "Get Support Near You", "Compassionate Local Help", "Programs That Work"],
    descriptions: ["Programs designed with the community, for the community. Learn how we can help today.", "Find the support you need from a trusted local nonprofit. Reach out to get started.", "Our team is here to help. See programs, eligibility and how to get in touch."],
    finalUrl: landing, path1: "programs", path2: null,
    rationale: "Leads with the program name and a clear next step.",
  });
  return {
    name: `${name} — Programs`,
    objective: "Drive program enquiries from people searching for help.",
    landingPage: landing,
    dailyBudgetMicros: 50_000_000,
    geoTargets: ["United States"],
    negativeKeywords: ["jobs", "salary"],
    adGroups: [
      { name: "Core program", keywords: [{ text: "community support program", matchType: "PHRASE" }, { text: "help for families near me", matchType: "PHRASE" }, { text: `${short.toLowerCase()} programs`, matchType: "EXACT" }, { text: "nonprofit family services", matchType: "BROAD" }, { text: "free community services", matchType: "PHRASE" }], negativeKeywords: ["volunteer"], ads: [ad("Core program — A"), ad("Core program — B")] },
      { name: "Get involved", keywords: [{ text: "volunteer opportunities near me", matchType: "PHRASE" }, { text: "donate to local nonprofit", matchType: "PHRASE" }, { text: "how to volunteer locally", matchType: "BROAD" }, { text: "support a community nonprofit", matchType: "PHRASE" }, { text: "nonprofit volunteer program", matchType: "PHRASE" }], negativeKeywords: ["paid"], ads: [ad("Get involved — A"), ad("Get involved — B")] },
    ],
    rationale: "Two ad groups split by intent: people seeking help and people wanting to help.",
  };
}
