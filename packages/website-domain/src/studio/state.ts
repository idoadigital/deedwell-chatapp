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

export interface WorkingPage { page: SitePage; status: "published" | "hidden"; orderIdx: number; composition: PageComposition }

export interface WorkingState {
  site: { id: string; slug: string; name: string; tenantId: string };
  pages: WorkingPage[];
  language: DesignLanguage;
  tokens: DesignTokens;
  overrides: StyleOverride[];
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
  const logoPath = logo ? (await (async () => {
    const id = String(logo.value ?? "").replace(/^"|"$/g, "");
    const f = (await client.query("SELECT mime FROM files WHERE id = $1", [id]).catch(() => ({ rows: [] as Array<{ mime: string }> }))).rows[0];
    const ext = f?.mime === "image/png" ? "png" : f?.mime === "image/jpeg" ? "jpg" : f?.mime === "image/webp" ? "webp" : null;
    return ext ? `/images/logo.${ext}` : null;
  })()) : null;
  const organization = await loadOrganization(client, site.tenant_id, site, intake, logoPath);
  const donations = (site.donations ?? {}) as { donateUrl?: string | null };
  const donateUrl = str(donations.donateUrl) ?? str(intake.site_donate_url);

  const languageParsed = theme.language && typeof theme.language === "object" ? (theme.language as DesignLanguage) : null;
  const language = languageParsed ?? DEFAULT_LANGUAGE;
  const tokensParsed = DesignTokens.safeParse(theme.tokens);
  const tokens = tokensParsed.success ? tokensParsed.data : fallbackTokens(language, { primaryColor: str(intake.site_brand_primary_color) });
  const images: SiteImage[] = Array.isArray(site.images) ? site.images : [];
  const overrides: StyleOverride[] = Array.isArray((site.edits as { overrides?: unknown })?.overrides) ? (site.edits as { overrides: StyleOverride[] }).overrides : [];

  const { rows: pageRows } = await client.query("SELECT slug, title, blocks, seo, order_idx, status FROM site_pages WHERE site_id = $1 ORDER BY order_idx", [siteId]);
  const { rows: plans } = await client.query("SELECT scope, output FROM site_build_stages WHERE site_id = $1 AND stage = 'page_plan'", [siteId]);
  const planFor = new Map<string, unknown>(plans.map((p) => [p.scope, (p.output as { composition?: unknown })?.composition ?? p.output]));
  const pages: WorkingPage[] = pageRows.map((r, i) => {
    const page = SitePage.parse({ slug: r.slug, title: r.title, blocks: r.blocks, seoDescription: r.seo?.description ?? "" });
    const composition = normalizeComposition(planFor.get(r.slug) ?? null, { page, images, donateUrl, language });
    return { page, status: r.status === "hidden" ? "hidden" : "published", orderIdx: r.order_idx ?? i, composition };
  });
  if (!pages.some((p) => p.page.slug === "home") && pages[0]) pages[0].page = { ...pages[0].page, slug: "home" };
  return { site: { id: site.id, slug: site.slug, name: site.name, tenantId: site.tenant_id }, pages, language, tokens, overrides, images, organization, donateUrl, native: tokensParsed.success };
}

export function navOf(state: WorkingState): Array<{ title: string; href: string }> {
  return state.pages.filter((p) => p.status !== "hidden").map((p) => ({ title: p.page.title, href: p.page.slug === "home" ? "/" : `/${p.page.slug}/` }));
}

/** One page, rendered from the working state. Deterministic. */
export function renderWorkingPage(state: WorkingState, slug: string, opts: { withScript?: boolean } = {}): string {
  const wp = state.pages.find((p) => p.page.slug === slug);
  if (!wp) throw new Error(`No page "${slug}"`);
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

  for (const op of ops) {
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

// ---- persistence -------------------------------------------------------------

/** Writes the working state back. Pages that changed get their new
 *  rendering and hash; the plans keep their memo key so the next full
 *  build reuses the edited composition instead of re-planning it. */
export async function saveWorkingState(client: PoolClient, state: WorkingState, changed: Iterable<string>): Promise<void> {
  const slugs = new Set(changed);
  await client.query("UPDATE sites SET theme = theme || $2::jsonb, edits = $3::jsonb WHERE id = $1",
    [state.site.id, JSON.stringify({ tokens: state.tokens, language: state.language }), JSON.stringify({ overrides: state.overrides })]);
  for (const [i, wp] of state.pages.entries()) {
    const html = slugs.has(wp.page.slug) ? renderWorkingPage(state, wp.page.slug) : null;
    await client.query(
      `UPDATE site_pages SET title = $3, blocks = $4, seo = seo || $5::jsonb, order_idx = $6,
              rendered_html = COALESCE($7, rendered_html), rendered_hash = COALESCE($8, rendered_hash)
        WHERE site_id = $1 AND slug = $2`,
      [state.site.id, wp.page.slug, wp.page.title, JSON.stringify(wp.page.blocks), JSON.stringify({ description: wp.page.seoDescription }), i,
        html, html ? `${pageContentHash(wp.page)}:pipeline` : null]);
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
