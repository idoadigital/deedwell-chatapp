import { z } from "zod";
import { DesignTokens } from "./website-builder.js";
import { SiteBlock } from "./index.js";

// ---------------------------------------------------------------------------
// Website studio — the AI editor's plan and the QA reviewer's report. Both
// are proposals over the site's working state (copy blocks, per-page
// composition plans, design tokens, and a scoped-CSS overrides layer); the
// renderer is deterministic, so nothing a model writes reaches a page as
// markup. Every operation is small on purpose: the editor changes the
// minimum the request needs, and everything it changes can be measured.
// ---------------------------------------------------------------------------

export const EditViewport = z.enum(["all", "mobile", "tablet", "desktop"]);
export type EditViewport = z.infer<typeof EditViewport>;

/** A CSS selector inside a page: ids, classes, tags, descendant/child
 *  combinators and simple attribute selectors only. */
export const SafeSelector = z.string().min(1).max(160).regex(/^[A-Za-z0-9_\-#.\s>:\[\]="'*+~,()]+$/);

export const StyleOverride = z.object({
  /** Page slug, or "*" for every page. */
  page: z.string().max(60),
  selector: SafeSelector,
  viewport: EditViewport.default("all"),
  /** CSS declarations, property → value. Validated by the renderer against
   *  an allow-list of properties and a value grammar with no URLs. */
  declarations: z.record(z.string().max(40), z.string().max(200)).refine((d) => Object.keys(d).length > 0 && Object.keys(d).length <= 12),
  /** What the override is for, in the editor's words ("smaller hero heading on phones"). */
  note: z.string().max(160).optional(),
});
export type StyleOverride = z.infer<typeof StyleOverride>;

const SectionSet = z.object({
  component: z.string().max(40).optional(),
  variant: z.string().max(40).optional(),
  background: z.enum(["default", "muted", "surface", "dark", "primary", "accent-tint"]).optional(),
  imagePosition: z.enum(["none", "left", "right", "background", "top", "full"]).optional(),
  image: z.string().max(40).nullable().optional(),
  density: z.enum(["airy", "balanced", "dense"]).optional(),
  motion: z.enum(["none", "fade-up", "stagger", "image-reveal", "count", "parallax"]).optional(),
  overrides: z.object({ eyebrow: z.string().max(80).optional(), heading: z.string().max(140).optional(), body: z.string().max(600).optional() }).optional(),
});

export const SiteEditOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("style"), ...StyleOverride.shape }),
  z.object({ kind: z.literal("section"), page: z.string().max(60), sectionId: z.string().max(40), set: SectionSet }),
  z.object({ kind: z.literal("section-move"), page: z.string().max(60), sectionId: z.string().max(40), position: z.number().int().min(0).max(11) }),
  z.object({ kind: z.literal("section-remove"), page: z.string().max(60), sectionId: z.string().max(40) }),
  z.object({
    kind: z.literal("section-add"), page: z.string().max(60),
    /** Insert after this section, or first when null. */
    afterSectionId: z.string().max(40).nullable(),
    component: z.string().max(40), variant: z.string().max(40).optional(),
    background: z.enum(["default", "muted", "surface", "dark", "primary", "accent-tint"]).optional(),
    /** A new copy block the section presents, or the index of an existing one. */
    // Lazy: index.ts re-exports this module, so SiteBlock is not initialised yet at load time.
    block: z.union([z.lazy(() => SiteBlock), z.number().int().min(0)]),
    purpose: z.string().max(200).default("Added by the editor"),
  }),
  z.object({
    kind: z.literal("copy"), page: z.string().max(60), blockIndex: z.number().int().min(0),
    /** Dot path inside the block ("heading", "items.0.description", "body"). */
    field: z.string().max(60).regex(/^[a-zA-Z]+(\.[a-zA-Z0-9]+)*$/),
    value: z.string().max(8000),
  }),
  z.object({ kind: z.literal("tokens"), patch: DesignTokens.deepPartial() }),
  /** The site's logo is the organization's brand logo (Mission Profile →
   *  Brand Style): "use-brand" puts the current one on every page (and
   *  refreshes it after a new upload), "remove" takes it off. Works on
   *  designed pages too — the brand mark is patched, not re-rendered. */
  z.object({ kind: z.literal("logo"), action: z.enum(["use-brand", "remove"]) }),
  z.object({ kind: z.literal("page-cta"), page: z.string().max(60), primaryCta: z.object({ label: z.string().max(40), href: z.string().max(500) }).nullable() }),
]);
export type SiteEditOp = z.infer<typeof SiteEditOp>;

