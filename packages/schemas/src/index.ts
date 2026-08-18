import { z } from "zod";

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const OrgRole = z.enum(["owner", "admin", "member", "viewer"]);
export type OrgRole = z.infer<typeof OrgRole>;

/** Role hierarchy for permission checks: higher index = more authority. */
export const ORG_ROLE_ORDER: OrgRole[] = ["viewer", "member", "admin", "owner"];

export const RegisterInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(256),
  displayName: z.string().min(1).max(120),
});

export const LoginInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export const CreateOrgInput = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, hyphens"),
});

export const AddMemberInput = z.object({
  email: z.string().email(),
  role: OrgRole,
});

// ---------------------------------------------------------------------------
// Projects & files
// ---------------------------------------------------------------------------

export const ProjectType = z.enum(["grant_application", "website", "other"]);

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  type: ProjectType,
});

export const UploadFileInput = z.object({
  filename: z.string().min(1).max(255),
  // Base64 payload keeps the slice transport-simple; multipart streaming is a
  // planned replacement and changes nothing downstream of the storage adapter.
  contentBase64: z.string().max(10_000_000),
  mime: z.enum([
    "text/plain", "text/markdown", "text/html",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
});

/** Structured grant reference — the Apply button sends this, not just text. */
export const GrantActionRef = z.object({
  type: z.literal("start_grant_application"),
  index: z.number().int().min(1).max(50).nullable().optional(),
  title: z.string().max(400),
  number: z.string().max(120).nullable().optional(),
  funder: z.string().max(300).nullable().optional(),
  closeDate: z.string().max(20).nullable().optional(),
  sourceUrl: z.string().max(1000).nullable().optional(),
  externalId: z.string().max(120).nullable().optional(),
});
export type GrantActionRef = z.infer<typeof GrantActionRef>;

// ---------------------------------------------------------------------------
// Grant domain — compliance matrix & sections
// ---------------------------------------------------------------------------

export const RequirementKind = z.enum([
  "eligibility",
  "narrative",
  "budget",
  "attachment",
  "formatting",
  "deadline",
  "other",
]);

export const SourceLocation = z.object({
  line: z.number().int().positive(),
  quote: z.string().min(1).max(2000),
});

export const ExtractedRequirement = z.object({
  text: z.string().min(1).max(4000),
  kind: RequirementKind,
  mandatory: z.boolean(),
  sourceLocation: SourceLocation,
  wordLimit: z.number().int().positive().nullable(),
});
export type ExtractedRequirement = z.infer<typeof ExtractedRequirement>;

/** Requirements Analyst output contract (agent output schema). */
export const RequirementsExtractionOutput = z.object({
  requirements: z.array(ExtractedRequirement).min(1),
  documentSummary: z.string().max(2000),
});
export type RequirementsExtractionOutput = z.infer<typeof RequirementsExtractionOutput>;

export const FactStatus = z.enum([
  "verified",
  "user_certified",
  "estimate",
  "assumption",
  "unsupported",
]);
export type FactStatus = z.infer<typeof FactStatus>;

export const OrgFact = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(4000),
  status: FactStatus,
});
export type OrgFact = z.infer<typeof OrgFact>;

/** A fact proposed from a real evidence document — every one must cite where
 *  it came from. This is the only path allowed to write status "verified". */
export const ExtractedFact = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(4000),
  sourceLocation: SourceLocation,
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

/** Fact Extractor output contract (agent output schema). */
export const FactExtractionOutput = z.object({
  facts: z.array(ExtractedFact),
  documentSummary: z.string().max(2000),
});
export type FactExtractionOutput = z.infer<typeof FactExtractionOutput>;

export const ResolveFactConflictInput = z.object({
  resolution: z.enum(["keep_current", "use_proposed"]),
});
export type ResolveFactConflictInput = z.infer<typeof ResolveFactConflictInput>;

export const LinkFileInput = z.object({
  fileId: z.string().uuid(),
});
export type LinkFileInput = z.infer<typeof LinkFileInput>;

export const SectionClaim = z.object({
  text: z.string().min(1).max(4000),
  factKey: z.string().nullable(),
  support: FactStatus,
  flagged: z.boolean(),
});
export type SectionClaim = z.infer<typeof SectionClaim>;

/** Grant Writer output contract (agent output schema). */
export const SectionDraftOutput = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1),
  claims: z.array(SectionClaim),
  wordCount: z.number().int().nonnegative(),
});
export type SectionDraftOutput = z.infer<typeof SectionDraftOutput>;

