import type { PoolClient } from "pg";
import { uuidv7, type StorageAdapter } from "@deedwell/database";
import { DesignTokens, SitePage, type SiteBlock, type SiteEditOp, type StyleOverride } from "@deedwell/schemas";
import { CATALOG, COMPONENTS, DEFAULT_COMPONENT, DEFAULT_LANGUAGE, fallbackTokens, finalize, normalizeComposition, renderPage, type ComponentName, type DesignLanguage, type PageComposition, type Section } from "../builder/index.js";
import { pageContentHash, type Organization } from "../design.js";
import type { SiteImage } from "../images.js";
import { cleanDeclarations, cleanSelector, injectOverrides, mergeOverride, overridesCss } from "./overrides.js";

/**
 * The site's working state — what the editor and the QA repairer change
 * and the renderer draws from:
 *
 *   pages        copy blocks (site_pages)            — what the site says
 *   compositions per-page plans (site_build_stages)  — how each page is laid out
 *   tokens       design tokens (sites.theme)         — the site's look
 *   overrides    scoped CSS (sites.edits)            — surgical presentation fixes
 *
 * Rendering is deterministic, so a change here is exactly the change on the
 * page: nothing a model wrote reaches a page as markup.
 */

export interface WorkingPage {
  page: SitePage; status: "published" | "hidden"; orderIdx: number; composition: PageComposition;
  /** The page's own designed markup when it was not rendered by the current
   *  pipeline (an older model-designed site). Such a page is edited with
   *  style overrides only — its markup is never re-rendered from the plan,
   *  which would replace the design the nonprofit already approved. */
  designedHtml: string | null;
}

export interface WorkingState {
  site: { id: string; slug: string; name: string; tenantId: string };
  pages: WorkingPage[];
  language: DesignLanguage;
  tokens: DesignTokens;
  overrides: StyleOverride[];
  /** Where the organization's brand logo lives inside the site, when Brand
   *  Style has one — regardless of whether the site currently shows it. */
  brandLogoPath: string | null;
  /** "brand": show the brand logo; "none": the site hides it. */
  logo: "brand" | "none";
  images: SiteImage[];
  organization: Organization;
  donateUrl: string | null;
  /** True when the site was built by the current pipeline; false when its
   *  look had to be derived (an older, template-built site). */
  native: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function orgFacts(client: PoolClient, tenantId: string): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT fact_key, value FROM org_facts WHERE tenant_id = $1 AND status <> 'rejected'", [tenantId]);
  const out: Record<string, string> = {};
  for (const r of rows) { const v = typeof r.value === "string" ? r.value : JSON.stringify(r.value); if (!(r.fact_key in out)) out[r.fact_key] = v.replace(/^"|"$/g, ""); }
  return out;
}

export async function loadOrganization(client: PoolClient, tenantId: string, site: { name: string }, intake: Record<string, unknown>, logoPath: string | null): Promise<Organization> {
  const f = await orgFacts(client, tenantId);
  const status = f.entity_type ?? f.registration_status ?? null;
  return {
    name: site.name, logoPath,
    legalName: f.legal_name ?? null, mission: f.mission ?? null, headquarters: f.headquarters ?? null,
    status: status ? (/nonprofit|non-profit|charity/i.test(status) ? status : `${status} nonprofit`) : null,
    ein: f.ein ?? null,
    contactEmail: str(intake.site_contact_email) ?? f.contact_email ?? f.email ?? null,
    contactPhone: f.phone ?? f.contact_phone ?? null,
  };
}

export async function loadIntake(client: PoolClient, siteId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query("SELECT question_key, value FROM site_intake_answers WHERE site_id = $1", [siteId]);
  return Object.fromEntries(rows.map((r) => [r.question_key, r.value]));
}

