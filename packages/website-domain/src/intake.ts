import type { InfoRequestField } from "@deedwell/schemas";

/**
 * Website design intake — the questions the website team asks that are NOT
 * organizational facts.
 *
 * The Funding Passport (PASSPORT_FIELDS) records what is true about the
 * organization: mission, service area, budget. Those are shared across grants
 * and websites and belong in org_facts. This catalog is the other half — how
 * this particular site should look, sound, and what it should ask visitors to
 * do. Those answers are per-site and live in site_intake_answers.
 *
 * Every field here is OPTIONAL by design. A website build must never hard-block
 * on a design preference: the team can and should pick sensible defaults when
 * the user would rather not decide. Asking is the product; gating is not.
 */

export type IntakeStage = "essentials" | "direction";

export interface WebsiteIntakeField {
  key: string;
  stage: IntakeStage;
  label: string;
  inputType: InfoRequestField["inputType"];
  choices?: string[];
  maxSelections?: number;
  placeholder?: string;
  help: string;
  /** Why the team is asking. Shown under the input; never a canned sentence. */
  reason: string;
  required: boolean;
  group: string;
}

/**
 * Organizational facts the website genuinely cannot be written without. These
 * are passport keys, resolved against org_facts, not asked here.
 */
export const WEBSITE_ESSENTIAL_FACTS = [
  "mission",
  "programs",
  "beneficiaries",
  "service_area",
  "headquarters",
] as const;

/**
 * Written as a real row when the user chooses "let the team decide", so the
 * durable re-read on resume sees the decision. Never inferred from a signal —
 * engine.signal() truncates its payload to a string, so signals are a hint
 * that something happened, not a record of what.
 */
export const INTAKE_SKIP_KEY = "site_intake_skipped";

