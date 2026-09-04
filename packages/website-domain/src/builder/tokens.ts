import type { DesignTokens } from "./schemas.js";

/**
 * Design tokens → CSS custom properties. Every size, colour and radius a
 * page uses comes from here, chosen from fixed, tested scales; a stage may
 * pick a scale, never a number. Contrast is enforced, not hoped for.
 */

export const FONT_STACKS: Record<DesignTokens["typography"]["headingFamily"] | "serif" | "sans", string> = {
  "serif-editorial": "'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif",
  "serif-classic": "Georgia,'Times New Roman',Times,serif",
  "sans-geometric": "'Avenir Next','Avenir','Futura','Century Gothic','Segoe UI',system-ui,sans-serif",
  "sans-humanist": "'Gill Sans','Gill Sans MT','Trebuchet MS','Segoe UI',system-ui,sans-serif",
  "sans-grotesque": "'Helvetica Neue',Helvetica,Arial,'Inter',system-ui,sans-serif",
  "display-condensed": "'Arial Narrow','Helvetica Neue Condensed','Roboto Condensed',Impact,sans-serif",
  serif: "'Iowan Old Style','Palatino Linotype',Georgia,serif",
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,'Helvetica Neue',Arial,sans-serif",
};

/** Fixed responsive type scales. Long headings step down (see renderPage),
 *  they never overflow. */
const TYPE_SCALES: Record<DesignTokens["typography"]["scale"], { display: string; h1: string; h2: string; h3: string; lead: string }> = {
  restrained: { display: "clamp(2.25rem,1.5rem + 3vw,3.75rem)", h1: "clamp(2rem,1.4rem + 2.4vw,3.25rem)", h2: "clamp(1.6rem,1.25rem + 1.4vw,2.4rem)", h3: "clamp(1.2rem,1.1rem + 0.4vw,1.5rem)", lead: "clamp(1.05rem,1rem + 0.3vw,1.2rem)" },
  controlled: { display: "clamp(2.6rem,1.6rem + 4vw,4.75rem)", h1: "clamp(2.25rem,1.5rem + 3vw,4rem)", h2: "clamp(1.75rem,1.3rem + 1.8vw,2.75rem)", h3: "clamp(1.25rem,1.1rem + 0.5vw,1.6rem)", lead: "clamp(1.1rem,1rem + 0.4vw,1.3rem)" },
  large: { display: "clamp(3rem,1.8rem + 5vw,5.75rem)", h1: "clamp(2.6rem,1.6rem + 3.8vw,4.75rem)", h2: "clamp(1.9rem,1.35rem + 2.2vw,3.2rem)", h3: "clamp(1.3rem,1.1rem + 0.6vw,1.75rem)", lead: "clamp(1.125rem,1rem + 0.5vw,1.375rem)" },
  dramatic: { display: "clamp(3.25rem,1.8rem + 6vw,6.5rem)", h1: "clamp(2.75rem,1.6rem + 4.6vw,5.25rem)", h2: "clamp(2rem,1.4rem + 2.6vw,3.6rem)", h3: "clamp(1.35rem,1.15rem + 0.7vw,1.9rem)", lead: "clamp(1.15rem,1rem + 0.55vw,1.45rem)" },
};

const BODY_SIZES = { compact: "1rem", comfortable: "1.0625rem", generous: "1.125rem" } as const;
const DENSITY = { spacious: 1.2, balanced: 1, compact: 0.85 } as const;
const SECTION_PAD = {
  generous: "clamp(4.5rem,6vw + 2rem,10rem)",
  standard: "clamp(3.5rem,4.5vw + 1.5rem,7.5rem)",
  tight: "clamp(2.5rem,3vw + 1rem,5rem)",
} as const;
const SHADOWS = {
  none: { sm: "none", md: "none", lg: "none" },
  soft: { sm: "0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.05)", md: "0 6px 16px rgba(0,0,0,.06),0 2px 6px rgba(0,0,0,.04)", lg: "0 20px 48px rgba(0,0,0,.10)" },
  medium: { sm: "0 1px 3px rgba(0,0,0,.08)", md: "0 10px 24px rgba(0,0,0,.10),0 2px 6px rgba(0,0,0,.06)", lg: "0 28px 64px rgba(0,0,0,.16)" },
} as const;

// ---- colour maths ---------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}
export function luminance(hex: string): number {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function mix(hex: string, towards: string, amount: number): string {
  const a = hexToRgb(hex), b = hexToRgb(towards);
  return rgbToHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]);
}

/** Darkens or lightens `fg` until it clears `ratio` against `bg`. */
export function ensureContrast(fg: string, bg: string, ratio = 4.5): string {
  if (contrastRatio(fg, bg) >= ratio) return fg;
  const towards = luminance(bg) > 0.5 ? "#000000" : "#ffffff";
  let out = fg;
  for (let i = 1; i <= 20; i += 1) {
    out = mix(fg, towards, i / 20);
    if (contrastRatio(out, bg) >= ratio) return out;
  }
  return towards;
}

/** Colours a stage proposed, made safe. Returns the corrected token set and
 *  a list of what was changed, for the stage log. */