export async function loadWorkingState(client: PoolClient, siteId: string): Promise<WorkingState> {
  const { rows: sites } = await client.query("SELECT id, tenant_id, slug, name, theme, images, edits, donations FROM sites WHERE id = $1", [siteId]);
  const site = sites[0];
  if (!site) throw new Error("Site not found");
  const theme = (site.theme ?? {}) as Record<string, unknown>;
  const intake = await loadIntake(client, siteId);
  const logo = (await client.query("SELECT value FROM org_facts WHERE tenant_id = $1 AND fact_key = 'brand_logo_file_id' LIMIT 1", [site.tenant_id])).rows[0];
  const logoId = String(logo?.value ?? "").trim().replace(/^"|"$/g, "");
  // A cleared logo is an empty value; querying files with it would abort
  // the surrounding transaction, so it is checked before any query.
  const logoPath = /^[0-9a-f-]{36}$/.test(logoId) ? (await (async () => {
    const id = logoId;
    const f = (await client.query("SELECT mime FROM files WHERE id = $1", [id])).rows[0];
    const ext = f?.mime === "image/png" ? "png" : f?.mime === "image/jpeg" ? "jpg" : f?.mime === "image/webp" ? "webp" : null;
    return ext ? `/images/logo.${ext}` : null;
  })()) : null;
  const edits = (site.edits ?? {}) as { overrides?: unknown; logo?: unknown };
  const logoSetting: "brand" | "none" = edits.logo === "none" ? "none" : "brand";
  const organization = await loadOrganization(client, site.tenant_id, site, intake, logoSetting === "none" ? null : logoPath);
  const donations = (site.donations ?? {}) as { donateUrl?: string | null };
  const donateUrl = str(donations.donateUrl) ?? str(intake.site_donate_url);

  const languageParsed = theme.language && typeof theme.language === "object" ? (theme.language as DesignLanguage) : null;
  const language = languageParsed ?? DEFAULT_LANGUAGE;
  const tokensParsed = DesignTokens.safeParse(theme.tokens);
  const tokens = tokensParsed.success ? tokensParsed.data : fallbackTokens(language, { primaryColor: str(intake.site_brand_primary_color) });
  const images: SiteImage[] = Array.isArray(site.images) ? site.images : [];
  const overrides: StyleOverride[] = Array.isArray(edits.overrides) ? (edits.overrides as StyleOverride[]) : [];

  const { rows: pageRows } = await client.query("SELECT slug, title, blocks, seo, order_idx, status, rendered_html, rendered_hash FROM site_pages WHERE site_id = $1 ORDER BY order_idx", [siteId]);
  const { rows: plans } = await client.query("SELECT scope, output FROM site_build_stages WHERE site_id = $1 AND stage = 'page_plan'", [siteId]);
  const planFor = new Map<string, unknown>(plans.map((p) => [p.scope, (p.output as { composition?: unknown })?.composition ?? p.output]));
  const pages: WorkingPage[] = pageRows.map((r, i) => {
    const page = SitePage.parse({ slug: r.slug, title: r.title, blocks: r.blocks, seoDescription: r.seo?.description ?? "" });
    const composition = normalizeComposition(planFor.get(r.slug) ?? null, { page, images, donateUrl, language });
    // A release swaps in rendered_html whose hash matches the copy; the
    // pipeline tags its own renders ":pipeline", so anything else is a design.
    const hash = String(r.rendered_hash ?? "");
    const designed = r.rendered_html && hash.split(":")[0] === pageContentHash(page) && !hash.endsWith(":pipeline") ? String(r.rendered_html) : null;
    return { page, status: r.status === "hidden" ? "hidden" : "published", orderIdx: r.order_idx ?? i, composition, designedHtml: designed };
  });
  if (!pages.some((p) => p.page.slug === "home") && pages[0]) pages[0].page = { ...pages[0].page, slug: "home" };
  return { site: { id: site.id, slug: site.slug, name: site.name, tenantId: site.tenant_id }, pages, language, tokens, overrides, brandLogoPath: logoPath, logo: logoSetting, images, organization, donateUrl, native: tokensParsed.success };
}

export function navOf(state: WorkingState): Array<{ title: string; href: string }> {
  return state.pages.filter((p) => p.status !== "hidden").map((p) => ({ title: p.page.title, href: p.page.slug === "home" ? "/" : `/${p.page.slug}/` }));
}

