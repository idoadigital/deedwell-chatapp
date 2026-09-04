import type { ModelProvider } from "@deedwell/agent-runtime";
import { DesignTokens, type DesignLanguage } from "./schemas.js";
import { harmonizeColors } from "./tokens.js";

/**
 * Stage 2. The design language plus any brand facts become a constrained
 * token set. The model chooses among fixed scales and writes colours; the
 * contrast rules then correct the colours it wrote. Nothing after this stage
 * may pick a size or a colour of its own.
 */
const SYSTEM = `You are a design-systems lead. From a described design language and the organization's brand
information, choose design tokens. You can only choose from the allowed values; the renderer owns the actual
scales. Colours must be real hex values; foreground on background and onPrimary on primary must clear
WCAG AA (4.5:1). Prefer the brand's primary colour when one is given. Choose a header variant that fits the
language, and a motion level no livelier than the language suggests.
Respond only with JSON matching the required output schema.`;

export interface BrandHints {
  primaryColor?: string | null;
  secondaryColor?: string | null;
  tone?: string | null;
  visualDirection?: string | null;
}

export async function generateDesignSystem(provider: ModelProvider, language: DesignLanguage, brand: BrandHints): Promise<{ tokens: DesignTokens; adjustments: string[] }> {
  const res = await provider.complete({
    system: SYSTEM,
    task: "Choose the design tokens for this site.",
    outputSchemaRef: "design_tokens",
    dataBlocks: [
      { label: "design_language", content: JSON.stringify(language) },
      { label: "brand", content: JSON.stringify(brand) },
    ],
  });
  const parsed = DesignTokens.safeParse(JSON.parse(res.text));
  const tokens = parsed.success ? parsed.data : fallbackTokens(language, brand);
  const adjustments: string[] = parsed.success ? [] : [`model tokens rejected (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}); derived from the design language instead`];
  // The language decides these; the model may not drift from it.
  tokens.header = language.navigation;
  tokens.typography.scale = language.typography.headingScale;
  tokens.spacing.density = language.density;
  tokens.motion = language.motionStyle;
  const fixed = harmonizeColors(tokens.colors);
  tokens.colors = fixed.colors;
  return { tokens, adjustments: [...adjustments, ...fixed.adjustments] };
}

export function fallbackTokens(language: DesignLanguage, brand: BrandHints): DesignTokens {
  const primary = (brand.primaryColor && /^#[0-9a-fA-F]{6}$/.test(brand.primaryColor)) ? brand.primaryColor : language.palette.primary;
  const dark = language.contrast === "dark-dominant";
  return DesignTokens.parse({
    typography: {
      headingFamily: language.typography.headingStyle, bodyFamily: language.typography.bodyStyle,
      scale: language.typography.headingScale, bodySize: language.typography.bodyScale,
      headingWeight: language.typography.weightContrast === "high" ? "700" : language.typography.weightContrast === "low" ? "500" : "600",
      bodyWeight: "400", headingLetterSpacing: language.typography.headingStyle.startsWith("serif") ? "tight" : "normal",
      eyebrowCase: language.typography.letterCase === "uppercase-eyebrows" ? "uppercase" : "normal",
    },
    spacing: { density: language.density, sectionPadding: language.sectionSpacing },
    colors: {
      primary, secondary: language.palette.secondary ?? "#e8e2d6", accent: language.palette.accent ?? primary,
      background: language.palette.background ?? (dark ? "#141614" : "#fbf9f5"), surface: "#ffffff", muted: "#f2eee7",
      foreground: "#1b1b1b", foregroundMuted: "#5a5a5a", border: "#e2ddd3", onPrimary: "#ffffff", onAccent: "#ffffff",
      dark: "#161a18", onDark: "#f4f1eb",
    },
    layout: { contentWidth: language.contentWidth, narrowWidth: "760", gutter: "24", grid: language.grid, alignment: language.alignment },
    components: {
      buttonRadius: { none: "0", small: "4", medium: "8", large: "12", pill: "999" }[language.radius],
      inputRadius: { none: "0", small: "4", medium: "8", large: "12", pill: "12" }[language.radius],
      cardRadius: { none: "0", small: "8", medium: "12", large: "16", pill: "24" }[language.radius],
      imageRadius: { none: "0", small: "8", medium: "12", large: "16", pill: "24" }[language.radius],
      borderWidth: "1", shadow: language.cards === "elevated" ? "medium" : language.cards === "none" ? "none" : "soft",
      cardStyle: language.cards, buttonStyle: language.buttons, navHeight: "72", iconSize: "24",
    },
    header: language.navigation, imageTreatment: language.imageTreatment, motion: language.motionStyle,
    backgroundRhythm: language.background,
  });
}