export function harmonizeColors(colors: DesignTokens["colors"]): { colors: DesignTokens["colors"]; adjustments: string[] } {
  const adjustments: string[] = [];
  const c = { ...colors };
  const fix = (key: keyof DesignTokens["colors"], bg: string, ratio: number) => {
    const fixed = ensureContrast(c[key], bg, ratio);
    if (fixed !== c[key]) { adjustments.push(`${key} ${c[key]} → ${fixed} for contrast on ${bg}`); c[key] = fixed; }
  };
  fix("foreground", c.background, 7);
  fix("foregroundMuted", c.background, 4.5);
  fix("foreground", c.surface, 7);
  fix("foregroundMuted", c.muted, 4.5);
  fix("onPrimary", c.primary, 4.5);
  fix("onAccent", c.accent, 4.5);
  fix("onDark", c.dark, 7);
  // Primary as link/text colour on the page background needs AA too.
  if (contrastRatio(c.primary, c.background) < 4.5) {
    const fixed = ensureContrast(c.primary, c.background, 4.5);
    adjustments.push(`primary ${c.primary} → ${fixed} as text on background`);
    c.primary = fixed;
    c.onPrimary = ensureContrast(c.onPrimary, c.primary, 4.5);
  }
  return { colors: c, adjustments };
}

// ---- emit ------------------------------------------------------------------

export function tokensToCss(tokens: DesignTokens): string {
  const t = tokens;
  const scale = TYPE_SCALES[t.typography.scale];
  const d = DENSITY[t.spacing.density];
  const space = (px: number) => `${((px * d) / 16).toFixed(3)}rem`;
  const shadow = SHADOWS[t.components.shadow];
  const c = t.colors;
  const isDark = t.backgroundRhythm === "dark";
  const bg = isDark ? c.dark : c.background;
  const fg = isDark ? c.onDark : c.foreground;
  const tracking = { tight: "-0.02em", normal: "0", wide: "0.02em" }[t.typography.headingLetterSpacing];
  return `:root{
  --font-heading:${FONT_STACKS[t.typography.headingFamily]};
  --font-body:${FONT_STACKS[t.typography.bodyFamily]};
  --fs-display:${scale.display};--fs-h1:${scale.h1};--fs-h2:${scale.h2};--fs-h3:${scale.h3};--fs-lead:${scale.lead};
  --fs-body:${BODY_SIZES[t.typography.bodySize]};--fs-body-lg:calc(var(--fs-body) * 1.125);--fs-small:0.875rem;--fs-eyebrow:0.8125rem;--fs-stat:clamp(2.25rem,1.5rem + 3vw,3.75rem);
  --lh-tight:1.08;--lh-heading:1.15;--lh-body:1.65;
  --fw-heading:${t.typography.headingWeight};--fw-body:${t.typography.bodyWeight};--fw-strong:${t.typography.headingWeight === "500" ? "600" : "700"};
  --tracking-heading:${tracking};--eyebrow-case:${t.typography.eyebrowCase};--eyebrow-tracking:${t.typography.eyebrowCase === "uppercase" ? "0.12em" : "0"};
  --s-1:${space(4)};--s-2:${space(8)};--s-3:${space(12)};--s-4:${space(16)};--s-5:${space(24)};--s-6:${space(32)};--s-7:${space(48)};--s-8:${space(64)};--s-9:${space(80)};--s-10:${space(120)};--s-11:${space(160)};
  --section-pad:${SECTION_PAD[t.spacing.sectionPadding]};
  --c-primary:${c.primary};--c-secondary:${c.secondary};--c-accent:${c.accent};
  --c-bg:${bg};--c-surface:${isDark ? mix(c.dark, "#ffffff", 0.06) : c.surface};--c-muted:${isDark ? mix(c.dark, "#ffffff", 0.1) : c.muted};
  --c-fg:${fg};--c-fg-muted:${isDark ? mix(c.onDark, c.dark, 0.3) : c.foregroundMuted};--c-border:${isDark ? mix(c.dark, "#ffffff", 0.16) : c.border};
  --c-on-primary:${c.onPrimary};--c-on-accent:${c.onAccent};--c-dark:${c.dark};--c-on-dark:${c.onDark};
  --c-primary-tint:${mix(c.primary, c.background, 0.88)};--c-accent-tint:${mix(c.accent, c.background, 0.88)};
  --c-primary-deep:${mix(c.primary, "#000000", 0.18)};
  --w-content:${t.layout.contentWidth}px;--w-narrow:${t.layout.narrowWidth}px;--gutter:${t.layout.gutter}px;
  --r-btn:${t.components.buttonRadius}px;--r-input:${t.components.inputRadius}px;--r-card:${t.components.cardRadius}px;--r-img:${t.components.imageRadius}px;
  --bw:${t.components.borderWidth}px;--shadow-sm:${shadow.sm};--shadow-md:${shadow.md};--shadow-lg:${shadow.lg};
  --nav-h:${t.components.navHeight}px;--icon:${t.components.iconSize}px;
  --ease:cubic-bezier(.2,.7,.2,1);--dur:.5s;
}`;
}
