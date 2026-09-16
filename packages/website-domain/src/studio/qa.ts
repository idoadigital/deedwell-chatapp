import type { PoolClient } from "pg";
import { audit, loadMissionProfile, missionProfileBlock, uuidv7, type StorageAdapter } from "@deedwell/database";
import { runAgentTask, type ModelProvider } from "@deedwell/agent-runtime";
import { SiteQaReview, type SiteEditOp } from "@deedwell/schemas";
import { critiquePage, lowestScore, repairComposition } from "../builder/critic.js";
import { ensureContrast } from "../builder/tokens.js";
import { websiteQaReviewer } from "../agents.js";
import { loadSiteLogoFrom } from "../workflow.js";
import { inspectPages, type InspectedPage, type LayoutChecks } from "./inspect.js";
import type { JobProgress } from "./jobs.js";
import { assembleRelease } from "./releases.js";
import { applyOperations, loadWorkingState, renderWorkingPage, saveWorkingState, siteAssets, type WorkingState } from "./state.js";

/**
 * The QA agent. It renders the site's pages in a browser at five widths,
 * measures them, tries the mobile menu, checks links, reads the copy
 * against the Mission Profile, has the design critic look at screenshots,
 * then repairs what it can with the smallest change (a scoped style rule,
 * a plan tweak, a wording fix), re-renders and re-checks each repair, and
 * records anything it could not fix for a person. Nothing is reported that
 * was not observed.
 */

export const QA_VIEWPORTS = [1440, 1024, 768, 390, 360];
const MAX_ATTEMPTS = 3;

export type Severity = "critical" | "high" | "medium" | "low";
export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  page: string | null;
  viewport: number | null;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: "detected" | "repairing" | "fixed" | "verified" | "needs_review";
  repair: Record<string, unknown>;
  attempts: number;
  /** How to check whether it is gone: re-run this predicate on the page's checks. */
  recheck?: (checks: LayoutChecks) => boolean;
  /** Ordered repair strategies; each returns operations or null. */
  strategies?: Array<(state: WorkingState) => SiteEditOp[] | null>;
}

export interface QaArgs {
  client: PoolClient;
  storage: StorageAdapter;
  tenantId: string;
  siteId: string;
  jobId: string;
  runId?: string | null;
  progress: JobProgress | null;
  provider: ModelProvider;
  critic?: ModelProvider;
  instruction?: string | null;
  createdBy?: string | null;
}

export interface QaOutcome {
  status: "passed" | "review" | "failed";
  checks: number;
  detected: number;
  repaired: number;
  review: number;
  categories: Record<string, "pass" | "review">;
  releaseId: string | null;
  browser: boolean;
}

const sev = (s: Severity) => s;

/** Scope from a free-text request ("check the footer on mobile"). */
function scopeOf(instruction: string | null | undefined, pages: string[]): { viewports: number[]; pages: string[]; categories: string[] | null } {
  if (!instruction) return { viewports: QA_VIEWPORTS, pages, categories: null };
  const l = instruction.toLowerCase();
  const viewports = /\b(mobile|phone)\b/.test(l) ? [390, 360] : /\btablet\b/.test(l) ? [768, 1024] : /\bdesktop\b/.test(l) ? [1440] : QA_VIEWPORTS;
  const named = pages.filter((p) => l.includes(p.replace(/-/g, " ")) || l.includes(p));
  const cats: string[] = [];
  for (const [re, c] of [[/footer/, "footer"], [/header|logo/, "header"], [/nav|menu|link/, "navigation"], [/image|photo|picture/, "imagery"], [/text|copy|wording|spelling|grammar|content/, "content"], [/access|contrast|alt/, "accessibility"], [/donat/, "donations"], [/blog|post/, "blog"], [/event/, "events"], [/mission/, "mission"], [/spacing|layout|overlap|align|responsive|visual/, "visual"]] as Array<[RegExp, string]>) if (re.test(l)) cats.push(c);
  return { viewports, pages: named.length ? named : pages, categories: cats.length ? cats : null };
}

