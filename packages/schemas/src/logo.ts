import { z } from "zod";

/**
 * Brand Style's logo generator. Two model stages, each with its own contract:
 * the brief (what the logo must do, edited by the user before anything is
 * drawn) and the concepts (five deliberately different directions derived
 * from the approved brief, one image each).
 */
/** A logo type the concept planner has actually committed to — never "let
 *  the AI choose", which the planner resolves per concept. */
export const CONCRETE_LOGO_TYPES = ["wordmark", "lettermark", "emblem", "symbol_wordmark", "combination"] as const;
export const LOGO_TYPES = [...CONCRETE_LOGO_TYPES, "ai_choice"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const Hex = z.string().trim().regex(HEX, "Colours are hex, like #0d5527");
const Short = z.string().trim().min(1).max(200);
const Tags = z.array(Short).max(12);

export const LogoBrief = z.object({
  organizationName: z.string().trim().min(1).max(160),
  tagline: z.string().trim().max(200).nullable(),
  description: z.string().trim().min(1).max(1200),
  /** What the logo should communicate: trust, optimism, human connection… */
  objectives: Tags.min(1),
  audience: z.string().trim().min(1).max(600),
  personality: Tags.min(1),
  logoType: z.enum(LOGO_TYPES),
  visualStyle: Tags.min(1),
  colors: z.object({
    /** existing = Brand Style's colours, suggested = the model's proposal,
     *  custom = whatever the user typed. */
    mode: z.enum(["existing", "suggested", "custom"]),
    palette: z.array(Hex).min(1).max(6),
    notes: z.string().trim().max(400).nullable(),
  }),
  symbolism: Tags,
  avoid: Tags,
  designerNotes: z.string().trim().min(1).max(1200),
});
export type LogoBrief = z.infer<typeof LogoBrief>;

/** The brief as the model writes it. Identical to the edited brief — one
 *  contract for both, so nothing the user can type is something the model
 *  could not have proposed. */
export const LogoBriefOutput = LogoBrief;

export const LogoConcept = z.object({
  /** Short human label for the card: "Rising Path", "Monogram Weave". */
  title: z.string().trim().min(1).max(80),
  /** The creative direction this concept explores, distinct from the others. */
  approach: z.string().trim().min(1).max(80),
  logoType: z.enum(CONCRETE_LOGO_TYPES),
  /** Art direction for the image model: the mark's forms, the type, the layout. */
  direction: z.string().trim().min(1).max(900),
});
export type LogoConcept = z.infer<typeof LogoConcept>;

/** Bounded at 6: each concept is one image generation. */
export const LogoConceptsOutput = z.object({
  concepts: z.array(LogoConcept).min(3).max(6),
});
export type LogoConceptsOutput = z.infer<typeof LogoConceptsOutput>;