export const WEBSITE_INTAKE_FIELDS: WebsiteIntakeField[] = [
  // ---- Voice & audience ---------------------------------------------------
  {
    key: "site_primary_audience",
    stage: "direction",
    label: "Who is this site mainly for?",
    inputType: "multiselect",
    choices: [
      "Donors",
      "Volunteers",
      "People we serve",
      "Partner organizations",
      "Grantmakers",
      "Press",
      "Our board",
    ],
    maxSelections: 3,
    help: "Pick up to three. The pages are written for whoever you choose first.",
    reason:
      "A site written for donors and a site written for the people you serve say different things on the same page.",
    required: false,
    group: "Voice & audience",
  },
  {
    key: "site_tone",
    stage: "direction",
    label: "How should it sound?",
    inputType: "radio",
    choices: [
      "Warm and personal",
      "Calm and credible",
      "Bold and urgent",
      "Editorial and serious",
      "Playful and bright",
    ],
    help: "",
    reason: "This sets the writing voice across every page, not just the homepage.",
    required: false,
    group: "Voice & audience",
  },
  // ---- Look & feel --------------------------------------------------------
  {
    key: "site_visual_direction",
    stage: "direction",
    label: "What should it look like?",
    inputType: "radio",
    choices: [
      "Clean and minimal",
      "Photo-led and warm",
      "Editorial and typographic",
      "Bold and high-contrast",
    ],
    help: "",
    reason: "This picks the colour palette and heading style for the whole site.",
    required: false,
    group: "Look & feel",
  },
  {
    key: "site_brand_primary_color",
    stage: "direction",
    label: "Your main brand colour",
    inputType: "color",
    help: "Leave blank if you don't have one — the team will choose a palette that passes contrast checks.",
    reason:
      "If you already have brand colours we build around them instead of inventing new ones.",
    required: false,
    group: "Look & feel",
  },
  {
    key: "site_brand_secondary_color",
    stage: "direction",
    label: "A secondary colour",
    inputType: "color",
    help: "Optional.",
    reason: "Used for accents and buttons where the main colour would be too heavy.",
    required: false,
    group: "Look & feel",
  },
  {
    key: "site_has_logo",
    stage: "direction",
    label: "Do you have a logo we should use?",
    inputType: "boolean",
    help: "",
    reason: "If you do, upload it in the channel and the header will use it instead of your name in text.",
    required: false,
    group: "Look & feel",
  },
  {
    key: "site_photography",
    stage: "direction",
    label: "What photography do you have?",
    inputType: "radio",
    choices: [
      "We have our own photos to use",
      "We have a few, but not enough",
      "None — use illustration and colour instead",
    ],
    help: "",
    reason:
      "Real photos of your own work always beat generated imagery, and grant reviewers notice the difference. We only generate images where you have gaps.",
    required: false,
    group: "Look & feel",
  },
  // ---- What visitors do ---------------------------------------------------
  {
    key: "site_primary_cta",
    stage: "direction",
    label: "What is the one thing you most want visitors to do?",
    inputType: "choice",
    choices: ["Donate", "Volunteer", "Get help", "Contact us", "Subscribe", "Attend an event"],
    help: "",
    reason: "This becomes the main button on the homepage and repeats through the site.",
    required: false,
    group: "What visitors do",
  },
  {
    key: "site_donate_url",
    stage: "direction",
    label: "Where should donate buttons point?",
    inputType: "url",
    placeholder: "https://",
    help: "Your existing donation page — we don't process payments.",
    reason:
      "Without this, donate buttons have nowhere to go and get left off the site rather than linking somewhere broken.",
    required: false,
    group: "What visitors do",
  },
  {
    key: "site_contact_email",
    stage: "direction",
    label: "Public contact email",
    inputType: "text",
    placeholder: "hello@example.org",
    help: "",
    reason: "Shown on the contact page and used as the destination described on the form.",
    required: false,
    group: "What visitors do",
  },
  {
    key: "site_key_pages",
    stage: "direction",
    label: "Which pages do you need?",
    inputType: "multiselect",
    choices: [
      "Home",
      "About",
      "Programs",
      "Impact",
      "Get involved",
      "Events",
      "News",
      "Contact",
      "Donate",
    ],
    maxSelections: 7,
    help: "Leave blank and the team will propose a sitemap for your approval.",
    reason: "You approve the sitemap before anything is written, so this is a starting point, not a commitment.",
    required: false,
    group: "What visitors do",
  },
  // ---- Existing presence --------------------------------------------------
  {
    key: "site_existing_url",
    stage: "direction",
    label: "Do you have a site today?",
    inputType: "url",
    placeholder: "https://",
    help: "Optional.",
    reason: "Helps the team avoid contradicting what you already tell the public.",
    required: false,
    group: "Existing presence",
  },
  {
    key: "site_must_keep",
    stage: "direction",
    label: "Anything from your current site we must keep?",
    inputType: "textarea",
    help: "Specific wording, a funder acknowledgement, a required disclaimer.",
    reason:
      "Some funders and regulators require exact wording to appear. We'd rather carry it over than have you catch it after launch.",
    required: false,
    group: "Existing presence",
  },
];

export const WEBSITE_INTAKE_KEYS: Set<string> = new Set([
  ...WEBSITE_INTAKE_FIELDS.map((f) => f.key),
  INTAKE_SKIP_KEY,
]);

/** Every direction-stage key, used to decide whether the round is exhausted. */
export const WEBSITE_DIRECTION_KEYS: string[] = WEBSITE_INTAKE_FIELDS.filter(
  (f) => f.stage === "direction",
).map((f) => f.key);

/**
 * The fields still worth asking: the catalog minus what's already answered.
 *
 * Recomputed at read time rather than stored, because the wait payload is
 * truncated to 800 characters by summarize() and could never carry a question
 * set. Deriving it also means a catalog change applies to runs already in
 * flight instead of replaying a stale snapshot.
 */
export function websiteIntakeFields(
  stage: IntakeStage,
  answered: ReadonlySet<string>,
): WebsiteIntakeField[] {
  return WEBSITE_INTAKE_FIELDS.filter((f) => f.stage === stage && !answered.has(f.key));
}

/** Catalog entry lookup, for routing an incoming answer to the right table. */
export function websiteIntakeField(key: string): WebsiteIntakeField | undefined {
  return WEBSITE_INTAKE_FIELDS.find((f) => f.key === key);
}
