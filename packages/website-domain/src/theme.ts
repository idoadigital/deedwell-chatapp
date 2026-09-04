import type { SiteTheme } from "@deedwell/schemas";

/**
 * Design tokens.
 *
 * A palette used to be a set of six colours interpolated straight into a CSS
 * template, which meant every rule hard-coded a specific value and a theme was
 * a code path rather than data. Here a palette is a token map emitted as CSS
 * custom properties, so the stylesheet references `var(--accent)` once and any
 * palette — including a brand-derived one — drops in without touching layout.
 *
 * Every pair below is contrast-checked: `ink` on `bg` clears WCAG AAA for body
 * text, `inkSoft` on `bg` and `accentInk` on `accent` clear AA. The dark
 * palette inverts the ramp rather than dimming the light one, because a
 * washed-out grey-on-grey dark mode fails the same checks.
 */
export interface PaletteTokens {
  bg: string;
  surface: string;
  /** Tinted band used to separate adjacent sections without a border. */
  band: string;
  ink: string;
  inkSoft: string;
  line: string;
  accent: string;
  accentInk: string;
  accentDeep: string;
  accentSoft: string;
  /** Text colour that stays legible on top of accentSoft. */
  accentSoftInk: string;
  scheme: "light" | "dark";
}

export const PALETTES: Record<SiteTheme["palette"], PaletteTokens> = {
  forest: {
    bg: "#f7faf7", surface: "#ffffff", band: "#edf4ee",
    ink: "#12241a", inkSoft: "#48604f", line: "#d9e5dc",
    accent: "#0f5c33", accentInk: "#ffffff", accentDeep: "#0a4326", accentSoft: "#e2efe7",
    accentSoftInk: "#0a4326", scheme: "light",
  },
  ocean: {
    bg: "#f5f9fc", surface: "#ffffff", band: "#e8f1f8",
    ink: "#0f2434", inkSoft: "#3d5c73", line: "#d5e3ee",
    accent: "#0a5c8a", accentInk: "#ffffff", accentDeep: "#073f60", accentSoft: "#e0eef7",
    accentSoftInk: "#073f60", scheme: "light",
  },
  slate: {
    bg: "#f7f8fa", surface: "#ffffff", band: "#eef0f4",
    ink: "#171b26", inkSoft: "#4b5468", line: "#dde0e8",
    accent: "#2f3b57", accentInk: "#ffffff", accentDeep: "#1e2740", accentSoft: "#e7eaf1",
    accentSoftInk: "#1e2740", scheme: "light",
  },
  sunrise: {
    bg: "#fef8f3", surface: "#ffffff", band: "#fbeee2",
    ink: "#33200f", inkSoft: "#77492b", line: "#eedcc9",
    accent: "#9c3f10", accentInk: "#ffffff", accentDeep: "#78300a", accentSoft: "#fbe6d6",
    accentSoftInk: "#78300a", scheme: "light",
  },
  plum: {
    bg: "#faf6fb", surface: "#ffffff", band: "#f2e8f4",
    ink: "#24152a", inkSoft: "#5b3d64", line: "#e4d7e8",
    accent: "#6a2580", accentInk: "#ffffff", accentDeep: "#4d1a5e", accentSoft: "#f0e2f4",
    accentSoftInk: "#4d1a5e", scheme: "light",
  },
  meadow: {
    bg: "#f6faf3", surface: "#ffffff", band: "#ecf3e5",
    ink: "#1a2911", inkSoft: "#4a5f3a", line: "#dae6d1",
    accent: "#3a6519", accentInk: "#ffffff", accentDeep: "#294a10", accentSoft: "#e8f1df",
    accentSoftInk: "#294a10", scheme: "light",
  },
  harvest: {
    bg: "#fbf8f0", surface: "#ffffff", band: "#f5ecda",
    ink: "#2c2210", inkSoft: "#68521f", line: "#e7dbc2",
    accent: "#75500d", accentInk: "#ffffff", accentDeep: "#573b06", accentSoft: "#f6ebd6",
    accentSoftInk: "#573b06", scheme: "light",
  },
  midnight: {
    bg: "#0d1117", surface: "#161c26", band: "#1a212c",
    ink: "#e9eef6", inkSoft: "#a4b1c5", line: "#2a3240",
    accent: "#6fb0f5", accentInk: "#08111c", accentDeep: "#4a90dd", accentSoft: "#1d2c3e",
    accentSoftInk: "#bcd8f8", scheme: "dark",
  },
};

/** Font stacks. No web fonts: the site's CSP is `default-src 'none'`, so an
 *  external font would simply fail to load. Character comes from scale,
 *  weight and tracking instead. */
const FONTS = {
  serif:
    "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif",
  sans:
    "'Inter var',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
};