/** Answers to a structured information request.
 *
 *  Values are typed rather than stringly: a multiselect answers with an array
 *  and a yes/no with a boolean. The previous "key: value" text round trip lost
 *  any answer containing ": " or a newline. Plain strings stay valid, so every
 *  existing caller keeps working unchanged. */
export const ProvideInfoInput = z.object({
  facts: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        value: z.union([
          z.string().min(1).max(4000),
          z.array(z.string().min(1).max(200)).max(20),
          z.boolean(),
        ]),
      }),
    )
    .min(1),
});

export const ApprovalDecisionInput = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(2000).optional(),
});

export const StartGrantSliceInput = z.object({
  fileId: z.string().uuid(),
  opportunityTitle: z.string().min(1).max(300),
  funder: z.string().min(1).max(300),
  sectionTitle: z.string().min(1).max(300).default("Statement of Need"),
});

// ---------------------------------------------------------------------------
// Workflow engine
// ---------------------------------------------------------------------------

export const WorkflowRunStatus = z.enum([
  "pending",
  "running",
  "waiting_for_info",
  "waiting_approval",
  "suspended_budget",
  "failed",
  "completed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const ArtifactType = z.enum([
  "compliance_matrix",
  "grant_section",
  "export_package",
  "application_plan",
  "budget",
  "logic_model",
  "review_report",
  "compliance_report",
  "website_brief",
  "website_test_report",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export const AgentDefinition = z.object({
  agentKey: z.string().min(1).max(120),
  version: z.number().int().positive(),
  displayName: z.string(),
  team: z.enum(["core", "grant", "website"]),
  role: z.string(),
  instructions: z.string(),
  allowedTools: z.array(z.string()),
  outputSchemaRef: z.enum([
    "requirements_extraction",
    "fact_extraction",
    "section_draft",
    "section_plan",
    "budget",
    "logic_model",
    "review_panel",
    "website_brief",
    "site_content",
    "site_page",
    "site_patch",
    "intent",
    // "none" marks agents whose work is deterministic system logic (e.g. the
    // eligibility engine) — listed in the directory, never sent to a model.
    "none",
  ]),
  maxOutputRetries: z.number().int().min(0).max(5).default(2),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

// ---------------------------------------------------------------------------
// Phase 3 — Funding Passport
// ---------------------------------------------------------------------------

export const PassportField = z.object({
  key: z.string(),
  label: z.string(),
  section: z.string(),
  required: z.boolean(),
  hint: z.string().optional(),
  /** Form input type for structured info requests (default: text). */
  inputType: z.enum(["text", "textarea", "number", "date", "boolean", "choice"]).optional(),
  choices: z.array(z.string()).optional(),
});
export type PassportField = z.infer<typeof PassportField>;

/** One field of a structured information request shown to the user as a real
 *  form (message metadata.infoRequest). */
export const InfoRequestField = z.object({
  key: z.string(),
  label: z.string(),
  /** PassportField.inputType is a strict subset of this, so passport-derived
   *  requests keep validating unchanged. The extra types exist for website
   *  design intake, where a dropdown of five tones reads as a form and a row
   *  of cards reads as a choice. */
  inputType: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "boolean",
    "choice",
    "multiselect",
    "radio",
    "color",
    "url",
  ]),
  choices: z.array(z.string()).optional(),
  /** multiselect only: cap on how many choices may be selected. */
  maxSelections: z.number().int().positive().max(20).optional(),
  placeholder: z.string().max(120).optional(),
  help: z.string(),
  reason: z.string(),
  required: z.boolean(),
  group: z.string(),
});
export type InfoRequestField = z.infer<typeof InfoRequestField>;

// ---------------------------------------------------------------------------
// Phase 3 — Eligibility engine (deterministic; the model never decides)
// ---------------------------------------------------------------------------

export const EligibilityStatus = z.enum([
  "verified_eligible",
  "likely_eligible",
  "ineligible",
  "insufficient_information",
  "conflicting",
]);
export type EligibilityStatus = z.infer<typeof EligibilityStatus>;

export const EligibilityRuleKind = z.enum([
  "entity_type",
  "registration_required",
  "geography",
  "max_annual_budget",
  "deadline_future",
]);

export const EligibilityRule = z.object({
  ruleKey: z.string(),
  kind: EligibilityRuleKind,
  params: z.record(z.unknown()),
  sourceLine: z.number().int().nullable(),
});
export type EligibilityRule = z.infer<typeof EligibilityRule>;

export const RuleFinding = z.object({
  ruleKey: z.string(),
  status: z.enum(["pass", "fail", "unknown"]),
  evidence: z.string(),
  factKey: z.string().nullable(),
});
export type RuleFinding = z.infer<typeof RuleFinding>;

// ---------------------------------------------------------------------------
// Phase 3 — Bid/no-bid
// ---------------------------------------------------------------------------

export const BidDimension = z.object({
  key: z.string(),
  label: z.string(),
  score: z.number().min(0).max(5),
  weight: z.number(),
  note: z.string(),
});
export type BidDimension = z.infer<typeof BidDimension>;

export const BidRecommendation = z.enum(["apply", "do_not_apply", "needs_review"]);
export type BidRecommendation = z.infer<typeof BidRecommendation>;

/** Application Viability: can the org actually apply right now — independent
 *  of Mission Fit, and driven deterministically by eligibility + the
 *  opportunity's own status/deadline, never an LLM opinion. */
export const ApplicationViability = z.enum(["apply", "monitor", "closed", "not_eligible"]);
export type ApplicationViability = z.infer<typeof ApplicationViability>;

// ---------------------------------------------------------------------------
// Phase 3 — Agent output contracts
// ---------------------------------------------------------------------------

export const SectionPlanOutput = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        objective: z.string().min(1).max(2000),
        wordLimit: z.number().int().positive().nullable(),
        requirementLines: z.array(z.number().int()),
      })
    )
    .min(1)
    .max(12),
  activities: z.array(z.string().min(1).max(300)).min(1).max(20),
});
export type SectionPlanOutput = z.infer<typeof SectionPlanOutput>;

