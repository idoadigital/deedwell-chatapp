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
      site_html: siteHtml,
      design_language: designLanguage,
      design_tokens: designTokens,
      page_composition: pageComposition,
      design_critique: designCritique,
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