/** One page, rendered from the working state. Deterministic. */
export function renderWorkingPage(state: WorkingState, slug: string, opts: { withScript?: boolean } = {}): string {
  const wp = state.pages.find((p) => p.page.slug === slug);
  if (!wp) throw new Error(`No page "${slug}"`);
  if (wp.designedHtml) return injectOverrides(wp.designedHtml, overridesCss(state.overrides, slug));
  const nav = navOf(state);
  const html = renderPage({
    ctx: { site: { name: state.site.name, slug: state.site.slug }, tokens: state.tokens, images: state.images, organization: state.organization, donateUrl: state.donateUrl, nav },
    page: wp.page, composition: wp.composition, tokens: state.tokens, withScript: opts.withScript ?? false,
  });
  const finished = finalize(html, { site: state.site, organization: state.organization }, nav, state.tokens);
  return injectOverrides(finished, overridesCss(state.overrides, slug));
}

// ---- operations -------------------------------------------------------------

export interface ApplyResult { state: WorkingState; changed: Set<string>; notes: string[]; rejected: string[] }

function setPath(target: Record<string, unknown>, path: string[], value: string): boolean {
  let cur: unknown = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return false;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) { if (!(Number(last) < cur.length)) return false; cur[Number(last)] = value; return true; }
  if (cur && typeof cur === "object") {
    const obj = cur as Record<string, unknown>;
    if (!(last in obj) || typeof obj[last] !== "string" && obj[last] !== null) return false;
    obj[last] = value; return true;
  }
  return false;
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}

/** Applies the editor's operations to a copy of the state. Every page it
 *  touches is renormalised so the composition stays valid for its blocks. */
