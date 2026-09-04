import type { ModelProvider } from "@deedwell/agent-runtime";
import type { SitePage, WebsiteBriefOutput } from "@deedwell/schemas";
import type { Organization } from "../design.js";
import type { SiteImage } from "../images.js";
import { capHeaderNav, ensureFooterStatus, ensureNavCoverage, normalizeInternalLinks, sanitizePage } from "../sanitize.js";
import type { ReferenceTemplate } from "../site-generation.js";
import { critiquePage, lowestScore, repairComposition } from "./critic.js";
import { generateDesignSystem, type BrandHints } from "./designSystem.js";
import { MOTION_SCRIPT } from "./motion.js";
import { normalize, planPage } from "./pagePlanner.js";
import { analyzeReference } from "./referenceAnalyzer.js";
import { renderPage } from "./renderPage.js";
import type { ComponentName, CriticReport, DesignLanguage, DesignTokens, PageComposition } from "./schemas.js";
import { screenshotPage } from "./screenshots.js";
import { runStage, type StageContext } from "./stages.js";

export * from "./schemas.js";
export { tokensToCss, harmonizeColors, contrastRatio, ensureContrast } from "./tokens.js";
export { CATALOG, DEFAULT_COMPONENT, headingClass, clampText } from "./components.js";
export { renderPage, renderMain, stylesheet } from "./renderPage.js";
export { MOTION_SCRIPT, MOTION_SCRIPT_HASH, MOTION_CSS } from "./motion.js";
export { normalize as normalizeComposition } from "./pagePlanner.js";
export { repairComposition } from "./critic.js";
export { runStage, readStage, resetStage, hashInput, type StageContext } from "./stages.js";
export { DEFAULT_LANGUAGE } from "./referenceAnalyzer.js";
export { fallbackTokens } from "./designSystem.js";

/**
 * The website generation pipeline, end to end for one site:
 *
 *   reference analysis → design system → (per page, concurrently)
 *   composition plan → render → critique → repair → render → final HTML
 *
 * Every stage output is stored through the stage runner, so an unchanged
 * stage is reused, each can be inspected, and any one can be reset and
 * re-run alone. Copy comes from the copywriter (already grounded and
 * placeholder-free) and is never rewritten here beyond shortening.
 */
export interface BuildSiteArgs {
  stage: StageContext;
  vision: ModelProvider;
  planner: ModelProvider;
  critic: ModelProvider;
  site: { name: string; slug: string };
  pages: SitePage[];
  brief: WebsiteBriefOutput | null;
  reference: ReferenceTemplate | null;
  images: SiteImage[];
  organization: Organization;
  donateUrl: string | null;
  brand: BrandHints;
  /** Site Generation Settings guidance, folded into the brand hints. */
  guidance: string;
  visualQa?: boolean;
  onEvent?: (event: { stage: string; scope: string; ok: boolean; detail: string }) => Promise<void>;
}

export interface BuiltPage { slug: string; html: string; composition: PageComposition; critique: CriticReport | null; repairs: string[] }

