import { z } from "zod";

/**
 * Structured contracts between generation stages. Each stage reads the
 * previous stage's output and produces one of these; nothing downstream may
 * override what an earlier stage decided (the renderer, for instance, only
 * ever consumes tokens, never invents sizes).
 */

// ---- Stage 1: reference analysis → design language ------------------------

export const DesignLanguage = z.object({
  style: z.enum(["editorial-modern", "editorial-classic", "warm-community", "bold-expressive", "minimal-corporate", "civic-institutional", "playful-friendly"]),
  mood: z.string().max(200),
  density: z.enum(["spacious", "balanced", "compact"]),
  rhythm: z.enum(["alternating-bands", "continuous", "image-led", "text-led"]),
  contentWidth: z.enum(["1100", "1200", "1320", "1440"]),
  sectionSpacing: z.enum(["generous", "standard", "tight"]),
  whitespace: z.string().max(200),
  background: z.enum(["light", "warm-light", "dark", "alternating", "tinted-bands"]),
  typography: z.object({
    headingStyle: z.enum(["serif-editorial", "serif-classic", "sans-geometric", "sans-humanist", "sans-grotesque", "display-condensed"]),
    bodyStyle: z.enum(["serif", "sans"]),
    headingScale: z.enum(["restrained", "controlled", "large", "dramatic"]),
    bodyScale: z.enum(["compact", "comfortable", "generous"]),
    weightContrast: z.enum(["low", "medium", "high"]),
    letterCase: z.enum(["sentence", "title", "uppercase-eyebrows"]),
  }),
  radius: z.enum(["none", "small", "medium", "large", "pill"]),
  cards: z.enum(["none", "minimal", "bordered", "elevated", "filled"]),
  buttons: z.enum(["square", "rounded", "pill", "underline"]),
  navigation: z.enum(["transparent-over-hero", "light-minimal", "dark-minimal", "floating-editorial", "centered"]),
  imageTreatment: z.enum(["full-bleed-editorial", "large-contained", "rounded-contained", "duotone-overlay", "sparse"]),
  grid: z.enum(["strict-12", "asymmetric", "single-column-editorial", "mixed"]),
  alignment: z.enum(["left", "centered", "mixed"]),
  transitions: z.enum(["hard-bands", "soft-tints", "none"]),
  fullWidthImagery: z.boolean(),
  overlays: z.boolean(),
  gradients: z.enum(["none", "subtle", "prominent"]),
  contrast: z.enum(["light-dominant", "dark-dominant", "mixed"]),
  layoutCharacter: z.enum(["editorial", "corporate", "expressive"]),
  symmetry: z.enum(["symmetric", "asymmetric", "mixed"]),
  decorative: z.array(z.string().max(80)).max(6),
  motionStyle: z.enum(["none", "subtle", "subtle-cinematic", "lively"]),
  motionOpportunities: z.array(z.string().max(120)).max(8),
  palette: z.object({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    notes: z.string().max(200).optional(),
  }),
});
export type DesignLanguage = z.infer<typeof DesignLanguage>;

// ---- Stage 2: design tokens ----------------------------------------------

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const DesignTokens = z.object({
  typography: z.object({
    headingFamily: z.enum(["serif-editorial", "serif-classic", "sans-geometric", "sans-humanist", "sans-grotesque", "display-condensed"]),
    bodyFamily: z.enum(["serif", "sans"]),
    /** Picks one of the renderer's fixed, tested clamp() scales. */
    scale: z.enum(["restrained", "controlled", "large", "dramatic"]),
    bodySize: z.enum(["compact", "comfortable", "generous"]),
    headingWeight: z.enum(["500", "600", "700", "800"]),
    bodyWeight: z.enum(["400", "450"]),
    headingLetterSpacing: z.enum(["tight", "normal", "wide"]),
    eyebrowCase: z.enum(["uppercase", "normal"]),
  }),
  spacing: z.object({
    /** Multiplier on the fixed 4/8/12/16/24/32/48/64/80/120/160 scale. */
    density: z.enum(["spacious", "balanced", "compact"]),
    sectionPadding: z.enum(["generous", "standard", "tight"]),
  }),
  colors: z.object({
    primary: Hex, secondary: Hex, accent: Hex,
    background: Hex, surface: Hex, muted: Hex,
    foreground: Hex, foregroundMuted: Hex, border: Hex,
    onPrimary: Hex, onAccent: Hex,
    dark: Hex, onDark: Hex,
  }),
  layout: z.object({
    contentWidth: z.enum(["1100", "1200", "1320", "1440"]),
    narrowWidth: z.enum(["680", "760", "820"]),
    gutter: z.enum(["16", "20", "24"]),
    grid: z.enum(["strict-12", "asymmetric", "single-column-editorial", "mixed"]),
    alignment: z.enum(["left", "centered", "mixed"]),
  }),
  components: z.object({
    buttonRadius: z.enum(["0", "4", "8", "12", "999"]),
    inputRadius: z.enum(["0", "4", "8", "12"]),
    cardRadius: z.enum(["0", "8", "12", "16", "24"]),
    imageRadius: z.enum(["0", "8", "12", "16", "24"]),
    borderWidth: z.enum(["1", "2"]),
    shadow: z.enum(["none", "soft", "medium"]),
    cardStyle: z.enum(["none", "minimal", "bordered", "elevated", "filled"]),
    buttonStyle: z.enum(["square", "rounded", "pill", "underline"]),
    navHeight: z.enum(["64", "72", "80", "88"]),
    iconSize: z.enum(["20", "24", "28"]),
  }),
  header: z.enum(["transparent-over-hero", "light-minimal", "dark-minimal", "floating-editorial", "centered"]),
  imageTreatment: z.enum(["full-bleed-editorial", "large-contained", "rounded-contained", "duotone-overlay", "sparse"]),
  motion: z.enum(["none", "subtle", "subtle-cinematic", "lively"]),
  backgroundRhythm: z.enum(["light", "warm-light", "dark", "alternating", "tinted-bands"]),
});
export type DesignTokens = z.infer<typeof DesignTokens>;