export function applyOperations(input: WorkingState, ops: SiteEditOp[]): ApplyResult {
  const state: WorkingState = { ...input, pages: input.pages.map((p) => ({ ...p, page: { ...p.page, blocks: p.page.blocks.map((b) => ({ ...b })) }, composition: { ...p.composition, sections: p.composition.sections.map((s) => ({ ...s })) } })), overrides: [...input.overrides] };
  const changed = new Set<string>();
  const notes: string[] = [];
  const rejected: string[] = [];
  const pageOf = (slug: string) => state.pages.find((p) => p.page.slug === slug);
  const renorm = (wp: WorkingPage) => { wp.composition = normalizeComposition(wp.composition, { page: wp.page, images: state.images, donateUrl: state.donateUrl, language: state.language }); };
  const touch = (slug: string) => changed.add(slug);
  const everyPage = () => state.pages.forEach((p) => changed.add(p.page.slug));

  const designedOnly = (op: SiteEditOp): boolean => {
    if (op.kind === "logo") return false;
    const slug = "page" in op ? op.page : null;
    const wp = slug && slug !== "*" ? pageOf(slug) : null;
    if (op.kind === "tokens" ? state.pages.every((p) => p.designedHtml) : Boolean(wp?.designedHtml)) {
      rejected.push(`${op.kind}: ${slug ?? "site"} keeps its designed markup; only styling changes (style) can be made to it`);
      return true;
    }
    return false;
  };

  for (const op of ops) {
    if (op.kind !== "style" && op.kind !== "logo" && designedOnly(op)) continue;
    switch (op.kind) {
      case "style": {
        const selector = cleanSelector(op.selector);
        const declarations = cleanDeclarations(op.declarations);
        if (!selector || !Object.keys(declarations).length) { rejected.push(`style: unsafe selector or declarations (${op.selector})`); break; }
        if (op.page !== "*" && !pageOf(op.page)) { rejected.push(`style: no page ${op.page}`); break; }
        state.overrides = mergeOverride(state.overrides, { page: op.page, selector, viewport: op.viewport ?? "all", declarations, note: op.note });
        if (op.page === "*") everyPage(); else touch(op.page);
        notes.push(`${op.page === "*" ? "site-wide" : op.page}: ${selector}${op.viewport && op.viewport !== "all" ? ` (${op.viewport})` : ""} ← ${Object.entries(declarations).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
        break;
      }
      case "section": {
        const wp = pageOf(op.page); const s = wp?.composition.sections.find((x) => x.id === op.sectionId);
        if (!wp || !s) { rejected.push(`section: ${op.page}#${op.sectionId} not found`); break; }
        const set = { ...op.set } as Partial<Section> & { component?: string };
        if (set.component && !(COMPONENTS as readonly string[]).includes(set.component)) { rejected.push(`section: unknown component ${set.component}`); delete set.component; }
        if (set.component && !CATALOG[set.component as ComponentName].accepts.includes(wp.page.blocks[s.block]!.kind)) { rejected.push(`section: ${set.component} cannot present a ${wp.page.blocks[s.block]!.kind} block`); delete set.component; }
        if (set.overrides) s.overrides = { ...(s.overrides ?? {}), ...set.overrides };
        const { overrides: _o, ...rest } = set; void _o;
        Object.assign(s, rest as Partial<Section>);
        renorm(wp); touch(op.page);
        notes.push(`${op.page}#${op.sectionId}: ${Object.keys(op.set).join(", ")} updated`);
        break;
      }
      case "section-move": {
        const wp = pageOf(op.page); const idx = wp?.composition.sections.findIndex((x) => x.id === op.sectionId) ?? -1;
        if (!wp || idx < 0) { rejected.push(`section-move: ${op.page}#${op.sectionId} not found`); break; }
        const pairs = wp.composition.sections.map((s) => ({ s, b: wp.page.blocks[s.block]! }));
        const [moved] = pairs.splice(idx, 1);
        pairs.splice(Math.min(op.position, pairs.length), 0, moved!);
        wp.page.blocks = pairs.map((p) => p.b);
        wp.composition.sections = pairs.map((p, i) => ({ ...p.s, block: i }));
        renorm(wp); touch(op.page); notes.push(`${op.page}#${op.sectionId}: moved to position ${op.position + 1}`);
        break;
      }
      case "section-remove": {
        const wp = pageOf(op.page); const idx = wp?.composition.sections.findIndex((x) => x.id === op.sectionId) ?? -1;
        if (!wp || idx < 0) { rejected.push(`section-remove: ${op.page}#${op.sectionId} not found`); break; }
        if (wp.composition.sections.length <= 1) { rejected.push("section-remove: a page keeps at least one section"); break; }
        const pairs = wp.composition.sections.map((s) => ({ s, b: wp.page.blocks[s.block]! }));
        pairs.splice(idx, 1);
        wp.page.blocks = pairs.map((p) => p.b);
        wp.composition.sections = pairs.map((p, i) => ({ ...p.s, block: i }));
        renorm(wp); touch(op.page); notes.push(`${op.page}#${op.sectionId}: removed`);
        break;
      }
      case "section-add": {
        const wp = pageOf(op.page);
        if (!wp) { rejected.push(`section-add: no page ${op.page}`); break; }
        const component = (COMPONENTS as readonly string[]).includes(op.component) ? (op.component as ComponentName) : null;
        const block: SiteBlock | null = typeof op.block === "number" ? (wp.page.blocks[op.block] ? { ...wp.page.blocks[op.block]! } : null) : op.block;
        if (!block) { rejected.push("section-add: no block"); break; }
        const comp = component && CATALOG[component].accepts.includes(block.kind) ? component : DEFAULT_COMPONENT[block.kind];
        if (wp.page.blocks.length >= 20 || wp.composition.sections.length >= 12) { rejected.push("section-add: the page is full"); break; }
        const pairs = wp.composition.sections.map((s) => ({ s, b: wp.page.blocks[s.block]! }));
        const at = op.afterSectionId ? pairs.findIndex((p) => p.s.id === op.afterSectionId) + 1 : 0;
        const id = `added-${uuidv7().slice(-6)}`;
        pairs.splice(at < 0 ? pairs.length : at, 0, { b: block, s: { id, purpose: op.purpose, component: comp, variant: op.variant, background: op.background, block: 0, density: "balanced", motion: "fade-up", mobile: "stack", imagePosition: "none", image: null } });
        wp.page.blocks = pairs.map((p) => p.b);
        wp.composition.sections = pairs.map((p, i) => ({ ...p.s, block: i }));
        renorm(wp); touch(op.page); notes.push(`${op.page}: added ${comp}${op.afterSectionId ? ` after #${op.afterSectionId}` : " at the top"}`);
        break;
      }
      case "copy": {
        const wp = pageOf(op.page);
        const block = wp?.page.blocks[op.blockIndex];
        if (!wp || !block) { rejected.push(`copy: ${op.page} block ${op.blockIndex} not found`); break; }
        if (op.field === "kind") { rejected.push("copy: a block's kind cannot change"); break; }
        const ok = setPath(block as unknown as Record<string, unknown>, op.field.split("."), op.value);
        const parsed = ok ? SitePage.safeParse(wp.page) : null;
        if (!ok || !parsed?.success) { rejected.push(`copy: ${op.page} block ${op.blockIndex}.${op.field} is not an editable text field`); break; }
        touch(op.page); notes.push(`${op.page}: block ${op.blockIndex + 1} ${op.field} rewritten`);
        break;
      }
      case "tokens": {
        const merged = DesignTokens.safeParse(deepMerge(state.tokens as unknown as Record<string, unknown>, op.patch as Record<string, unknown>));
        if (!merged.success) { rejected.push(`tokens: ${merged.error.issues[0]?.path.join(".")} ${merged.error.issues[0]?.message}`); break; }
        state.tokens = merged.data; everyPage(); notes.push(`design tokens: ${Object.keys(op.patch).join(", ")} changed`);
        break;
      }
      case "logo": {
        if (op.action === "use-brand" && !state.brandLogoPath) { rejected.push("logo: the organization has no brand logo yet — upload one in Mission Profile → Brand Style first"); break; }
        state.logo = op.action === "use-brand" ? "brand" : "none";
        state.organization = { ...state.organization, logoPath: state.logo === "brand" ? state.brandLogoPath : null };
        for (const wp of state.pages) if (wp.designedHtml) wp.designedHtml = patchBrandMark(wp.designedHtml, state.logo === "brand" ? state.brandLogoPath : null, state.site.name);
        everyPage(); notes.push(op.action === "use-brand" ? "logo: the current brand logo is used on every page" : "logo: removed from every page");
        break;
      }
      case "page-cta": {
        const wp = pageOf(op.page);
        if (!wp) { rejected.push(`page-cta: no page ${op.page}`); break; }
        wp.composition.primaryCta = op.primaryCta; touch(op.page); notes.push(`${op.page}: primary call to action ${op.primaryCta ? `→ ${op.primaryCta.label}` : "removed"}`);
        break;
      }
    }
  }
  return { state, changed, notes, rejected };
}

// ---- designed pages: the brand mark --------------------------------------------

/**
 * Puts the brand logo into (or takes it out of) a designed page without
 * re-rendering it: an existing <img class="brand__logo"> gets the current
 * path; otherwise the header/footer brand element gets the image in place
 * of the name. With no path, the image goes and the name comes back.
 */
const BRAND_LOGO_CSS = `<style id="site-brand-logo">.brand__logo{display:block;height:40px;width:auto;max-width:220px;object-fit:contain}.footer__about .brand__logo,footer .brand__logo{height:44px}</style>`;

/** A designed page rarely styles .brand__logo itself; the size rule rides
 *  along with the image so the logo never renders at its natural size. */
function withBrandLogoCss(html: string, logoPath: string | null): string {
  const stripped = html.replace(/<style id="site-brand-logo">[\s\S]*?<\/style>/i, "");
  if (!logoPath || /\.brand__logo\s*\{/.test(stripped)) return stripped;
  return /<\/head>/i.test(stripped) ? stripped.replace(/<\/head>/i, `${BRAND_LOGO_CSS}</head>`) : BRAND_LOGO_CSS + stripped;
}

export function patchBrandMark(html: string, logoPath: string | null, siteName: string): string {
  return withBrandLogoCss(patchBrandMarkup(html, logoPath, siteName), logoPath);
}

function patchBrandMarkup(html: string, logoPath: string | null, siteName: string): string {
  const img = logoPath ? `<img class="brand__logo" src="${escHtml(logoPath)}" alt="${escHtml(siteName)}">` : "";
  const existing = /<img\b[^>]*class="[^"]*\bbrand__logo\b[^"]*"[^>]*>/gi;
  if (existing.test(html)) {
    if (logoPath) return html.replace(existing, img);
    // Remove the image; a brand element left empty shows the name again.
    return html.replace(existing, "").replace(/(<(a|p|div|span)\b[^>]*class="[^"]*\bbrand\b[^"]*"[^>]*>)(\s*)(<\/\2>)/gi, (_m, open: string, _t: string, _ws: string, close: string) => `${open}${escHtml(siteName)}${close}`);
  }
  if (!logoPath) return html;
  // Header/footer brand element: its content (the name, possibly wrapped in
  // spans) becomes the image. Anything already holding an image is left.
  const out = html.replace(/(<(a|p|div|span)\b[^>]*class="[^"]*\bbrand\b[^"]*"[^>]*>)((?:(?!<\/\2>)[\s\S])*?)(<\/\2>)/gi, (m: string, open: string, _t: string, inner: string, close: string) => (/<img\b|<svg\b/i.test(inner) ? m : `${open}${img}${close}`));
  if (out.includes("brand__logo")) return out;
  // No brand element: the header's home link that reads as the site name.
  const name = escRe(escHtml(siteName.trim()));
  return out.replace(/(<a\b[^>]*href="\/(?:index\.html)?"[^>]*>)(\s*(?:<[^>]+>\s*)*)([^<]*)((?:\s*<\/[^>]+>)*\s*)(<\/a>)/i, (m: string, open: string, _pre: string, text: string, _post: string, close: string) => (new RegExp(`^\\s*${name}\\s*$`, "i").test(text) ? `${open}${img}${close}` : m));
}

// ---- designed pages: wording edits --------------------------------------------

const escHtml = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const escRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every text field of a block, by dot path — null/empty included as "",
 *  so a field the design left out can be told apart from an added entry. */
function textLeaves(value: unknown, path: string[] = [], out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === "string") out.push([path.join("."), value]);
  else if (value === null || value === undefined) { if (path.length) out.push([path.join("."), ""]); }
  else if (Array.isArray(value)) value.forEach((v, i) => textLeaves(v, [...path, String(i)], out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (!path.length && k === "kind") continue; textLeaves(v, [...path, k], out); }
  return out;
}

export interface DesignedPatch { html: string; changed: string[] }

/** Fields a designed page can gain even when its design left them out:
 *  where the text goes, relative to what every design has. */
const INSERTABLE: Record<string, (html: string, text: string) => string | null> = {
  "hero.eyebrow": (html, text) => { const m = /<h1\b/i.exec(html); return m ? `${html.slice(0, m.index)}<p class="eyebrow">${escHtml(text)}</p>${html.slice(m.index)}` : null; },
  "hero.tagline": (html, text) => { const m = /<\/h1>/i.exec(html); return m ? `${html.slice(0, m.index + 5)}<p class="lead">${escHtml(text)}</p>${html.slice(m.index + 5)}` : null; },
};

/** Which fields of a block a designed page can change: present on the
 *  page as written, or insertable. Drives the CMS form for such pages. */
export function designedEditableFields(html: string, block: SiteBlock): string[] {
  const out: string[] = [];
  for (const [field, value] of textLeaves(block)) {
    const from = value.trim();
    if (from.length >= 2 && (html.includes(escHtml(from)) || html.includes(from))) out.push(field);
    else if (!from && INSERTABLE[`${block.kind}.${field}`]) out.push(field);
  }
  return out;
}

/**
 * A page that keeps designed markup cannot be re-rendered from its blocks
 * without losing the design, so a wording change is made to the markup
 * itself: each changed text is found in the page (as the designer escaped
 * it) and replaced; a cleared field's element goes; a few fields the design
 * left out can be added in a known place. Entries are never added or
 * removed here, and a change that cannot be made is refused with the field.
 */
export function patchDesignedCopy(html: string, before: SiteBlock, after: SiteBlock): DesignedPatch | { error: string } {
  const prev = new Map(textLeaves(before));
  const next = textLeaves(after);
  if (next.length !== prev.size || next.some(([k]) => !prev.has(k))) return { error: "On a designed page you can change the wording, but not add or remove entries. Ask the AI editor for that." };
  let out = html;
  const changed: string[] = [];
  for (const [field, value] of next) {
    const old = (prev.get(field) ?? "").trim();
    const now = value.trim();
    if (old === now) continue;
    if (!old) {
      const insert = INSERTABLE[`${before.kind}.${field}`];
      const inserted = insert ? insert(out, now) : null;
      if (!inserted) return { error: `"${field}" is not part of this page's design, so it cannot be added here.` };
      out = inserted; changed.push(field); continue;
    }
    if (old.length < 2) return { error: `"${field}" is too short to find on the page.` };
    const variants = [escHtml(old), old];
    const hit = variants.find((v) => out.includes(v));
    if (!hit) return { error: `The current text of "${field}" ("${old.slice(0, 60)}${old.length > 60 ? "…" : ""}") is not on the designed page as written, so it cannot be replaced here. Change it in the AI editor instead.` };
    if (!now) {
      // Cleared: the element that holds exactly this text goes with it.
      const el = new RegExp(`<(p|span|small|em|strong|h[1-6])\\b[^>]*>\\s*${escRe(hit)}\\s*<\\/\\1>`, "i");
      out = el.test(out) ? out.replace(el, "") : out.replace(new RegExp(`(>[^<]*?)${escRe(hit)}(?=[^<]*<)`), "$1");
      changed.push(field); continue;
    }
    // Only text between tags is replaced — never an attribute or a tag.
    const re = new RegExp(`(>[^<]*?)${escRe(hit)}(?=[^<]*<)`, "g");
    const replaced = out.replace(re, (_m, lead: string) => `${lead}${escHtml(now)}`);
    if (replaced === out) return { error: `"${field}" appears on the page only inside markup, so it cannot be replaced here. Change it in the AI editor instead.` };
    out = replaced;
    changed.push(field);
  }
  return { html: out, changed };
}

// ---- persistence -------------------------------------------------------------

/** Writes the working state back. Pages that changed get their new
 *  rendering and hash; the plans keep their memo key so the next full
 *  build reuses the edited composition instead of re-planning it. */
export async function saveWorkingState(client: PoolClient, state: WorkingState, changed: Iterable<string>): Promise<void> {
  const slugs = new Set(changed);
  await client.query("UPDATE sites SET theme = theme || $2::jsonb, edits = $3::jsonb WHERE id = $1",
    [state.site.id, JSON.stringify({ tokens: state.tokens, language: state.language }), JSON.stringify({ overrides: state.overrides, logo: state.logo })]);
  for (const [i, wp] of state.pages.entries()) {
    const html = slugs.has(wp.page.slug) ? renderWorkingPage(state, wp.page.slug) : null;
    await client.query(
      `UPDATE site_pages SET title = $3, blocks = $4, seo = seo || $5::jsonb, order_idx = $6,
              rendered_html = COALESCE($7, rendered_html), rendered_hash = COALESCE($8, rendered_hash)
        WHERE site_id = $1 AND slug = $2`,
      [state.site.id, wp.page.slug, wp.page.title, JSON.stringify(wp.page.blocks), JSON.stringify({ description: wp.page.seoDescription }), i,
        html, html ? `${pageContentHash(wp.page)}${wp.designedHtml ? ":designed" : ":pipeline"}` : null]);
    const existing = await client.query("SELECT id FROM site_build_stages WHERE site_id = $1 AND stage = 'page_plan' AND scope = $2", [state.site.id, wp.page.slug]);
    if (existing.rows[0]) {
      await client.query("UPDATE site_build_stages SET output = jsonb_set(COALESCE(output, '{}'::jsonb), '{composition}', $2::jsonb) WHERE id = $1", [existing.rows[0].id, JSON.stringify(wp.composition)]);
    } else {
      await client.query(
        `INSERT INTO site_build_stages (id, tenant_id, site_id, stage, scope, input_hash, output, model) VALUES ($1,$2,$3,'page_plan',$4,'studio',$5,'studio')`,
        [uuidv7(), state.site.tenantId, state.site.id, wp.page.slug, JSON.stringify({ composition: wp.composition, corrections: [] })]);
    }
  }
}

/** Every page rendered — for a release, and for the inspector. */
export function renderAll(state: WorkingState): Array<{ slug: string; path: string; html: string }> {
  return state.pages.filter((p) => p.status !== "hidden").map((p) => ({ slug: p.page.slug, path: p.page.slug === "home" ? "index.html" : `${p.page.slug}/index.html`, html: renderWorkingPage(state, p.page.slug, { withScript: true }) }));
}

/** Bytes for the images a rendered page references, for the inspector's
 *  offline render (the router serves them from the release in production). */
export async function siteAssets(storage: StorageAdapter, state: WorkingState): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const image of state.images) {
    try { out[`/images/${image.key}.png`] = await storage.get(image.storageKey); } catch { /* the page shows alt text */ }
  }
  return out;
}
