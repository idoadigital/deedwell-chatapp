import type { PoolClient } from "pg";
import { audit, enqueueWebhookEvent, uuidv7, type StorageAdapter } from "@deedwell/database";
import { SitePage, SiteTheme, type StyleOverride } from "@deedwell/schemas";
import { blockingFailures, runSiteChecks, type SiteCheck } from "../checks.js";
import { pageContentHash } from "../design.js";
import type { SiteImage } from "../images.js";
import { pageUrl, renderSite } from "../renderer.js";
import { capHeaderNav, ensureNavCoverage, normalizeInternalLinks } from "../sanitize.js";
import type { PageComposition } from "../builder/index.js";

/**
 * A release is the site's version: an immutable file set in storage plus a
 * snapshot of the working state that produced it. The build workflow, the
 * editor, the QA repairer and a restore all make releases through here, so
 * every version in the history has the same shape and can be restored.
 */

export type ReleaseKind = "build" | "edit" | "qa_repair" | "restore" | "content";

export interface AssembleArgs {
  client: PoolClient;
  storage: StorageAdapter;
  tenantId: string;
  siteId: string;
  runId?: string | null;
  kind: ReleaseKind;
  label?: string | null;
  createdBy?: string | null;
  createdByKind?: "user" | "agent" | "system";
  /** Site-wide logo bytes, when Brand Style has one. */
  logo?: { bytes: Buffer; ext: string } | null;
  facts?: Record<string, string>;
}

export interface AssembledRelease {
  releaseId: string;
  version: number;
  prefix: string;
  checks: SiteCheck[];
  failures: SiteCheck[];
  blocking: SiteCheck[];
  designedCount: number;
  pages: SitePage[];
  siteName: string;
  slug: string;
}

export async function loadFacts(client: PoolClient, tenantId: string): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT fact_key, value, status FROM org_facts WHERE tenant_id = $1 AND status <> 'rejected' ORDER BY (status IN ('verified','user_certified')) DESC", [tenantId]);
  const out: Record<string, string> = {};
  for (const r of rows) if (!(r.fact_key in out)) out[r.fact_key] = String(typeof r.value === "string" ? r.value : JSON.stringify(r.value)).replace(/^"|"$/g, "");
  return out;
}