function layoutFindings(p: InspectedPage, siteName: string, allViewports: number[]): Finding[] {
  const out: Finding[] = [];
  const c = p.checks;
  const mk = (partial: Omit<Finding, "id" | "status" | "repair" | "attempts" | "evidence"> & { evidence?: Record<string, unknown> }): Finding => ({ id: uuidv7(), status: "detected", repair: {}, attempts: 0, evidence: {}, ...partial });
  const vpKind = p.viewport <= 480 ? "mobile" : p.viewport <= 1024 ? "tablet" : "desktop";
  if (c.horizontalOverflow) {
    const culprit = c.overflowing[0];
    out.push(mk({ severity: sev("high"), category: "responsive", page: p.slug, viewport: p.viewport, title: `Page scrolls sideways at ${p.viewport}px`, description: `The page is ${c.scrollWidth}px wide in a ${p.viewport}px viewport${culprit ? `; ${culprit.selector} reaches ${culprit.right}px` : ""}.`, evidence: { scrollWidth: c.scrollWidth, overflowing: c.overflowing },
      recheck: (x) => x.horizontalOverflow,
      strategies: culprit ? [
        () => [{ kind: "style", page: p.slug, selector: culprit.selector, viewport: vpKind as never, declarations: { "max-width": "100%", "overflow-wrap": "anywhere", "min-width": "0" }, note: "QA: keep within the viewport" }],
        () => [{ kind: "style", page: p.slug, selector: `#${sectionOf(p, culprit.selector)}`, viewport: vpKind as never, declarations: { "overflow-x": "clip" }, note: "QA: clip a section that overflowed" }],
        () => [{ kind: "style", page: "*", selector: "main img, main svg, main video", viewport: "all", declarations: { "max-width": "100%", height: "auto" }, note: "QA: media never wider than its container" }],
      ] : [() => [{ kind: "style", page: p.slug, selector: "main", viewport: vpKind as never, declarations: { "overflow-x": "clip" }, note: "QA: clip horizontal overflow" }]] }));
  }
  for (const o of c.overlaps.slice(0, 3)) {
    const sec = sectionOf(p, o.a);
    out.push(mk({ severity: sev("high"), category: "visual", page: p.slug, viewport: p.viewport, title: `Elements overlap at ${p.viewport}px`, description: `${o.a} and ${o.b} overlap in #${sec}.`, evidence: o,
      recheck: (x) => x.overlaps.some((y) => y.a === o.a && y.b === o.b),
      strategies: [
        () => [{ kind: "section", page: p.slug, sectionId: sec, set: { density: "airy" } }],
        () => [{ kind: "style", page: p.slug, selector: `#${sec} .hero__inner, #${sec} .split, #${sec} .imagetext--image-side`, viewport: vpKind as never, declarations: { "grid-template-columns": "1fr", display: "grid" }, note: "QA: stack overlapping columns" }],
      ] }));
  }
  for (const t of c.tinyText.slice(0, 3)) {
    out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: p.viewport, title: "Text too small to read", description: `${t.selector} renders at ${t.fontSize}px.`, evidence: t,
      recheck: (x) => x.tinyText.some((y) => y.selector === t.selector),
      strategies: [
        () => [{ kind: "style", page: p.slug, selector: generalize(t.selector), viewport: "all", declarations: { "font-size": "0.875rem" }, note: "QA: legible text size" }],
        () => [{ kind: "style", page: p.slug, selector: t.selector, viewport: "all", declarations: { "font-size": "0.875rem" }, note: "QA: legible text size" }],
      ] }));
  }
  for (const t of c.smallTapTargets.slice(0, 3)) {
    out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: p.viewport, title: "Tap target too small", description: `${t.selector} is ${t.width}×${t.height}px; aim for 44px.`, evidence: t,
      recheck: (x) => x.smallTapTargets.some((y) => y.selector === t.selector),
      strategies: [
        // Siblings share the problem (a footer's link list, say): fix the group first.
        () => [{ kind: "style", page: p.slug, selector: generalize(t.selector), viewport: "mobile", declarations: { "min-height": "44px", "min-width": "44px", padding: "10px 14px", display: "inline-flex", "align-items": "center" }, note: "QA: 44px tap target" }],
        () => [{ kind: "style", page: p.slug, selector: t.selector, viewport: "mobile", declarations: { "min-height": "44px", "min-width": "44px", padding: "10px 14px", display: "inline-flex", "align-items": "center" }, note: "QA: 44px tap target" }],
      ] }));
  }
  if (c.brokenImages.length && p.viewport === allViewports[0]) {
    out.push(mk({ severity: sev("high"), category: "imagery", page: p.slug, viewport: null, title: "An image does not load", description: `${c.brokenImages.length} image(s) fail to load: ${c.brokenImages.slice(0, 3).join(", ")}.`, evidence: { images: c.brokenImages } }));
  }
  if (c.missingAlt.length && p.viewport === allViewports[0]) {
    out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: null, title: "Image without alt text", description: `${c.missingAlt.length} image(s) have no alt attribute.`, evidence: { images: c.missingAlt } }));
  }
  if (p.viewport === allViewports[0]) {
    if (c.headings.h1Count !== 1) out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: null, title: c.headings.h1Count === 0 ? "No main heading" : "More than one main heading", description: `The page has ${c.headings.h1Count} h1 elements; it should have exactly one.`, evidence: { h1Count: c.headings.h1Count } }));
    if (c.headings.skips.length) out.push(mk({ severity: sev("low"), category: "accessibility", page: p.slug, viewport: null, title: "Heading levels skip", description: c.headings.skips.slice(0, 3).join("; "), evidence: { skips: c.headings.skips } }));
    if (c.nav.links > 6) out.push(mk({ severity: sev("low"), category: "navigation", page: p.slug, viewport: null, title: "Crowded navigation", description: `The header navigation has ${c.nav.links} links.`, evidence: { links: c.nav.links } }));
    if (c.forms.unlabeled) out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: null, title: "Form field without a label", description: `${c.forms.unlabeled} of ${c.forms.total} fields have no label.`, evidence: c.forms }));
    if (!c.footer.present) out.push(mk({ severity: sev("high"), category: "footer", page: p.slug, viewport: null, title: "No footer", description: "The page has no footer.", evidence: {} }));
    else {
      if (!c.footer.hasOrgName) out.push(mk({ severity: sev("medium"), category: "footer", page: p.slug, viewport: null, title: "Footer does not name the organization", description: `"${siteName}" does not appear in the footer.`, evidence: c.footer }));
      if (!c.footer.hasContact) out.push(mk({ severity: sev("medium"), category: "footer", page: p.slug, viewport: null, title: "No contact details in the footer", description: "Add a contact email or phone to the Mission Profile so the footer can show it.", evidence: c.footer }));
      if (!c.footer.hasLegal) out.push(mk({ severity: sev("low"), category: "footer", page: p.slug, viewport: null, title: "No legal line in the footer", description: "The footer has no copyright or privacy link.", evidence: c.footer }));
    }
    for (const e of c.emptySections.slice(0, 3)) out.push(mk({ severity: sev("high"), category: "content", page: p.slug, viewport: null, title: "Empty section", description: `Section #${e} renders no text.`, evidence: { section: e }, recheck: (x) => x.emptySections.includes(e), strategies: [() => [{ kind: "section-remove", page: p.slug, sectionId: e }]] }));
    for (const g of c.tallGaps.slice(0, 2)) out.push(mk({ severity: sev("low"), category: "visual", page: p.slug, viewport: null, title: "Large blank space between sections", description: `${g.gap}px of empty space after #${g.after}.`, evidence: g, recheck: (x) => x.tallGaps.some((y) => y.after === g.after), strategies: [() => [{ kind: "section", page: p.slug, sectionId: g.after, set: { density: "dense" } }]] }));
  }
  for (const lc of c.lowContrast.slice(0, 3)) {
    out.push(mk({ severity: sev("medium"), category: "accessibility", page: p.slug, viewport: p.viewport, title: "Low text contrast", description: `${lc.selector} has a contrast ratio of ${lc.ratio}:1.`, evidence: lc,
      recheck: (x) => x.lowContrast.some((y) => y.selector === lc.selector),
      strategies: [(state) => {
        const m = p.measurements.find((x) => x.selector === lc.selector);
        const fg = toHex(m?.color) ?? state.tokens.colors.foreground; const bg = toHex(m?.backgroundColor) ?? state.tokens.colors.background;
        return [{ kind: "style", page: p.slug, selector: lc.selector, viewport: "all", declarations: { color: ensureContrast(fg, bg) }, note: "QA: readable contrast" }];
      }] }));
  }
  if (p.viewport <= 768 && c.nav.toggleVisible && c.nav.menuWorks === "broken") {
    out.push(mk({ severity: sev("critical"), category: "navigation", page: p.slug, viewport: p.viewport, title: "Mobile menu does not open", description: `Tapping the menu button at ${p.viewport}px did not reveal the navigation.`, evidence: c.nav }));
  }
  return out;
}