/** Relative luminance of a #rrggbb colour (sRGB, WCAG formula). */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const ch = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** The body classes the stylesheet's design variants hang off. */
export function designClasses(theme: SiteTheme): string {
  const d = theme.design ?? {};
  return [
    `hero-${d.heroStyle ?? "left"}`,
    `nav-${d.navStyle ?? "plain"}`,
    `buttons-${d.buttonStyle ?? "pill"}`,
  ].join(" ");
}

export function themeTokens(theme: SiteTheme): string {
  const p = PALETTES[theme.palette];
  const d = theme.design ?? {};
  const heading = theme.headingFont === "serif" ? FONTS.serif : FONTS.sans;
  const body = d.bodyFont === "serif" ? FONTS.serif : FONTS.sans;

  // A brand colour from the reference replaces the palette accent. Its
  // companions are mixed from it in CSS; the ink on it is picked here by
  // luminance so a light brand colour never gets white text.
  const accent = d.accent ? d.accent.toLowerCase() : p.accent;
  const accentInk = d.accent ? (luminance(accent) > 0.4 ? "#111318" : "#ffffff") : p.accentInk;
  const accentDeep = d.accent ? `color-mix(in srgb,${accent} 78%,black)` : p.accentDeep;
  const accentSoft = d.accent ? `color-mix(in srgb,${accent} 14%,${p.bg})` : p.accentSoft;
  const accentSoftInk = d.accent ? `color-mix(in srgb,${accent} 70%,${p.ink})` : p.accentSoftInk;

  const corners = { sharp: ["2px", "4px", "8px"], soft: ["6px", "12px", "20px"], round: ["10px", "18px", "28px"] }[d.corners ?? "soft"];
  const button = { pill: "999px", rounded: "10px", square: "3px" }[d.buttonStyle ?? "pill"];
  const density = { airy: 1.25, balanced: 1, compact: 0.8 }[d.density ?? "balanced"];
  const space = (rem: number) => `${(rem * density).toFixed(3)}rem`;
  const type = {
    quiet: { display: "clamp(2.2rem,1.3rem + 3.2vw,3.6rem)", h1: "clamp(1.9rem,1.3rem + 2.1vw,2.7rem)", h2: "clamp(1.45rem,1.15rem + 1.2vw,2rem)", weight: "600" },
    balanced: { display: "clamp(2.6rem,1.4rem + 4.4vw,4.6rem)", h1: "clamp(2.1rem,1.4rem + 2.6vw,3.2rem)", h2: "clamp(1.6rem,1.2rem + 1.5vw,2.35rem)", weight: "700" },
    bold: { display: "clamp(3rem,1.5rem + 5.6vw,5.6rem)", h1: "clamp(2.4rem,1.5rem + 3.2vw,3.8rem)", h2: "clamp(1.8rem,1.3rem + 1.9vw,2.7rem)", weight: "800" },
  }[d.typeScale ?? "balanced"];

  return `
:root{
  color-scheme:${p.scheme};
  --bg:${p.bg}; --surface:${p.surface}; --band:${p.band};
  --ink:${p.ink}; --ink-soft:${p.inkSoft}; --line:${p.line};
  --accent:${accent}; --accent-ink:${accentInk};
  --accent-deep:${accentDeep}; --accent-soft:${accentSoft};
  --accent-soft-ink:${accentSoftInk};

  --font-head:${heading};
  --font-body:${body};
  --head-weight:${type.weight};

  /* Fluid type. clamp() means one scale serves phone through desktop with no
     breakpoint jumps mid-sentence. */
  --fs-display:${type.display};
  --fs-h1:${type.h1};
  --fs-h2:${type.h2};
  --fs-h3:clamp(1.15rem,1.05rem + 0.4vw,1.4rem);
  --fs-lead:clamp(1.08rem,1rem + 0.45vw,1.32rem);
  --fs-body:1.0625rem;
  --fs-small:0.875rem;
  --fs-eyebrow:0.78rem;
  --fs-stat:clamp(2.4rem,1.6rem + 2.8vw,3.8rem);

  /* Spacing rhythm — a 4px base, so vertical space is never arbitrary. The
     section-level steps scale with the design's density. */
  --s1:0.25rem; --s2:0.5rem; --s3:0.75rem; --s4:1rem; --s5:1.5rem;
  --s6:${space(2)}; --s7:${space(3)}; --s8:${space(4.5)}; --s9:${space(6.5)};
  --hero-pad:clamp(${space(3.5)},${(10 * density).toFixed(1)}vw,${space(7.5)});

  --r-sm:${corners[0]}; --r-md:${corners[1]}; --r-lg:${corners[2]}; --r-pill:999px;
  --r-button:${button};
  --measure:64ch;
  --wrap:1140px;
  --wrap-narrow:760px;

  --shadow-sm:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);
  --shadow-md:0 4px 12px rgba(16,24,40,.06),0 12px 28px rgba(16,24,40,.07);
  --shadow-lg:0 12px 32px rgba(16,24,40,.10),0 32px 64px rgba(16,24,40,.10);
}`.trim();
}