export const EditExpectation = z.object({
  selector: SafeSelector,
  viewport: z.number().int().min(320).max(1920),
  property: z.enum(["fontSize", "height", "width", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "gap", "lineHeight", "top", "color", "backgroundColor", "display"]),
  direction: z.enum(["decrease", "increase", "equal", "change"]),
});

export const SiteEditPlan = z.object({
  understood: z.boolean(),
  /** When not understood: the question to ask back. */
  clarification: z.string().max(400).nullable(),
  /** Short title for the version history ("Hero typography updated"). */
  title: z.string().max(60),
  /** What will be done, one or two sentences, before the work starts. */
  summary: z.string().max(400),
  /** The conversational reply once the work is verified. */
  reply: z.string().max(600),
  affectedPages: z.array(z.string().max(60)).max(20),
  /** Widths to verify at, in px; the editor always adds the one the user is looking at. */
  viewports: z.array(z.number().int().min(320).max(1920)).max(4),
  operations: z.array(SiteEditOp).max(12),
  expectations: z.array(EditExpectation).max(8).default([]),
});
export type SiteEditPlan = z.infer<typeof SiteEditPlan>;

// ---- QA -------------------------------------------------------------------

export const QaSeverity = z.enum(["critical", "high", "medium", "low"]);
export const QaCategory = z.enum(["visual", "responsive", "navigation", "header", "footer", "imagery", "content", "accessibility", "functionality", "mission", "blog", "events", "donations"]);

/** The reviewer reads page text and the Mission Profile; it names problems
 *  it is sure of and never invents organisation facts. */
export const SiteQaReview = z.object({
  missionClear: z.boolean(),
  summary: z.string().max(400),
  issues: z.array(z.object({
    page: z.string().max(60),
    category: z.enum(["content", "mission", "footer", "navigation"]),
    severity: QaSeverity,
    title: z.string().max(120),
    description: z.string().max(400),
    /** The exact text on the page the issue refers to, when there is one. */
    quote: z.string().max(200).nullable(),
    /** A replacement for that quote when the fix is a wording change and the facts support it; otherwise null. */
    replacement: z.string().max(400).nullable(),
  })).max(30),
});
export type SiteQaReview = z.infer<typeof SiteQaReview>;

// ---- API inputs -------------------------------------------------------------

export const SiteEditorMessageInput = z.object({
  body: z.string().min(2).max(2000),
  context: z.object({
    page: z.string().max(60).optional(),
    viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
    /** Homepage → Hero → Heading, plus the selector the preview resolved. */
    selection: z.object({ label: z.string().max(120), selector: SafeSelector, sectionId: z.string().max(40).nullable().optional(), text: z.string().max(200).optional() }).nullable().optional(),
  }).default({}),
});

export const SiteQaStartInput = z.object({
  instruction: z.string().max(1000).optional(),
  scope: z.enum(["full", "instruction"]).default("full"),
});

export const SitePostInput = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(80).optional(),
  excerpt: z.string().max(600).default(""),
  content: z.string().max(60000).default(""),
  author: z.string().max(120).nullable().optional(),
  featuredImageKey: z.string().max(80).nullable().optional(),
  status: z.enum(["draft", "published"]).optional(),
  publishedAt: z.string().datetime().nullable().optional(),
  seoTitle: z.string().max(120).nullable().optional(),
  seoDescription: z.string().max(300).nullable().optional(),
});

export const SiteEventInput = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(80).optional(),
  description: z.string().max(20000).default(""),
  featuredImageKey: z.string().max(80).nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  mode: z.enum(["in_person", "virtual", "hybrid"]).default("in_person"),
  registrationUrl: z.string().url().max(500).nullable().optional(),
  ctaLabel: z.string().max(60).nullable().optional(),
  organizer: z.string().max(200).nullable().optional(),
  status: z.enum(["draft", "published", "cancelled"]).optional(),
});

export const SiteDonationsInput = z.object({
  donateUrl: z.string().url().max(500).nullable().optional(),
  heading: z.string().max(120).nullable().optional(),
  blurb: z.string().max(600).nullable().optional(),
  presets: z.array(z.number().int().positive().max(100000)).max(6).optional(),
  monthly: z.boolean().optional(),
});

export const SiteDomainInput = z.object({
  domain: z.string().min(4).max(253).transform((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .refine((d) => /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d), { message: "Enter a domain such as www.example.org" }),
});

export const SitePageStatusInput = z.object({ status: z.enum(["published", "hidden"]) });

/** A featured image for a post or event; the site router serves it at /media/<key>. */
export const SiteMediaInput = z.object({
  filename: z.string().min(1).max(255),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  contentBase64: z.string().min(1).max(11_000_000),
});