// ---- Stage 5/6: page composition (component selection + configuration) ----

export const COMPONENTS = [
  // heroes
  "EditorialHero", "FullBleedImageHero", "SplitHero", "ImpactHero", "MinimalHero", "StoryHero",
  // content
  "EditorialTextSection", "SplitStorySection", "ImageTextSection", "QuoteSection", "ManifestoSection",
  // impact
  "ImpactMetrics", "StatisticsBand", "OutcomesGrid",
  // programs
  "ProgramEditorialGrid", "ProgramFeature", "ProgramCards", "ProgramTimeline",
  // stories
  "TestimonialFeature", "StoryGrid",
  // engagement
  "DonateCTA", "DonateModule", "VolunteerCTA", "GetInvolvedSection", "NewsletterCTA",
  // media
  "FullBleedImage", "ImageStrip",
  // other
  "TeamGrid", "PartnersStrip", "FAQ", "ContactSection", "ProseSection",
] as const;
export type ComponentName = (typeof COMPONENTS)[number];

export const Section = z.object({
  id: z.string().max(40),
  purpose: z.string().max(200),
  component: z.enum(COMPONENTS),
  /** Component-specific variant, from the catalog's list for that component. */
  variant: z.string().max(40).optional(),
  background: z.enum(["default", "muted", "surface", "dark", "primary", "accent-tint"]).default("default"),
  imagePosition: z.enum(["none", "left", "right", "background", "top", "full"]).default("none"),
  /** Key of one of the site's generated images, or null. */
  image: z.string().max(40).nullable().default(null),
  /** Index into the page's copywriter blocks this section presents. */
  block: z.number().int().min(0),
  density: z.enum(["airy", "balanced", "dense"]).default("balanced"),
  motion: z.enum(["none", "fade-up", "stagger", "image-reveal", "count", "parallax"]).default("fade-up"),
  mobile: z.enum(["stack", "carousel-free", "collapse"]).default("stack"),
  /** Light copy edits the planner may make for the web (shorter), never new facts. */
  overrides: z.object({
    eyebrow: z.string().max(80).optional(),
    heading: z.string().max(140).optional(),
    body: z.string().max(600).optional(),
  }).optional(),
});
export type Section = z.infer<typeof Section>;

export const PageComposition = z.object({
  slug: z.string(),
  objective: z.string().max(200),
  primaryCta: z.object({ label: z.string().max(40), href: z.string().max(500) }).nullable(),
  secondaryCta: z.object({ label: z.string().max(40), href: z.string().max(500) }).nullable(),
  sections: z.array(Section).min(1).max(12),
});
export type PageComposition = z.infer<typeof PageComposition>;

// ---- Stage 10/11: critique → repair --------------------------------------

export const CriticIssue = z.object({
  section: z.string().max(40).nullable(),
  problem: z.string().max(240),
  severity: z.enum(["low", "medium", "high"]),
  /** A repair from the fixed vocabulary the repair pass can apply. */
  fix: z.enum([
    "reduce-heading-scale", "shorten-copy", "change-variant", "swap-image-position",
    "change-background", "increase-spacing", "reduce-spacing", "remove-motion",
    "split-section", "remove-section", "left-align", "constrain-width", "none",
  ]),
  /** For change-variant: the variant to use. */
  value: z.string().max(40).optional(),
});
export const CriticReport = z.object({
  scores: z.object({
    visualHierarchy: z.number().min(1).max(10), typography: z.number().min(1).max(10),
    spacing: z.number().min(1).max(10), alignment: z.number().min(1).max(10),
    consistency: z.number().min(1).max(10), readability: z.number().min(1).max(10),
    imageComposition: z.number().min(1).max(10), ctaClarity: z.number().min(1).max(10),
    brandConsistency: z.number().min(1).max(10), animationQuality: z.number().min(1).max(10),
    responsiveQuality: z.number().min(1).max(10), accessibility: z.number().min(1).max(10),
    overallPolish: z.number().min(1).max(10),
  }),
  issues: z.array(CriticIssue).max(12),
});
export type CriticReport = z.infer<typeof CriticReport>;
export type CriticIssue = z.infer<typeof CriticIssue>;
