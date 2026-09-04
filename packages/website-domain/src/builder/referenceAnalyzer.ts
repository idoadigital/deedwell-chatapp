import type { ModelProvider } from "@deedwell/agent-runtime";
import type { ReferenceTemplate } from "../site-generation.js";
import { DesignLanguage } from "./schemas.js";

/**
 * Stage 1. A vision model reads the reference image and describes its
 * design language — never its content, never pixel-for-pixel. The result is
 * the visual source of truth for every later stage.
 */
const SYSTEM = `You are a senior brand and web design director. You analyse a reference design image and describe
its DESIGN LANGUAGE as structured data: how it uses space, type, colour, imagery, structure and motion.
Describe the language, not the content: never its words, brand, organization or subject matter.
Choose from the allowed values only. Colours as #rrggbb hex read from the image.
Respond only with JSON matching the required output schema.`;

export const DEFAULT_LANGUAGE: DesignLanguage = {
  style: "editorial-modern", mood: "warm, credible, human", density: "spacious", rhythm: "alternating-bands",
  contentWidth: "1200", sectionSpacing: "generous", whitespace: "generous margins, one idea per section",
  background: "warm-light",
  typography: { headingStyle: "serif-editorial", bodyStyle: "sans", headingScale: "controlled", bodyScale: "comfortable", weightContrast: "medium", letterCase: "uppercase-eyebrows" },
  radius: "small", cards: "minimal", buttons: "rounded", navigation: "light-minimal", imageTreatment: "large-contained",
  grid: "asymmetric", alignment: "left", transitions: "soft-tints", fullWidthImagery: true, overlays: false, gradients: "none",
  contrast: "light-dominant", layoutCharacter: "editorial", symmetry: "asymmetric", decorative: [], motionStyle: "subtle",
  motionOpportunities: ["fade-up on sections", "counters on metrics"],
  palette: { primary: "#1f5f4a", secondary: "#e8dcc8", accent: "#c8632b", background: "#fbf8f2" },
};

export async function analyzeReference(provider: ModelProvider, reference: ReferenceTemplate | null, hints: { visualDirection?: string | null; brandPrimary?: string | null }): Promise<DesignLanguage> {
  if (!reference) {
    const lang = { ...DEFAULT_LANGUAGE };
    if (hints.brandPrimary && /^#[0-9a-fA-F]{6}$/.test(hints.brandPrimary)) lang.palette = { ...lang.palette, primary: hints.brandPrimary };
    return lang;
  }
  const res = await provider.complete({
    system: SYSTEM,
    task: "Describe the design language of the attached reference image.",
    outputSchemaRef: "design_language",
    dataBlocks: [
      { label: "design_reference", content: `Reference design "${reference.title}". ${reference.description}`, image: { mime: reference.mime, base64: reference.bytes.toString("base64") } },
      ...(hints.visualDirection ? [{ label: "requested_direction", content: hints.visualDirection }] : []),
    ],
  });
  const parsed = DesignLanguage.safeParse(JSON.parse(res.text));
  if (!parsed.success) throw new Error(`Reference analysis did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return parsed.data;
}
