import type { SitePage } from "@deedwell/schemas";
import { CATALOG, esc, renderFooter, renderHeader, type RenderCtx } from "./components.js";
import { MOTION_CSS, MOTION_SCRIPT } from "./motion.js";
import type { DesignTokens, PageComposition } from "./schemas.js";
import { BASE_STYLES } from "./styles.js";
import { tokensToCss } from "./tokens.js";

/**
 * Stage 7: deterministic rendering. Composition + tokens → a complete page.
 * The shell (head, skip link, header, footer, motion script) is ours; the
 * sections come from the library. No model output reaches the page as
 * markup, so the sanitizer is a second line of defence, not the first.
 */
export interface RenderArgs {
  ctx: Omit<RenderCtx, "page" | "primaryCta">;
  page: SitePage;
  composition: PageComposition;
  tokens: DesignTokens;
  /** Whether to include the motion script tag (omitted for the critic's text pass). */
  withScript?: boolean;
}

export function stylesheet(tokens: DesignTokens): string {
  return `${tokensToCss(tokens)}\n${BASE_STYLES}\n${tokens.motion === "none" ? "" : MOTION_CSS}`;
}

export function renderMain(args: RenderArgs): string {
  const ctx: RenderCtx = { ...args.ctx, page: args.page, primaryCta: args.composition.primaryCta };
  const parts = args.composition.sections.map((section) => {
    const block = args.page.blocks[section.block];
    if (!block) return "";
    const spec = CATALOG[section.component];
    return spec.render(ctx, section, block);
  });
  // A page that opens without a hero still needs its h1.
  const hasHero = /<h1[\s>]/.test(parts[0] ?? "");
  const intro = hasHero ? "" : `<section class="hero hero--minimal" id="page-title"><div class="container container--narrow hero__inner"><div class="hero__copy"><h1 class="t-h1">${esc(args.page.title)}</h1>${args.page.seoDescription ? `<p class="lead">${esc(args.page.seoDescription)}</p>` : ""}</div></div></section>`;
  return `<main id="main">${intro}${parts.join("\n")}</main>`;
}

export function renderPage(args: RenderArgs): string {
  const ctx: RenderCtx = { ...args.ctx, page: args.page, primaryCta: args.composition.primaryCta };
  const main = renderMain(args);
  const imageHero = args.composition.sections[0]?.component === "FullBleedImageHero";
  const title = `${args.page.title} — ${args.ctx.site.name}`;
  const description = args.page.seoDescription || args.ctx.organization.mission || args.page.title;
  const canonical = args.page.slug === "home" ? "/" : `/${args.page.slug}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="${esc(args.tokens.colors.primary)}">
<link rel="canonical" href="${canonical}">
<style>${stylesheet(args.tokens)}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
${renderHeader(ctx, args.tokens.header, imageHero)}
${main}
${renderFooter(ctx)}
${args.withScript === false || args.tokens.motion === "none" ? "" : `<script>${MOTION_SCRIPT}</script>`}
</body>
</html>`;
}