/** "footer ul > li:nth-of-type(3) > a:nth-of-type(1)" → "footer ul > li > a". */
const generalize = (selector: string) => selector.replace(/:nth-of-type\(\d+\)/g, "");

function sectionOf(p: InspectedPage, selector: string): string {
  const m = /^#([A-Za-z0-9_-]+)/.exec(selector);
  if (m) return m[1]!;
  return p.map.sections[0]?.id ?? "main";
}

function toHex(rgb: string | null | undefined): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb ?? "");
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}

function linkFindings(pages: Array<{ slug: string; html: string }>, known: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const p of pages) {
    const hrefs = [...p.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    const bad = new Set<string>();
    for (const h of hrefs) {
      if (h.startsWith("#") || h.startsWith("mailto:") || h.startsWith("tel:")) continue;
      if (/^https?:\/\//.test(h)) { if (h.startsWith("http://")) bad.add(`${h} (not https)`); continue; }
      const path = h.split(/[?#]/)[0]!.replace(/\/+$/, "/");
      if (path.startsWith("/images/")) continue;
      if (!known.has(path === "" ? "/" : path)) bad.add(h);
    }
    if (bad.size) out.push({ id: uuidv7(), severity: "high", category: "navigation", page: p.slug, viewport: null, title: "Link leads nowhere", description: `${[...bad].slice(0, 4).join(", ")}${bad.size > 4 ? ` and ${bad.size - 4} more` : ""}.`, evidence: { links: [...bad] }, status: "detected", repair: {}, attempts: 0 });
  }
  return out;
}

const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export async function runQaPass(args: QaArgs): Promise<QaOutcome> {
  const { client, storage, progress } = args;
  const record = async (f: Finding) => {
    await client.query(
      `INSERT INTO site_qa_findings (id, tenant_id, site_id, job_id, severity, category, page, viewport, title, description, evidence, status, repair, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, repair = EXCLUDED.repair, attempts = EXCLUDED.attempts, description = EXCLUDED.description`,
      [f.id, args.tenantId, args.siteId, args.jobId, f.severity, f.category, f.page, f.viewport, f.title, f.description, JSON.stringify(f.evidence), f.status, JSON.stringify(f.repair), f.attempts]);
  };

  // ---- load
  await progress?.plan([{ key: "load", label: "Loading website" }]);
  await progress?.start("load", undefined, "testing");
  let state = await loadWorkingState(client, args.siteId);
  const assets = await siteAssets(storage, state);
  const allSlugs = state.pages.filter((p) => p.status !== "hidden").map((p) => p.page.slug);
  const scope = scopeOf(args.instruction, allSlugs);
  const render = () => scope.pages.map((slug) => ({ slug, html: renderWorkingPage(state, slug, { withScript: true }) }));
  let pages = render();
  await progress?.done("load", `${pages.length} page${pages.length === 1 ? "" : "s"}${scope.categories ? `, focus: ${scope.categories.join(", ")}` : ""}`);
  const vpLabel = (v: number) => (v >= 1200 ? `desktop layout (${v}px)` : v >= 1000 ? `small desktop (${v}px)` : v >= 700 ? `tablet layout (${v}px)` : `mobile layout (${v}px)`);
  await progress?.plan([
    ...scope.viewports.map((v) => ({ key: `layout:${v}`, label: `Checking ${vpLabel(v)}` })),
    { key: "navigation", label: "Checking navigation and links" },
    { key: "content", label: "Reviewing copy and Mission Profile alignment" },
    { key: "visual", label: "Reviewing design with screenshots" },
    { key: "capabilities", label: "Checking blog, events and donations" },
  ]);

  let checks = 0;
  const findings: Finding[] = [];
  let browser = true;
  const shotAt = [1440, 768, 390].filter((v) => scope.viewports.includes(v));
  const inspected: InspectedPage[] = [];
  for (const vp of scope.viewports) {
    await progress?.start(`layout:${vp}`);
    const looked = await inspectPages({ pages, assets, viewports: [vp], siteName: state.site.name, interactions: vp <= 768, screenshotAt: shotAt.includes(vp) ? [vp] : [] });
    if (!looked.available) { browser = false; await progress?.skip(`layout:${vp}`, `Browser unavailable: ${looked.reason ?? "unknown"}`); continue; }
    inspected.push(...looked.pages);
    let found = 0;
    for (const p of looked.pages) {
      checks += 12;
      const fs = layoutFindings(p, state.site.name, scope.viewports).filter((f) => !scope.categories || scope.categories.includes(f.category));
      findings.push(...fs); found += fs.length;
    }
    await progress?.done(`layout:${vp}`, found ? `${found} issue${found === 1 ? "" : "s"} found` : "No layout issues");
  }
  // Screenshots are evidence; keep them with the job.
  const screenshotKeys: Record<string, string> = {};
  for (const p of inspected) if (p.screenshot) {
    const key = `tenants/${args.tenantId}/sites/${args.siteId}/qa/${args.jobId}/${p.slug}-${p.viewport}.jpg`;
    try { await storage.put(key, Buffer.from(p.screenshot.base64, "base64")); screenshotKeys[`${p.slug}-${p.viewport}`] = key; } catch { /* evidence only */ }
  }

  // ---- navigation
  await progress?.start("navigation");
  const known = new Set<string>(["/", "/thanks/", "/privacy-policy/", "/blog/", "/events/", "/donate/", ...allSlugs.map((s) => (s === "home" ? "/" : `/${s}/`))]);
  const linkIssues = linkFindings(pages, known).filter((f) => !scope.categories || scope.categories.includes("navigation"));
  findings.push(...linkIssues); checks += pages.length;
  await progress?.done("navigation", linkIssues.length ? `${linkIssues.length} page(s) with broken links` : "Every link resolves");

  // ---- content / mission (model)
  await progress?.start("content");
  if (!scope.categories || scope.categories.some((c) => ["content", "mission", "footer", "navigation"].includes(c))) {
    try {
      const profile = await loadMissionProfile(client, storage, args.tenantId).catch(() => null);
      const res = await runAgentTask<SiteQaReview>(args.provider, websiteQaReviewer, `Review the website of ${state.site.name} for content and mission alignment.${args.instruction ? ` The customer asked: "${args.instruction}".` : ""}`, [
        { label: "pages_text", content: JSON.stringify(pages.map((p) => ({ slug: p.slug, text: visibleText(p.html).slice(0, 6000) }))) },
        { label: "mission_profile", content: profile ? missionProfileBlock(profile) : "(no mission profile available)" },
      ]);
      const review = SiteQaReview.parse(res.output);
      checks += pages.length * 3;
      for (const i of review.issues) {
        const f: Finding = { id: uuidv7(), severity: i.severity, category: i.category, page: i.page, viewport: null, title: i.title, description: i.description, evidence: { quote: i.quote, replacement: i.replacement }, status: "detected", repair: {}, attempts: 0 };
        if (i.quote && i.replacement) {
          const quote = i.quote; const replacement = i.replacement;
          f.strategies = [(s) => {
            const wp = s.pages.find((p) => p.page.slug === i.page); if (!wp) return null;
            for (const [bi, b] of wp.page.blocks.entries()) for (const [k, v] of Object.entries(b)) if (typeof v === "string" && v.includes(quote)) return [{ kind: "copy", page: i.page, blockIndex: bi, field: k, value: v.replace(quote, replacement) }];
            return null;
          }];
          f.recheck = () => false;
        }
        findings.push(f);
      }
      if (!review.missionClear && !review.issues.some((i) => i.category === "mission")) findings.push({ id: uuidv7(), severity: "high", category: "mission", page: "home", viewport: null, title: "Mission is not clear on the homepage", description: review.summary, evidence: {}, status: "detected", repair: {}, attempts: 0 });
      await progress?.done("content", review.issues.length ? `${review.issues.length} content issue(s)` : review.summary.slice(0, 160));
    } catch (err) {
      await progress?.fail("content", `Review unavailable: ${String((err as Error).message ?? err).slice(0, 140)}`);
    }
  } else await progress?.skip("content", "Out of scope for this request");

  // ---- visual (critic with screenshots)
  await progress?.start("visual");
  const critic = args.critic ?? args.provider;
  const withShots = inspected.filter((p) => p.screenshot);
  if (withShots.length && (!scope.categories || scope.categories.includes("visual") || scope.categories.includes("imagery"))) {
    let count = 0;
    for (const slug of [...new Set(withShots.map((p) => p.slug))].slice(0, 4)) {
      const wp = state.pages.find((p) => p.page.slug === slug)!;
      try {
        const report = await critiquePage({ provider: critic, page: { slug, title: wp.page.title }, composition: wp.composition, language: state.language, html: pages.find((p) => p.slug === slug)!.html, screenshots: withShots.filter((p) => p.slug === slug).map((p) => ({ width: p.viewport, height: 0, mime: p.screenshot!.mime, base64: p.screenshot!.base64 })) });
        checks += 13;
        for (const issue of report.issues.filter((i) => i.severity !== "low").slice(0, 5)) {
          count += 1;
          const fixIssue = issue;
          findings.push({ id: uuidv7(), severity: issue.severity === "high" ? "high" : "medium", category: "visual", page: slug, viewport: null, title: issue.problem.slice(0, 120), description: `Design review (lowest score ${lowestScore(report)}/10). Suggested fix: ${issue.fix}.`, evidence: { section: issue.section, fix: issue.fix, scores: report.scores }, status: "detected", repair: {}, attempts: 0,
            strategies: issue.fix === "none" ? undefined : [(s) => {
              const page = s.pages.find((p) => p.page.slug === slug); if (!page) return null;
              const fixed = repairComposition(page.composition, [fixIssue]);
              if (!fixed.applied.length) return null;
              const section = fixed.composition.sections.find((x) => x.id === fixIssue.section);
              if (!section) return null;
              return [{ kind: "section", page: slug, sectionId: section.id, set: { component: section.component, variant: section.variant, background: section.background, density: section.density, imagePosition: section.imagePosition, motion: section.motion } }];
            }], recheck: () => false });
        }
      } catch (err) { await progress?.merge({ visualError: String((err as Error).message ?? err).slice(0, 160) }); }
    }
    await progress?.done("visual", count ? `${count} design issue(s) from the critic` : "Design review found nothing to fix");
  } else await progress?.skip("visual", browser ? "Out of scope for this request" : "No screenshots without a browser");

  // ---- capabilities: blog, events, donations
  await progress?.start("capabilities");
  {
    const cap: string[] = [];
    const { rows: posts } = await client.query("SELECT count(*)::int AS n FROM site_posts WHERE site_id = $1 AND status = 'published'", [args.siteId]);
    const { rows: events } = await client.query("SELECT count(*)::int AS n FROM site_events WHERE site_id = $1 AND status = 'published'", [args.siteId]);
    checks += 3;
    cap.push(`blog: ${posts[0].n} published post(s)`, `events: ${events[0].n} published`);
    const donateOk = state.donateUrl ? /^https:\/\//.test(state.donateUrl) : pages.some((p) => /donate/i.test(p.html));
    if (state.donateUrl && !/^https:\/\//.test(state.donateUrl)) findings.push({ id: uuidv7(), severity: "critical", category: "donations", page: "donate", viewport: null, title: "Donation link is not secure", description: `The donation link ${state.donateUrl} must use https.`, evidence: { donateUrl: state.donateUrl }, status: "detected", repair: {}, attempts: 0 });
    if (!state.donateUrl && !allSlugs.includes("donate")) findings.push({ id: uuidv7(), severity: "medium", category: "donations", page: null, viewport: null, title: "No way to donate", description: "Add a donation link under Website → Donations so every page can point to it.", evidence: {}, status: "detected", repair: {}, attempts: 0 });
    cap.push(`donations: ${donateOk ? "ok" : "missing"}`);
    await progress?.done("capabilities", cap.join(" · "));
  }

  // Dedupe by page+title+viewport-kind, keep the worst.
  const seen = new Map<string, Finding>();
  for (const f of findings) { const k = `${f.page}|${f.title}|${f.viewport && f.viewport <= 480 ? "m" : f.viewport && f.viewport <= 1024 ? "t" : "d"}`; const prev = seen.get(k); if (!prev || rank(f.severity) > rank(prev.severity)) seen.set(k, f); }
  const unique = [...seen.values()];
  for (const f of unique) await record(f);

  // ---- repair loop
  const repairable = unique.filter((f) => f.strategies?.length);
  let repaired = 0;
  if (repairable.length) {
    await progress?.plan([{ key: "repair", label: `Repairing ${repairable.length} issue${repairable.length === 1 ? "" : "s"}` }, { key: "reverify", label: "Verifying repairs" }]);
    await progress?.start("repair", undefined, "repairing");
    const touched = new Set<string>();
    for (const f of repairable) {
      f.status = "repairing"; await record(f);
      let fixed = false;
      for (const strategy of f.strategies!) {
        if (f.attempts >= MAX_ATTEMPTS) break;
        f.attempts += 1;
        const ops = strategy(state);
        if (!ops) continue;
        const applied = applyOperations(state, ops);
        if (!applied.changed.size) continue;
        const candidate = applied.state;
        // Re-check the page this finding is on, at its width, with the change in place.
        let cleared = true;
        if (f.recheck && f.page && browser) {
          const html = renderWorkingPage(candidate, f.page, { withScript: true });
          const looked = await inspectPages({ pages: [{ slug: f.page, html }], assets, viewports: [f.viewport ?? 1440], siteName: state.site.name, interactions: (f.viewport ?? 1440) <= 768 });
          const after = looked.pages[0];
          if (after) cleared = !f.recheck(after.checks) && !(after.checks.horizontalOverflow && !(f.category === "responsive"));
        }
        if (cleared) { state = candidate; applied.changed.forEach((s) => touched.add(s)); f.status = "fixed"; f.repair = { ops, attempt: f.attempts, notes: applied.notes }; fixed = true; break; }
      }
      if (!fixed) { f.status = "needs_review"; f.repair = { ...f.repair, attempts: f.attempts, note: "No safe automatic repair confirmed" }; } else repaired += 1;
      await record(f);
    }
    await progress?.done("repair", `${repaired} repaired, ${repairable.length - repaired} left for review`);
    // Verify: re-render, re-inspect the touched pages at every width; a repair
    // that broke something is reverted.
    await progress?.start("reverify", undefined, "verifying");
    if (touched.size) {
      pages = render();
      const looked = await inspectPages({ pages: pages.filter((p) => touched.has(p.slug)), assets, viewports: scope.viewports, siteName: state.site.name, interactions: true });
      const regressions = looked.pages.filter((p) => p.checks.horizontalOverflow && !inspected.find((x) => x.slug === p.slug && x.viewport === p.viewport)?.checks.horizontalOverflow);
      if (regressions.length) {
        for (const f of unique.filter((x) => x.status === "fixed" && regressions.some((r) => r.slug === x.page))) { f.status = "needs_review"; f.repair = { ...f.repair, reverted: true }; await record(f); repaired -= 1; }
        state = await loadWorkingState(client, args.siteId);
        await progress?.done("reverify", `Reverted repairs on ${regressions.length} page(s) that regressed`);
      } else {
        await saveWorkingState(client, state, touched);
        for (const f of unique.filter((x) => x.status === "fixed")) { f.status = "verified"; await record(f); }
        await progress?.done("reverify", `${repaired} repair${repaired === 1 ? "" : "s"} verified at ${scope.viewports.join("/")}px`);
      }
    } else await progress?.skip("reverify", "Nothing was changed");
  }
  for (const f of unique.filter((x) => x.status === "detected")) { f.status = "needs_review"; await record(f); }

  // ---- release + verdict
  let releaseId: string | null = null;
  if (repaired > 0) {
    await progress?.plan([{ key: "release", label: "Building the repaired version" }]);
    await progress?.start("release", undefined, "building");
    const logo = await loadSiteLogoFrom(client, storage);
    const rel = await assembleRelease({ client, storage, tenantId: args.tenantId, siteId: args.siteId, runId: args.runId ?? null, kind: "qa_repair", label: `QA repairs (${repaired})`, createdBy: args.createdBy ?? null, createdByKind: "agent", logo });
    releaseId = rel.releaseId;
    await progress?.done("release", `Version ${rel.version}`);
  }
  const review = unique.filter((f) => f.status === "needs_review").length;
  const criticalOpen = unique.some((f) => f.status === "needs_review" && (f.severity === "critical" || f.severity === "high"));
  const categories: Record<string, "pass" | "review"> = {};
  for (const c of ["responsive", "visual", "navigation", "header", "footer", "imagery", "content", "accessibility", "mission", "donations"]) categories[c] = unique.some((f) => f.category === c && f.status === "needs_review") ? "review" : "pass";
  const status: QaOutcome["status"] = !browser && !unique.length ? "failed" : criticalOpen || review > 0 ? "review" : "passed";
  await client.query("UPDATE sites SET qa_status = $2, qa_job_id = $3, last_qa_at = now() WHERE id = $1", [args.siteId, status === "failed" ? "failed" : status, args.jobId]);
  await progress?.merge({ screenshots: screenshotKeys, browser, scope: { viewports: scope.viewports, pages: scope.pages, categories: scope.categories } });
  await audit(client, { tenantId: args.tenantId, actorAgent: websiteQaReviewer.agentKey, action: "site.qa_completed", entityType: "site", entityId: args.siteId, metadata: { jobId: args.jobId, status, detected: unique.length, repaired, review } });
  return { status, checks, detected: unique.length, repaired, review, categories, releaseId, browser };
}

const rank = (s: Severity) => ({ critical: 4, high: 3, medium: 2, low: 1 })[s];