export async function assembleRelease(args: AssembleArgs): Promise<AssembledRelease> {
  const { client, storage, siteId, tenantId } = args;
  const { rows: sites } = await client.query("SELECT id, slug, name, theme, images, edits FROM sites WHERE id = $1", [siteId]);
  const site = sites[0];
  if (!site) throw new Error("Site not found");
  const { rows: pageRows } = await client.query("SELECT slug, title, blocks, seo, status, rendered_html, rendered_hash FROM site_pages WHERE site_id = $1 ORDER BY order_idx", [siteId]);
  const visible = pageRows.filter((r) => r.status !== "hidden");
  if (!visible.length) throw new Error("Site has no pages to build");
  const pages = visible.map((r) => SitePage.parse({ slug: r.slug, title: r.title, blocks: r.blocks, seoDescription: r.seo?.description ?? "" }));
  // A site must have a root page: the first page stands in for "home".
  const rowSlugToPage = new Map<string, SitePage>(visible.map((r, i) => [r.slug as string, pages[i]!]));
  if (!pages.some((p) => p.slug === "home") && pages[0]) pages[0].slug = "home";
  const theme = SiteTheme.parse(site.theme);
  const facts = args.facts ?? await loadFacts(client, tenantId);
  const { rows: intakeRows } = await client.query("SELECT question_key, value FROM site_intake_answers WHERE site_id = $1", [siteId]);
  const intake = Object.fromEntries(intakeRows.map((r) => [r.question_key, r.value]));
  const contactEmail = typeof intake.site_contact_email === "string" ? intake.site_contact_email : null;

  const files = renderSite({
    siteName: site.name, slug: site.slug, pages, theme, registration: facts.registration_status ?? null, contactEmail,
    logoPath: args.logo ? `/images/logo.${args.logo.ext}` : null,
  });
  // Designed pages replace the template's rendering wherever the design
  // still matches the copy it was made from.
  let designedCount = 0;
  for (const r of visible) {
    if (!r.rendered_html || !r.rendered_hash) continue;
    const page = rowSlugToPage.get(r.slug as string);
    if (!page || String(r.rendered_hash).split(":")[0] !== pageContentHash(page)) continue;
    const file = files.find((f) => f.path === (page.slug === "home" ? "index.html" : `${page.slug}/index.html`));
    if (!file) continue;
    file.content = ensureNavCoverage(
      capHeaderNav(normalizeInternalLinks(r.rendered_html, [...pages.map((p) => pageUrl(p.slug)), "/thanks/"])),
      pages.map((p) => ({ title: p.title, href: pageUrl(p.slug) }))
    );
    designedCount += 1;
  }
  const checks = runSiteChecks(files, pages, { mission: facts.mission ?? null, ein: facts.ein ?? null, status: facts.entity_type ?? facts.registration_status ?? null });

  const { rows: versionRow } = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM site_releases WHERE site_id = $1", [siteId]);
  const version = Number(versionRow[0].next);
  const prefix = `tenants/${tenantId}/sites/${siteId}/releases/v${version}`;
  for (const file of files) await storage.put(`${prefix}/${file.path}`, Buffer.from(file.content, "utf8"));
  if (args.logo) {
    try { await storage.put(`${prefix}/images/logo.${args.logo.ext}`, args.logo.bytes); }
    catch (err) { console.log(JSON.stringify({ at: "site_logo_copy_failed", error: String((err as Error).message ?? err).slice(0, 160) })); }
  }
  const siteImages: SiteImage[] = Array.isArray(site.images) ? site.images : [];
  for (const image of siteImages) {
    try { await storage.put(`${prefix}/images/${image.key}.png`, await storage.get(image.storageKey)); }
    catch (err) { console.log(JSON.stringify({ at: "site_image_copy_failed", key: image.key, error: String((err as Error).message ?? err).slice(0, 160) })); }
  }

  // The snapshot carries everything a restore needs to put the working
  // state back: copy, per-page plans, tokens, overrides, page visibility.
  const { rows: plans } = await client.query("SELECT scope, output FROM site_build_stages WHERE site_id = $1 AND stage = 'page_plan'", [siteId]);
  const compositions: Record<string, PageComposition> = {};
  for (const p of plans) { const c = (p.output as { composition?: PageComposition })?.composition; if (c) compositions[p.scope] = c; }
  const overrides: StyleOverride[] = Array.isArray((site.edits as { overrides?: StyleOverride[] })?.overrides) ? (site.edits as { overrides: StyleOverride[] }).overrides : [];
  const releaseId = uuidv7();
  await client.query(
    `INSERT INTO site_releases (id, tenant_id, site_id, version, snapshot, storage_prefix, checks, run_id, kind, label, created_by, created_by_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [releaseId, tenantId, siteId, version,
      JSON.stringify({
        siteName: site.name, slug: site.slug, theme, pages, designedPages: designedCount,
        renderer: designedCount === pages.length ? "model" : designedCount ? "mixed" : "template",
        compositions, overrides, pageStatus: Object.fromEntries(pageRows.map((r) => [r.slug, r.status ?? "published"])),
      }),
      prefix, JSON.stringify(checks), args.runId ?? null, args.kind, args.label ?? null, args.createdBy ?? null, args.createdByKind ?? "system"]
  );
  await client.query(
    `UPDATE sites SET preview_release_id = $2, status = CASE WHEN status = 'published' THEN 'published' ELSE 'preview' END WHERE id = $1`,
    [siteId, releaseId]
  );
  const failures = checks.filter((c) => !c.pass);
  return { releaseId, version, prefix, checks, failures, blocking: blockingFailures(checks), designedCount, pages, siteName: site.name, slug: site.slug };
}

/** Puts a release's working state back and records a new "restore"
 *  release that serves the same immutable files. Nothing later is deleted. */
export async function restoreRelease(client: PoolClient, args: { storage: StorageAdapter; tenantId: string; siteId: string; releaseId: string; userId: string | null; label?: string; kind?: ReleaseKind }): Promise<{ releaseId: string; version: number }> {
  const { rows } = await client.query("SELECT id, version, snapshot, storage_prefix, checks FROM site_releases WHERE id = $1 AND site_id = $2", [args.releaseId, args.siteId]);
  const release = rows[0];
  if (!release) throw new Error("Release not found");
  const snap = release.snapshot as { pages?: SitePage[]; theme?: unknown; compositions?: Record<string, PageComposition>; overrides?: StyleOverride[]; pageStatus?: Record<string, string> };
  const pages = (snap.pages ?? []).map((p) => SitePage.parse(p));
  if (pages.length) {
    await client.query("DELETE FROM site_pages WHERE site_id = $1 AND NOT (slug = ANY($2))", [args.siteId, pages.map((p) => p.slug)]);
    for (const [idx, page] of pages.entries()) {
      // The page's rendering is the file in the release, read back so the
      // next build reuses it without a redesign.
      let html: string | null = null;
      try { html = (await args.storage.get(`${release.storage_prefix}/${page.slug === "home" ? "index.html" : `${page.slug}/index.html`}`)).toString("utf8"); } catch { html = null; }
      await client.query(
        `INSERT INTO site_pages (id, tenant_id, site_id, slug, title, order_idx, blocks, seo, status, rendered_html, rendered_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (site_id, slug) DO UPDATE SET title = EXCLUDED.title, order_idx = EXCLUDED.order_idx, blocks = EXCLUDED.blocks, seo = EXCLUDED.seo,
           status = EXCLUDED.status, rendered_html = COALESCE(EXCLUDED.rendered_html, site_pages.rendered_html), rendered_hash = COALESCE(EXCLUDED.rendered_hash, site_pages.rendered_hash)`,
        [uuidv7(), args.tenantId, args.siteId, page.slug, page.title, idx, JSON.stringify(page.blocks), JSON.stringify({ description: page.seoDescription }),
          snap.pageStatus?.[page.slug] === "hidden" ? "hidden" : "published", html, html ? `${pageContentHash(page)}:pipeline` : null]);
    }
  }
  if (snap.theme) await client.query("UPDATE sites SET theme = $2::jsonb WHERE id = $1", [args.siteId, JSON.stringify(snap.theme)]);
  await client.query("UPDATE sites SET edits = $2::jsonb WHERE id = $1", [args.siteId, JSON.stringify({ overrides: snap.overrides ?? [] })]);
  for (const [scope, composition] of Object.entries(snap.compositions ?? {})) {
    const existing = await client.query("SELECT id FROM site_build_stages WHERE site_id = $1 AND stage = 'page_plan' AND scope = $2", [args.siteId, scope]);
    if (existing.rows[0]) await client.query("UPDATE site_build_stages SET output = jsonb_set(COALESCE(output,'{}'::jsonb), '{composition}', $2::jsonb) WHERE id = $1", [existing.rows[0].id, JSON.stringify(composition)]);
    else await client.query("INSERT INTO site_build_stages (id, tenant_id, site_id, stage, scope, input_hash, output, model) VALUES ($1,$2,$3,'page_plan',$4,'studio',$5,'studio')", [uuidv7(), args.tenantId, args.siteId, scope, JSON.stringify({ composition, corrections: [] })]);
  }
  const { rows: v } = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM site_releases WHERE site_id = $1", [args.siteId]);
  const version = Number(v[0].next);
  const releaseId = uuidv7();
  await client.query(
    `INSERT INTO site_releases (id, tenant_id, site_id, version, snapshot, storage_prefix, checks, kind, label, created_by, created_by_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user')`,
    [releaseId, args.tenantId, args.siteId, version, JSON.stringify(release.snapshot), release.storage_prefix, JSON.stringify(release.checks ?? []),
      args.kind ?? "restore", args.label ?? `Restored version ${release.version}`, args.userId]);
  await client.query("UPDATE sites SET preview_release_id = $2 WHERE id = $1", [args.siteId, releaseId]);
  await audit(client, { tenantId: args.tenantId, actorUser: args.userId, action: "site.restored", entityType: "site_release", entityId: releaseId, metadata: { siteId: args.siteId, from: release.id, fromVersion: release.version } });
  return { releaseId, version };
}

/** Promotes the preview release to the live site. Same effect as approving
 *  the workflow's publish gate; the editor's Publish button lands here. */
export async function publishRelease(client: PoolClient, args: { tenantId: string; siteId: string; releaseId: string; userId: string | null }): Promise<void> {
  const { rows } = await client.query("SELECT id, status FROM site_releases WHERE id = $1 AND site_id = $2", [args.releaseId, args.siteId]);
  if (!rows[0]) throw new Error("Release not found");
  await client.query("UPDATE site_releases SET status = 'superseded' WHERE site_id = $1 AND status = 'published' AND id <> $2", [args.siteId, args.releaseId]);
  await client.query("UPDATE site_releases SET status = 'published', published_at = now(), approved_by = $2 WHERE id = $1", [args.releaseId, args.userId]);
  await client.query("UPDATE sites SET active_release_id = $2, status = 'published' WHERE id = $1", [args.siteId, args.releaseId]);
  await audit(client, { tenantId: args.tenantId, actorUser: args.userId, action: "site.published", entityType: "site_release", entityId: args.releaseId, metadata: { siteId: args.siteId, via: "studio" } });
  await enqueueWebhookEvent(client, "website.published", { orgId: args.tenantId, siteId: args.siteId, releaseId: args.releaseId });
}