export const BudgetOutput = z.object({
  currency: z.literal("USD"),
  items: z
    .array(
      z.object({
        category: z.enum(["personnel", "direct", "indirect", "equipment", "travel", "other"]),
        description: z.string().min(1).max(400),
        activity: z.string().min(1).max(300),
        quantity: z.number().positive(),
        unitCost: z.number().nonnegative(),
      })
    )
    .min(1)
    .max(60),
  narrative: z.string().min(1),
});
export type BudgetOutput = z.infer<typeof BudgetOutput>;

export const LogicModelOutput = z.object({
  problem: z.string().min(1),
  inputs: z.array(z.string()).min(1),
  activities: z.array(z.string()).min(1),
  outputs: z.array(z.string()).min(1),
  outcomes: z.array(z.string()).min(1),
  impact: z.string().min(1),
  indicators: z
    .array(
      z.object({
        outcome: z.string(),
        indicator: z.string(),
        baseline: z.string(),
        target: z.string(),
        source: z.string(),
        frequency: z.string(),
      })
    )
    .min(1),
});
export type LogicModelOutput = z.infer<typeof LogicModelOutput>;

export const ReviewPanelOutput = z.object({
  reviews: z
    .array(
      z.object({
        reviewer: z.enum(["program", "financial", "compliance", "skeptic"]),
        criterion: z.string().min(1).max(300),
        score: z.number().min(0).max(5),
        maxScore: z.literal(5),
        strengths: z.string(),
        weaknesses: z.string(),
        fatalFlaw: z.boolean(),
      })
    )
    .min(4),
  revisionRecommendations: z.array(z.string()).max(20),
});
export type ReviewPanelOutput = z.infer<typeof ReviewPanelOutput>;

// ---------------------------------------------------------------------------
// Phase 3 — API inputs
// ---------------------------------------------------------------------------

export const GrantSearchInput = z.object({
  keyword: z.string().min(2).max(200),
});

export const ImportOpportunityInput = z.object({
  title: z.string().min(1).max(400),
  funder: z.string().min(1).max(300),
  opportunityNumber: z.string().max(100).nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  fundingMin: z.number().nonnegative().nullable().optional(),
  fundingMax: z.number().nonnegative().nullable().optional(),
  geography: z.string().max(200).nullable().optional(),
  sourceUrl: z.string().url().max(1000).nullable().optional(),
  source: z.enum(["manual", "grants_gov"]).default("manual"),
});