export async function buildSite(args: BuildSiteArgs): Promise<{ language: DesignLanguage; tokens: DesignTokens; pages: BuiltPage[] }> {
  const say = (stage: string, scope: string, ok: boolean, detail: string) => args.onEvent?.({ stage, scope, ok, detail }) ?? Promise.resolve();

  // Stage 1 — reference analysis (site-wide, keyed on the reference itself).
  const language = (await runStage(args.stage, {
    stage: "reference_analysis",
    input: { reference: args.reference?.id ?? null, direction: args.brand.visualDirection ?? null, brandPrimary: args.brand.primaryColor ?? null },
    model: args.vision.name,
  }, () => analyzeReference(args.vision, args.reference, { visualDirection: args.brand.visualDirection, brandPrimary: args.brand.primaryColor }))).output;
  await say("reference_analysis", "", true, args.reference ? `Read the design language of "${args.reference.title}": ${language.style}, ${language.density}, ${language.typography.headingStyle} headings.` : `No reference design; using the ${language.style} language.`);

  // Stage 2 — design system.
  const system = (await runStage(args.stage, {
    stage: "design_system",
    input: { language, brand: args.brand, guidance: args.guidance },
    model: args.planner.name,
  }, () => generateDesignSystem(args.planner, language, { ...args.brand, tone: [args.brand.tone, args.guidance].filter(Boolean).join(" ") || null }))).output;
  await say("design_system", "", true, `Tokens set: ${system.tokens.typography.headingFamily} / ${system.tokens.typography.scale} scale, ${system.tokens.header} header, ${system.tokens.colors.primary} primary.${system.adjustments.length ? ` Adjusted: ${system.adjustments.slice(0, 2).join("; ")}.` : ""}`);
  const tokens = system.tokens;

  const nav = args.pages.map((p) => ({ title: p.title, href: p.slug === "home" ? "/" : `/${p.slug}/` }));
  const ctxBase = { site: args.site, tokens, images: args.images, organization: args.organization, donateUrl: args.donateUrl, nav };

  // Stages 4-11 — per page, concurrently.
  const used: ComponentName[] = [];
  const pages = await Promise.all(args.pages.map(async (page): Promise<BuiltPage> => {
    const planInput = { page, language, images: args.images.map((i) => i.key), donateUrl: args.donateUrl };
    const planned = (await runStage(args.stage, { stage: "page_plan", scope: page.slug, input: planInput, model: args.planner.name },
      () => planPage({ provider: args.planner, page, language, brief: args.brief, images: args.images, donateUrl: args.donateUrl, siteSlug: args.site.slug, usedComponents: used }))).output;
    let composition = normalize(planned.composition, { page, images: args.images, donateUrl: args.donateUrl, language });
    for (const s of composition.sections) if (!used.includes(s.component)) used.push(s.component);
    await say("page_plan", page.slug, true, `${composition.sections.length} sections: ${composition.sections.map((s) => s.component).join(", ")}.${planned.corrections.length ? ` Corrected: ${planned.corrections.slice(0, 2).join("; ")}.` : ""}`);

    const render = (c: PageComposition) => finalize(renderPage({ ctx: ctxBase, page, composition: c, tokens, withScript: false }), args, nav, tokens);
    let html = render(composition);

    // Critique + one targeted repair round, memoized on the exact page.
    let critique: CriticReport | null = null;
    const repairs: string[] = [];
    try {
      const review = (await runStage(args.stage, { stage: "critique", scope: page.slug, input: { html, composition }, model: args.critic.name }, async () => {
        const shots = await screenshotPage(html, { enabled: args.visualQa });
        return { report: await critiquePage({ provider: args.critic, page, composition, language, html, screenshots: shots }), screenshots: shots.length };
      })).output;
      critique = review.report;
      // Without screenshots the critic judges markup alone and its scores
      // run low; only defects it is sure of are acted on then.
      const weak = lowestScore(critique) < 8;
      const actionable = review.screenshots ? critique.issues : critique.issues.filter((i) => i.severity === "high");
      if (weak && actionable.length) {
        const fixed = repairComposition(composition, actionable);
        if (fixed.applied.length) {
          composition = fixed.composition;
          repairs.push(...fixed.applied);
          html = render(composition);
        }
      }
      await say("critique", page.slug, true, `Lowest score ${lowestScore(critique)}/10${review.screenshots ? ` from ${review.screenshots} screenshots` : ""}; ${critique.issues.length} issue(s)${repairs.length ? `, repaired: ${repairs.slice(0, 3).join("; ")}` : ""}.`);
    } catch (err) {
      await say("critique", page.slug, false, `Critique skipped (${String((err as Error).message ?? err).slice(0, 120)}).`);
    }
    return { slug: page.slug, html, composition, critique, repairs };
  }));

  return { language, tokens, pages };
}

/** Sanitize (belt and braces), enforce the nav and status rules, then add
 *  our motion script — the one script a generated site may carry. */
function finalize(html: string, args: BuildSiteArgs, nav: Array<{ title: string; href: string }>, tokens: DesignTokens): string {
  const urls = [...nav.map((n) => n.href), "/thanks/"];
  const cleaned = sanitizePage(html, { slug: args.site.slug, pageUrls: urls, nav });
  const safe = ensureFooterStatus(
    ensureNavCoverage(capHeaderNav(normalizeInternalLinks(cleaned.html, urls)), nav),
    { legalName: args.organization.legalName ?? args.organization.name, status: args.organization.status, ein: args.organization.ein }
  );
  if (tokens.motion === "none") return safe;
  return safe.replace(/<\/body>/i, `<script>${MOTION_SCRIPT}</script></body>`);
}