export const StartGrantApplicationInput = z.object({
  opportunityId: z.string().uuid(),
  fileId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Phase 4 — Website builder: structured content model (the CMS data model;
// chat is an interface to it, never a replacement for it — BRD §9 Stage 8)
// ---------------------------------------------------------------------------

export const SiteBlock = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hero"),
    heading: z.string().min(1).max(200),
    tagline: z.string().max(400),
    ctaText: z.string().max(60).nullable(),
    ctaHref: z.string().max(500).nullable(),
    /** Small line above the headline — "Kigali Province, Rwanda" or
     *  "Registered 501(c)(3)". Orients the reader before the claim. */
    eyebrow: z.string().max(80).nullable().optional(),
    /** Secondary action beside the primary one. */
    secondaryText: z.string().max(60).nullable().optional(),
    secondaryHref: z.string().max(500).nullable().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    heading: z.string().max(200).nullable(),
    body: z.string().min(1).max(8000),
  }),
  z.object({
    kind: z.literal("programs"),
    heading: z.string().max(200),
    items: z.array(z.object({ name: z.string().max(200), description: z.string().max(1000) })).min(1).max(12),
  }),
  z.object({
    kind: z.literal("stats"),
    items: z.array(z.object({ label: z.string().max(120), value: z.string().max(40) })).min(1).max(6),
  }),
  z.object({
    kind: z.literal("cta"),
    heading: z.string().max(200),
    buttonText: z.string().min(1).max(60),
    href: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal("form"),
    formKey: z.string().regex(/^[a-z0-9-]+$/).max(40),
    heading: z.string().max(200),
    fields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z0-9_]+$/).max(40),
          label: z.string().min(1).max(120),
          type: z.enum(["text", "email", "textarea"]),
          required: z.boolean(),
        })
      )
      .min(1)
      .max(10),
  }),
  z.object({
    kind: z.literal("contact"),
    email: z.string().max(320).nullable(),
    phone: z.string().max(60).nullable(),
    address: z.string().max(400).nullable(),
  }),
  // ---- richer layout vocabulary --------------------------------------------
  // These exist so a page can have rhythm — a wall of identical cards reads as
  // a template, and funders notice. Each renders to fixed, escaped markup; the
  // model still never emits HTML.
  z.object({
    kind: z.literal("quote"),
    quote: z.string().min(1).max(600),
    attribution: z.string().max(160).nullable(),
    role: z.string().max(160).nullable().default(null),
  }),
  z.object({
    kind: z.literal("steps"),
    heading: z.string().max(200),
    intro: z.string().max(600).nullable().default(null),
    items: z
      .array(z.object({ title: z.string().max(160), body: z.string().max(800) }))
      .min(2)
      .max(8),
  }),
  z.object({
    kind: z.literal("faq"),
    heading: z.string().max(200),
    items: z
      .array(z.object({ q: z.string().max(300), a: z.string().max(1500) }))
      .min(1)
      .max(12),
  }),
  z.object({
    kind: z.literal("team"),
    heading: z.string().max(200),
    members: z
      .array(z.object({
        name: z.string().max(120),
        role: z.string().max(120),
        bio: z.string().max(600).nullable().default(null),
      }))
      .min(1)
      .max(12),
  }),
  z.object({
    kind: z.literal("logos"),
    heading: z.string().max(200),
    /** Funders and partners, by name. Naming them is a credibility signal
     *  reviewers actively look for. */
    names: z.array(z.string().max(120)).min(1).max(24),
  }),
  z.object({
    kind: z.literal("split"),
    heading: z.string().max(200),
    body: z.string().min(1).max(3000),
    /** Short supporting facts shown in the panel beside the prose. */
    highlights: z.array(z.string().max(200)).max(6).default([]),
    ctaText: z.string().max(60).nullable().default(null),
    ctaHref: z.string().max(500).nullable().default(null),
  }),
  z.object({
    kind: z.literal("donate"),
    heading: z.string().max(200),
    body: z.string().max(800).nullable().default(null),
    href: z.string().min(1).max(500),
    /** Amount tiers with what each buys — concrete beats abstract. */
    tiers: z
      .array(z.object({ amount: z.string().max(24), effect: z.string().max(200) }))
      .max(4)
      .default([]),
    buttonText: z.string().max(60).default("Donate"),
  }),
]);
export type SiteBlock = z.infer<typeof SiteBlock>;

export const SitePage = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).max(60),
  title: z.string().min(1).max(200),
  blocks: z.array(SiteBlock).min(1).max(20),
  seoDescription: z.string().max(300),
});
export type SitePage = z.infer<typeof SitePage>;

export const SITE_PALETTES = [
  "forest", "ocean", "slate", "sunrise", "plum", "meadow", "harvest", "midnight",
] as const;

export const SiteTheme = z.object({
  palette: z.enum(SITE_PALETTES),
  headingFont: z.enum(["serif", "sans"]),
});
export type SiteTheme = z.infer<typeof SiteTheme>;

/** Digital Strategist output contract. */
export const WebsiteBriefOutput = z.object({
  objectives: z.array(z.string().max(300)).min(1).max(8),
  audiences: z.array(z.string().max(200)).min(1).max(8),
  tone: z.string().max(300),
  sitemap: z
    .array(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), title: z.string().max(200), purpose: z.string().max(300) }))
    .min(1)
    .max(10),
  theme: SiteTheme,
});
export type WebsiteBriefOutput = z.infer<typeof WebsiteBriefOutput>;

/** Website Copywriter output contract. */
export const SiteContentOutput = z.object({
  pages: z.array(SitePage).min(1).max(10),
  placeholders: z.array(z.string().max(300)).max(20),
});
export type SiteContentOutput = z.infer<typeof SiteContentOutput>;

/** One page, written on its own.
 *
 *  Pages are generated one per workflow step rather than all at once. A step
 *  body and its writes commit in a single transaction, so a single call that
 *  produces six pages is invisible until it finishes — the user watches a
 *  spinner for a minute. One page per step means one commit, one event, and
 *  one line of visible progress each time. */
export const SitePageOutput = z.object({
  page: SitePage,
  placeholders: z.array(z.string().max(300)).max(10),
});
export type SitePageOutput = z.infer<typeof SitePageOutput>;

/** Conversational-edit contract: a proposed patch, or an honest inability. */
export const SitePatchOutput = z.object({
  applied: z.boolean(),
  reason: z.string().max(500).nullable(),
  changeSummary: z.string().max(500),
  pages: z.array(SitePage).min(1).max(10),
});
export type SitePatchOutput = z.infer<typeof SitePatchOutput>;

/** First-path segments the site router owns; never valid site slugs
 *  (mirrored in apps/site-router — sites are served at <base>/<slug>/). */
export const RESERVED_SITE_SLUGS = new Set([
  "live", "preview", "forms", "healthz", "thanks", "api", "assets", "static",
]);

export const CreateWebsiteInput = z.object({
  siteName: z.string().min(2).max(120),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .refine((s) => !RESERVED_SITE_SLUGS.has(s), { message: "This name is reserved" }),
  donateUrl: z.string().url().max(500).nullable().optional(),
});

export const WebsiteUpdateInput = z.object({
  instruction: z.string().min(3).max(1000),
});

export const RollbackInput = z.object({
  releaseId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Executive Assistant — intent contract. The assistant reads the user's
// message plus workspace context and returns ONE typed action; execution is
// always deterministic server code. Free text never triggers actions directly.
// ---------------------------------------------------------------------------

export const IntentOutput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search_grants"), keyword: z.string().min(2).max(200) }),
  z.object({
    action: z.literal("start_grant_application"),
    // 1-based index into the most recent search results shown in this channel.
    resultIndex: z.number().int().min(1).max(20),
  }),
  z.object({ action: z.literal("build_website"), siteName: z.string().max(120).nullable() }),
  z.object({ action: z.literal("update_website"), instruction: z.string().min(3).max(1000) }),
  z.object({
    action: z.literal("provide_info"),
    facts: z.array(z.object({ key: z.string().min(1).max(120), value: z.string().min(1).max(4000) })).min(1),
  }),
  z.object({ action: z.literal("approve"), note: z.string().max(500).nullable() }),
  z.object({ action: z.literal("reject"), note: z.string().max(500).nullable() }),
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("answer"), text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal("clarify"), question: z.string().min(1).max(500) }),
]);
export type IntentOutput = z.infer<typeof IntentOutput>;

export const PostMessageInput = z.object({
  body: z.string().min(1).max(4000),
  /** IANA timezone of the sending client (e.g. "Europe/Berlin"). */
  timezone: z.string().max(64).nullable().optional(),
  fileId: z.string().uuid().nullable().optional(),
  /** Client-generated idempotency key: resends with the same key are no-ops. */
  clientKey: z.string().max(64).nullable().optional(),
  /** Present when the message is spoken inside an active huddle. */
  huddleId: z.string().uuid().nullable().optional(),
  /** Structured action from UI controls (e.g. the Apply button). */
  action: GrantActionRef.nullable().optional(),
});

export const RecordOutcomeInput = z.object({
  status: z.enum(["submitted", "not_submitted", "withdrawn", "awarded", "rejected", "waitlisted"]),
  awardAmount: z.number().nonnegative().nullable().optional(),
  feedback: z.string().max(4000).optional(),
  lessons: z.string().max(4000).optional(),
});
