import { z } from "zod";
import { audit, enqueueWebhookEvent, uuidv7, type StorageAdapter } from "@deedwell/database";
import { runAgentTask, type ModelProvider } from "@deedwell/agent-runtime";
import type { ToolGateway } from "@deedwell/tools";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import {
  SitePage,
  SiteTheme,
  type OrgFact,
  type SitePageOutput,
  type SitePatchOutput,
  type WebsiteBriefOutput,
} from "@deedwell/schemas";
import { digitalStrategist, websiteCopywriter, websiteDeveloper } from "./agents.js";
import { pageUrl, renderSite } from "./renderer.js";
import { blockingFailures, runSiteChecks } from "./checks.js";
import {
  INTAKE_SKIP_KEY,
  WEBSITE_DIRECTION_KEYS,
  WEBSITE_ESSENTIAL_FACTS,
} from "./intake.js";
import { findPlaceholders, stripPlaceholderBlocks } from "./placeholders.js";
import { assemblePage, designPageMain, designSystem, pageContentHash, type Organization, type SiteDesignSystem } from "./design.js";
import { generateSiteImages, planSiteImages, type SiteImage } from "./images.js";
import { createHash } from "node:crypto";
import { capHeaderNav, ensureNavCoverage, normalizeInternalLinks } from "./sanitize.js";
import {
  ensureRequiredSections,
  loadReferenceTemplate,
  loadSiteGenerationSettings,
  pickReferenceTemplate,
  siteGenerationDataBlocks,
} from "./site-generation.js";

export const WEBSITE_BUILD_WORKFLOW = "website-build";
export const WEBSITE_UPDATE_WORKFLOW = "website-update";

export interface WebsiteServices {
  provider: ModelProvider;
  gateway: ToolGateway;
  storage: StorageAdapter;
  /** Designs pages from the reference; absent → the shared provider. */
  designer?: ModelProvider;
  /** Image generation for site photography; absent → sites have no images. */
  images?: () => Promise<import("@deedwell/content-domain").ImageGenerator>;
}

type Ctx = StepContext<WebsiteServices>;

const BuildInput = z.object({
  siteId: z.string().uuid(),
  siteName: z.string(),
  donateUrl: z.string().nullable(),
});
const UpdateInput = z.object({ siteId: z.string().uuid(), instruction: z.string() });

async function fetchFacts(ctx: Ctx, agent: typeof websiteCopywriter): Promise<OrgFact[]> {
  const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
    ctx.client,
    { tenantId: ctx.tenantId, userId: null, agentKey: agent.agentKey, runId: ctx.runId },
    agent,
    "fetch_org_facts",
    {}
  );
  return facts;
}

async function recordModelUsage(ctx: Ctx, agentKey: string, tokens: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,$3,'model_tokens',$4,$5)`,
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey, source: "workflow" })]
  );
}

async function getSite(ctx: Ctx, siteId: string) {
  const { rows } = await ctx.client.query(
    "SELECT id, slug, name, theme, status, active_release_id, images FROM sites WHERE id = $1",
    [siteId]
  );
  if (!rows[0]) throw new Error(`Site ${siteId} not found in tenant scope`);
  return rows[0] as {
    id: string; slug: string; name: string; theme: Record<string, unknown>;
    status: string; active_release_id: string | null; images: SiteImage[];
  };
}

/** A site must have a root page: if no page is slugged "home", the first
 *  page becomes it — deterministic, applied on both read and write so page
 *  sets written before this rule self-heal. */
function normalizeHome(pages: SitePage[]): SitePage[] {
  return pages.some((p) => p.slug === "home")
    ? pages
    : pages.map((p, i) => (i === 0 ? { ...p, slug: "home" } : p));
}

async function loadPages(ctx: Ctx, siteId: string): Promise<SitePage[]> {
  const { rows } = await ctx.client.query(
    "SELECT slug, title, blocks, seo FROM site_pages WHERE site_id = $1 ORDER BY order_idx",
    [siteId]
  );
  const pages = rows.map((r) =>
    SitePage.parse({
      slug: r.slug,
      title: r.title,
      blocks: r.blocks,
      seoDescription: r.seo?.description ?? "",
    })
  );
  return normalizeHome(pages);
}

/** Replace the site's page set (the CMS working copy) with `pages`. */
async function replacePages(ctx: Ctx, siteId: string, rawPages: SitePage[]): Promise<void> {
  const pages = normalizeHome(rawPages);
  const keep = pages.map((p) => p.slug);
  await ctx.client.query(
    "DELETE FROM site_pages WHERE site_id = $1 AND NOT (slug = ANY($2))",
    [siteId, keep]
  );
  for (const [idx, page] of pages.entries()) {
    await ctx.client.query(
      `INSERT INTO site_pages (id, tenant_id, site_id, slug, title, order_idx, blocks, seo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id, slug) DO UPDATE SET
         title = EXCLUDED.title, order_idx = EXCLUDED.order_idx,
         blocks = EXCLUDED.blocks, seo = EXCLUDED.seo`,
      [uuidv7(), ctx.tenantId, siteId, page.slug, page.title, idx,
       JSON.stringify(page.blocks), JSON.stringify({ description: page.seoDescription })]
    );
  }
}

/**
 * A timeline row linking straight to the built preview. The path is relative —
 * the workflow has no business knowing the public base URL, and the client
 * already knows where the site router lives.
 */
async function recordReleaseEvent(
  ctx: Ctx, slug: string, version: number, failed: number, blocking: number,
): Promise<void> {
  const eventType = `release:v${version}`;
  const { rows } = await ctx.client.query(
    "SELECT 1 FROM workspace_events WHERE run_id = $1 AND event_type = $2",
    [ctx.runId, eventType]
  );
  if (rows[0]) return;
  const summary = blocking
    ? `Built, but ${blocking} blocking check${blocking === 1 ? "" : "s"} must be fixed before it can go live. The preview shows the current state.`
    : failed
      ? `Built with ${failed} advisory check${failed === 1 ? "" : "s"} to review.`
      : "All checks passed. Review it and approve to publish.";
  await ctx.client.query(
    `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
       status, agent_key, metadata, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'website.qa_deployment',$9,now())`,
    [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId, eventType,
     `Preview v${version} is ready`, summary, blocking ? "blocked" : "completed",
     JSON.stringify({ previewPath: `/preview/${slug}/`, version })]
  );
}

/** Design answers recorded for this site, as a plain key -> value map. */
async function loadIntake(ctx: Ctx, siteId: string): Promise<Record<string, unknown>> {
  const { rows } = await ctx.client.query(
    "SELECT question_key, value FROM site_intake_answers WHERE site_id = $1",
    [siteId]
  );
  return Object.fromEntries(rows.map((r) => [r.question_key as string, r.value]));
}

/** Upsert a single page without disturbing the others. */
async function upsertPage(ctx: Ctx, siteId: string, page: SitePage, orderIdx: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO site_pages (id, tenant_id, site_id, slug, title, order_idx, blocks, seo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (site_id, slug) DO UPDATE SET
       title = EXCLUDED.title, order_idx = EXCLUDED.order_idx,
       blocks = EXCLUDED.blocks, seo = EXCLUDED.seo`,
    [uuidv7(), ctx.tenantId, siteId, page.slug, page.title, orderIdx,
     JSON.stringify(page.blocks), JSON.stringify({ description: page.seoDescription })]
  );
}

/**
 * One timeline row per page, so a build reads as visible progress rather than
 * a single spinner. Guarded on event_type because a step retry re-runs the
 * whole body — storage and model calls are not transactional, so the only
 * safe assumption is that anything here may happen twice.
 */
async function recordPageEvent(ctx: Ctx, slug: string, title: string): Promise<void> {
  const eventType = `page:${slug}`;
  const { rows } = await ctx.client.query(
    "SELECT 1 FROM workspace_events WHERE run_id = $1 AND event_type = $2",
    [ctx.runId, eventType]
  );
  if (rows[0]) return;
  await ctx.client.query(
    `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
       status, agent_key, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'completed','website.copywriter',now())`,
    [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId, eventType,
     `Wrote the ${title} page`,
     "Drafted from the approved brief and your certified facts."]
  );
}

async function loadDesignedPages(ctx: Ctx, siteId: string): Promise<Map<string, { html: string; hash: string }>> {
  const { rows } = await ctx.client.query(
    "SELECT slug, rendered_html, rendered_hash FROM site_pages WHERE site_id = $1 AND rendered_html IS NOT NULL",
    [siteId]
  );
  return new Map(rows.map((r) => [r.slug as string, { html: r.rendered_html as string, hash: r.rendered_hash as string }]));
}

async function recordDesignEvent(ctx: Ctx, slug: string, title: string, ok: boolean, detail: string): Promise<void> {
  const eventType = `design:${slug}`;
  const { rows } = await ctx.client.query(
    "SELECT 1 FROM workspace_events WHERE run_id = $1 AND event_type = $2",
    [ctx.runId, eventType]
  );
  if (rows[0]) return;
  await ctx.client.query(
    `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
       status, agent_key, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'completed','website.designer',now())`,
    [uuidv7(), ctx.tenantId, ctx.projectId, ctx.runId, eventType,
     ok ? `Designed the ${title} page` : `Could not design the ${title} page`, detail]
  );
}

/** Write one page's copy from its plan: model call, the placeholder
 *  backstop, storage, and the timeline event. Safe to run concurrently. */
async function writePage(ctx: Ctx, args: {
  input: z.infer<typeof BuildInput>;
  brief: WebsiteBriefOutput | undefined;
  plan: WebsiteBriefOutput["sitemap"][number];
  slug: string;
  orderIdx: number;
  facts: OrgFact[];
  reference: Awaited<ReturnType<typeof loadReferenceTemplate>>;
}): Promise<{ placeholders: string[] }> {
  const { input, brief, plan, slug, orderIdx, facts, reference } = args;
  const blocksFor = (extra: { label: string; content: string }[] = []) => [
    { label: "org_facts", content: JSON.stringify(facts) },
    { label: "intake", content: JSON.stringify({ siteName: input.siteName, donateUrl: input.donateUrl }) },
    { label: "intake_preferences", content: JSON.stringify(ctx.state.intake ?? {}) },
    { label: "brief", content: JSON.stringify(brief ?? {}) },
    { label: "page_plan", content: JSON.stringify({ ...plan, slug }) },
    ...extra,
    ...siteGenerationDataBlocks({ requiredSections: [], guidance: "" }, reference),
  ];
  const result = await runAgentTask<SitePageOutput>(
    ctx.services.provider, websiteCopywriter,
    `Write the "${plan.title}" page. Write only this page.`,
    blocksFor()
  );
  await recordModelUsage(ctx, websiteCopywriter.agentKey, result.tokensEstimated);

  // Markers in the page are a broken page. One corrective pass names what
  // was wrong; whatever still carries a marker after that is dropped.
  let output = result.output;
  let markers = findPlaceholders(SitePage.parse({ ...output.page, slug }));
  if (markers.length) {
    const retry = await runAgentTask<SitePageOutput>(
      ctx.services.provider, websiteCopywriter,
      `Write the "${plan.title}" page. Write only this page.`,
      blocksFor([{ label: "revision_note", content:
        `Your previous draft of this page contained placeholder markers: ${markers.join("; ")}. ` +
        "Remove every block or field that needs a fact you do not have, and list those facts in \"placeholders\" instead. No marker may remain." }])
    );
    await recordModelUsage(ctx, websiteCopywriter.agentKey, retry.tokensEstimated);
    output = retry.output;
    markers = findPlaceholders(SitePage.parse({ ...output.page, slug }));
  }
  let page = SitePage.parse({ ...output.page, slug });
  let reportedGaps = output.placeholders;
  if (markers.length) {
    const stripped = stripPlaceholderBlocks(page, plan);
    page = SitePage.parse(stripped.page);
    reportedGaps = [...new Set([...reportedGaps, ...markers.map((m) => m.replace(/^\[\s*placeholder:?\s*/i, "").replace(/\]$/, "").trim())])];
    await audit(ctx.client, {
      tenantId: ctx.tenantId, actorAgent: websiteCopywriter.agentKey,
      action: "site.placeholder_blocks_removed", entityType: "site", entityId: input.siteId,
      metadata: { page: slug, removed: stripped.removed, markers },
    });
  }
  await upsertPage(ctx, input.siteId, page, orderIdx);
  await recordPageEvent(ctx, slug, plan.title);
  if (reportedGaps.length) {
    await audit(ctx.client, {
      tenantId: ctx.tenantId, actorAgent: websiteCopywriter.agentKey,
      action: "site.placeholders_flagged", entityType: "site", entityId: input.siteId,
      metadata: { page: slug, placeholders: reportedGaps },
    });
  }
  return { placeholders: reportedGaps.map((g) => `${plan.title}: ${g}`) };
}

/**
 * Photography for the site, generated once per build in the reference's
 * style and kept on the site row. Absent image service → no images, and the
 * designer works without them. A failed image is left out, never faked.
 */
async function makeSiteImages(
  ctx: Ctx, siteId: string, siteName: string, brief: WebsiteBriefOutput | null,
  sitemap: Array<{ slug: string; title: string }>, facts: OrgFact[],
  reference: Awaited<ReturnType<typeof loadReferenceTemplate>>
): Promise<void> {
  if (!ctx.services.images) return;
  const fact = (key: string) => facts.find((f) => f.key === key)?.value ?? null;
  try {
    const generator = await ctx.services.images();
    const plan = planSiteImages({
      brief, pages: sitemap.map((p, i) => ({ slug: i === 0 ? "home" : p.slug, title: p.title })),
      org: {
        siteName, mission: fact("mission"), beneficiaries: fact("beneficiaries"),
        programs: fact("programs"), serviceArea: fact("service_area"),
        referenceStyle: reference ? `${reference.title}. ${reference.description}`.trim() : null,
      },
    });
    const images = await generateSiteImages({
      generator, plan, storage: ctx.services.storage, tenantId: ctx.tenantId, siteId,
      onError: (item, err) => console.log(JSON.stringify({ at: "site_image_failed", key: item.key, error: String((err as Error).message ?? err).slice(0, 200) })),
    });
    await ctx.client.query("UPDATE sites SET images = $2 WHERE id = $1", [siteId, JSON.stringify(images)]);
  } catch (err) {
    console.log(JSON.stringify({ at: "site_images_skipped", error: String((err as Error).message ?? err).slice(0, 200) }));
  }
}

/**
 * The design step, shared by the build and update workflows. Two phases:
 * first the site's design system from the reference (once), then every
 * page concurrently on that system. A page whose copy, images and system
 * are unchanged keeps its rendering. Anything that fails falls back to the
 * template with an event saying why, so a build always completes.
 */
async function designNextPage(ctx: Ctx, siteId: string, after: string): Promise<StepResult> {
  const site = await getSite(ctx, siteId);
  const pages = await loadPages(ctx, siteId);
  const phase = (ctx.state.designPhase as string | undefined) ?? "system";
  if (phase === "done") return { state: ctx.state, next: after };

  const settings = await loadSiteGenerationSettings(ctx.client);
  const referenceId = (ctx.state.referenceTemplate as { id?: string } | null | undefined)?.id
    ?? (await ctx.client.query("SELECT reference_template_id FROM sites WHERE id = $1", [siteId])).rows[0]?.reference_template_id
    ?? null;
  const reference = await loadReferenceTemplate(ctx.client, ctx.services.storage, referenceId);
  const facts = await fetchFacts(ctx, websiteCopywriter);
  const fact = (key: string) => facts.find((f) => f.key === key)?.value ?? null;
  const intake = await loadIntake(ctx, siteId);
  const brief = (ctx.state.brief as WebsiteBriefOutput | undefined) ?? null;
  const donateUrl = typeof intake.site_donate_url === "string" ? intake.site_donate_url
    : (BuildInput.safeParse(ctx.state.input).data?.donateUrl ?? null);
  const status = fact("entity_type") ?? fact("registration_status");
  const organization: Organization = {
    name: site.name,
    legalName: fact("legal_name"),
    mission: fact("mission"),
    headquarters: fact("headquarters"),
    status: status ? (/nonprofit|non-profit|charity/i.test(status) ? status : `${status} nonprofit`) : null,
    ein: fact("ein"),
    contactEmail: typeof intake.site_contact_email === "string" ? intake.site_contact_email : (fact("contact_email") ?? fact("email")),
    contactPhone: fact("phone") ?? fact("contact_phone"),
  };
  const nav = pages.map((p) => ({ title: p.title, href: pageUrl(p.slug) }));
  const images = Array.isArray(site.images) ? site.images : [];
  const common = {
    provider: ctx.services.designer ?? ctx.services.provider,
    site: { name: site.name, slug: site.slug }, nav, brief, reference,
    guidance: settings.guidance, organization, donateUrl, images,
  };

  if (phase === "system") {
    try {
      const { system, tokensEstimated } = await designSystem(common);
      await recordModelUsage(ctx, "website.designer", tokensEstimated);
      await recordDesignEvent(ctx, "system", "design system", true,
        reference ? `Styled after the reference design "${reference.title}".` : "Styled from the brief.");
      return { state: { ...ctx.state, designPhase: "pages", designSystem: system }, next: "design_pages" };
    } catch (err) {
      await recordDesignEvent(ctx, "system", "design system", false,
        `The designer's style guide could not be used (${String((err as Error).message ?? err).slice(0, 160)}); the standard layout is used for this build.`);
      return { state: { ...ctx.state, designPhase: "done", designSystem: null }, next: after };
    }
  }

  const system = ctx.state.designSystem as SiteDesignSystem | null;
  if (!system) return { state: { ...ctx.state, designPhase: "done" }, next: after };
  const systemHash = createHash("sha256").update(system.styles + system.header + system.footer).digest("hex");
  const existing = await loadDesignedPages(ctx, siteId);

  await Promise.all(pages.map(async (page) => {
    // Content hash first, so the release can match on the copy alone; the
    // system and image parts decide whether a re-design is needed.
    const hash = `${pageContentHash(page)}:${systemHash}:${createHash("sha256").update(images.map((i) => i.path).join(",")).digest("hex")}`;
    const current = existing.get(page.slug);
    if (current && current.hash === hash) return;
    try {
      const { main, tokensEstimated } = await designPageMain({ ...common, page, system });
      await recordModelUsage(ctx, "website.designer", tokensEstimated);
      const html = assemblePage({ site: common.site, page, nav, system, main, organization });
      await ctx.client.query(
        "UPDATE site_pages SET rendered_html = $3, rendered_hash = $4 WHERE site_id = $1 AND slug = $2",
        [siteId, page.slug, html, hash]
      );
      await recordDesignEvent(ctx, page.slug, page.title, true, "Composed on the site's design system.");
    } catch (err) {
      await ctx.client.query(
        "UPDATE site_pages SET rendered_html = NULL, rendered_hash = NULL WHERE site_id = $1 AND slug = $2",
        [siteId, page.slug]
      );
      await recordDesignEvent(ctx, page.slug, page.title, false,
        `The designer's page could not be used (${String((err as Error).message ?? err).slice(0, 160)}); the standard layout is used for it.`);
    }
  }));
  return { state: { ...ctx.state, designPhase: "done" }, next: after };
}

// ---------------------------------------------------------------------------
// Shared steps: build a release from the CMS working copy, then gate publish.
// ---------------------------------------------------------------------------

async function buildRelease(ctx: Ctx, siteId: string): Promise<StepResult> {
  const site = await getSite(ctx, siteId);
  const pages = await loadPages(ctx, siteId);
  if (!pages.length) throw new Error("Site has no pages to build");
  const theme = SiteTheme.parse(site.theme);

  // Registration status and a real contact address are the two things a grant
  // reviewer checks first, so they belong in the footer of every page.
  const facts = await fetchFacts(ctx, websiteCopywriter);
  const registration =
    facts.find((f) => f.key === "registration_status"
      && (f.status === "verified" || f.status === "user_certified"))?.value ?? null;
  // The public contact address is a site choice, not an organizational fact —
  // it lives with the rest of the design intake.
  const intake = await loadIntake(ctx, siteId);
  const contactEmail = typeof intake.site_contact_email === "string" ? intake.site_contact_email : null;
  const files = renderSite({
    siteName: site.name, slug: site.slug, pages, theme, registration, contactEmail,
  });
  // Designed pages replace the template's rendering wherever the design
  // still matches the copy it was made from.
  const designed = await loadDesignedPages(ctx, siteId);
  let designedCount = 0;
  for (const page of pages) {
    const d = designed.get(page.slug);
    if (!d || d.hash.split(":")[0] !== pageContentHash(page)) continue;
    const file = files.find((f) => f.path === (page.slug === "home" ? "index.html" : `${page.slug}/index.html`));
    // Renderings made before link normalisation existed are fixed here too.
    if (file) {
      file.content = ensureNavCoverage(
        capHeaderNav(normalizeInternalLinks(d.html, [...pages.map((p) => pageUrl(p.slug)), "/thanks/"])),
        pages.map((p) => ({ title: p.title, href: pageUrl(p.slug) }))
      );
      designedCount += 1;
    }
  }
  const checkFacts = (key: string) => facts.find((f) => f.key === key)?.value ?? null;
  const checks = runSiteChecks(files, pages, {
    mission: checkFacts("mission"),
    ein: checkFacts("ein"),
    status: checkFacts("entity_type") ?? checkFacts("registration_status"),
  });

  const { rows: versionRow } = await ctx.client.query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM site_releases WHERE site_id = $1",
    [siteId]
  );
  const version = Number(versionRow[0].next);
  const prefix = `tenants/${ctx.tenantId}/sites/${siteId}/releases/v${version}`;
  for (const file of files) {
    await ctx.services.storage.put(`${prefix}/${file.path}`, Buffer.from(file.content, "utf8"));
  }

  // The site's generated photography travels with every release.
  const siteImages = Array.isArray(site.images) ? site.images : [];
  for (const image of siteImages) {
    try {
      const bytes = await ctx.services.storage.get(image.storageKey);
      await ctx.services.storage.put(`${prefix}/images/${image.key}.png`, bytes);
    } catch (err) {
      console.log(JSON.stringify({ at: "site_image_copy_failed", key: image.key, error: String((err as Error).message ?? err).slice(0, 160) }));
    }
  }

  const releaseId = uuidv7();
  await ctx.client.query(
    `INSERT INTO site_releases (id, tenant_id, site_id, version, snapshot, storage_prefix, checks, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [releaseId, ctx.tenantId, siteId, version,
     JSON.stringify({ siteName: site.name, slug: site.slug, theme, pages, designedPages: designedCount, renderer: designedCount === pages.length ? "model" : designedCount ? "mixed" : "template" }),
     prefix, JSON.stringify(checks), ctx.runId]
  );
  await ctx.client.query(
    `UPDATE sites SET preview_release_id = $2,
       status = CASE WHEN status = 'published' THEN 'published' ELSE 'preview' END
     WHERE id = $1`,
    [siteId, releaseId]
  );

  const failures = checks.filter((c) => !c.pass);
  const blocking = blockingFailures(checks);
  const describe = (f: (typeof checks)[number]) => `${f.name}${f.page ? ` (${f.page})` : ""}: ${f.detail}`;

  // Versioned test report artifact (spec §8/§10): the QA record of exactly
  // what was validated on this release, kept alongside every other artifact.
  const { rows: existingReport } = await ctx.client.query(
    "SELECT id, current_version FROM artifacts WHERE run_id = $1 AND type = 'website_test_report'",
    [ctx.runId]
  );
  const reportId = existingReport[0]?.id ?? uuidv7();
  const reportVersion = (existingReport[0]?.current_version ?? 0) + 1;
  if (!existingReport[0]) {
    await ctx.client.query(
      `INSERT INTO artifacts (id, tenant_id, project_id, run_id, type, title, current_version)
       VALUES ($1,$2,$3,$4,'website_test_report',$5,0)`,
      [reportId, ctx.tenantId, ctx.projectId, ctx.runId, `Site test report — ${site.name}`]
    );
  }
  await ctx.client.query(
    `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content,
       created_by_kind, created_by_agent, change_summary)
     VALUES ($1,$2,$3,$4,$5,'agent','website.qa_deployment',$6)`,
    [uuidv7(), ctx.tenantId, reportId, reportVersion, JSON.stringify({
      releaseId, version, checks, designedPages: designedCount, totalPages: pages.length,
      passed: checks.length - failures.length, failed: failures.length, blocking: blocking.length,
    }), `v${version}: ${checks.length - failures.length}/${checks.length} checks passed, ${blocking.length} blocking failure(s), ${designedCount}/${pages.length} pages designed from the reference`]
  );
  await ctx.client.query("UPDATE artifacts SET current_version = $2 WHERE id = $1", [reportId, reportVersion]);

  if (blocking.length) {
    // A broken site must never reach the publish gate (spec §8). The preview
    // stays inspectable; the run ends with the honest failure list.
    await audit(ctx.client, {
      tenantId: ctx.tenantId, actorAgent: "website.qa_deployment",
      action: "site.release_failed_validation", entityType: "site_release", entityId: releaseId,
      metadata: { version, blocking: blocking.length, failedChecks: failures.length },
    });
    // The preview exists even though it failed validation, and the whole point
    // of a preview is to look at what is wrong. Emit the link before returning.
    await recordReleaseEvent(ctx, site.slug, version, failures.length, blocking.length);
    return {
      state: {
        ...ctx.state, releaseId, version, published: false,
        failedChecks: failures.length,
        blockingChecks: blocking.map(describe),
        testReportArtifactId: reportId,
        previewPath: `/preview/${site.slug}/`,
      },
      complete: true,
    };
  }

  const approvalId = uuidv7();
  await ctx.client.query(
    `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'publish_site',$4)`,
    [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
      siteId, releaseId, version,
      previewPath: `/preview/${site.slug}/`,
      warnings: failures.map(describe),
      testReportArtifactId: reportId,
    })]
  );
  await audit(ctx.client, {
    tenantId: ctx.tenantId, actorAgent: "website.qa_deployment",
    action: "site.release_built", entityType: "site_release", entityId: releaseId,
    metadata: { version, failedChecks: failures.length },
  });
  await recordReleaseEvent(ctx, site.slug, version, failures.length, 0);
  return {
    state: { ...ctx.state, releaseId, version, failedChecks: failures.length, testReportArtifactId: reportId },
    wait: { kind: "approval", payload: { approvalId, kind: "publish_site" }, resumeStep: "publish_gate" },
  };
}

async function publishGate(ctx: Ctx, siteId: string): Promise<StepResult> {
  const { rows } = await ctx.client.query(
    `SELECT id, status, decided_by FROM approvals
     WHERE run_id = $1 AND kind = 'publish_site' ORDER BY created_at DESC LIMIT 1`,
    [ctx.runId]
  );
  const approval = rows[0];
  if (!approval || approval.status === "pending") {
    return {
      state: ctx.state,
      wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "publish_gate" },
    };
  }
  if (approval.status === "rejected") {
    // Site stays in preview; the user iterates via conversational updates.
    return { state: { ...ctx.state, published: false }, complete: true };
  }
  const releaseId = z.string().uuid().parse(ctx.state.releaseId);
  await ctx.client.query(
    `UPDATE site_releases SET status = 'superseded'
     WHERE site_id = $1 AND status = 'published' AND id <> $2`,
    [siteId, releaseId]
  );
  await ctx.client.query(
    `UPDATE site_releases SET status = 'published', published_at = now(), approved_by = $2
     WHERE id = $1`,
    [releaseId, approval.decided_by]
  );
  await ctx.client.query(
    "UPDATE sites SET active_release_id = $2, status = 'published' WHERE id = $1",
    [siteId, releaseId]
  );
  await audit(ctx.client, {
    tenantId: ctx.tenantId, actorUser: approval.decided_by,
    actorAgent: "website.qa_deployment", action: "site.published",
    entityType: "site_release", entityId: releaseId, metadata: { siteId },
  });
  // Thin payload by design: a webhook payload is a pointer, not the full
  // resource — GET /v1/public/websites/:siteId has the current, authoritative
  // shape. Subscriptions are platform-wide, so orgId travels in the payload.
  await enqueueWebhookEvent(ctx.client, "website.published", { orgId: ctx.tenantId, siteId, releaseId });
  return { state: { ...ctx.state, published: true }, complete: true };
}

// ---------------------------------------------------------------------------

export function buildWebsiteBuildWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_BUILD_WORKFLOW,
    version: 3,
    // Budget accounts for the conversational intake and per-page generation:
    // discovery may re-enter up to 4 times, each gate costs a step per
    // re-entry, and generate_content now runs once per page. steps_used
    // increments on every execution including resumes, so waits are not free.
    initialStep: "discovery",
    stepBudget: 60,
    steps: {
      // Stage 1 (spec §5): confirm what we know, ask only for what's missing.
      // No page is generated until the essentials exist and the brief is approved.
      //
      // Two rounds. First the organizational facts the site cannot be written
      // without — those are hard requirements. Then the design choices, which
      // are all optional: the team asks, but never blocks on them.
      async discovery(ctx): Promise<StepResult> {
        const input = BuildInput.parse(ctx.state.input);
        const facts = await fetchFacts(ctx, digitalStrategist);
        const usable = new Set(
          facts.filter((f) => f.status === "verified" || f.status === "user_certified").map((f) => f.key)
        );
        const missing = WEBSITE_ESSENTIAL_FACTS.filter((k) => !usable.has(k));
        if (missing.length) {
          return {
            state: { ...ctx.state, missingFacts: missing },
            wait: {
              kind: "info",
              payload: { missingFacts: missing, context: "website_discovery", stage: "essentials" },
              resumeStep: "discovery",
            },
          };
        }

        // Re-read the durable answers rather than trusting the resume signal:
        // engine.signal() truncates its payload to a string, so a signal says
        // that something arrived, not what.
        const intake = await loadIntake(ctx, input.siteId);
        const answered = new Set(Object.keys(intake));
        const outstanding = WEBSITE_DIRECTION_KEYS.filter((k) => !answered.has(k));
        const rounds = typeof ctx.state.intakeRounds === "number" ? ctx.state.intakeRounds : 0;

        // Three exits, so an optional round can never park the run forever:
        // the user handed it to the team, there is nothing left to ask, or
        // they have been asked enough and we get on with it.
        const skipped = intake[INTAKE_SKIP_KEY] === true;
        if (skipped || !outstanding.length || rounds >= 3) {
          return { state: { ...ctx.state, intake }, next: "intake_brief" };
        }

        return {
          state: { ...ctx.state, intake, intakeRounds: rounds + 1 },
          wait: {
            // Deliberately tiny: summarize() truncates this to 800 characters,
            // so the questions themselves are recomputed from the catalog at
            // read time instead of travelling here.
            kind: "info",
            payload: { context: "website_intake", stage: "direction", siteId: input.siteId },
            resumeStep: "discovery",
          },
        };
      },

      async intake_brief(ctx): Promise<StepResult> {
        const input = BuildInput.parse(ctx.state.input);
        const facts = await fetchFacts(ctx, digitalStrategist);
        // Platform-wide direction from Site Generation Settings: the sections
        // grant approval demands, and one reference design drawn at random
        // from the library so consecutive sites do not all look alike.
        const settings = await loadSiteGenerationSettings(ctx.client);
        const reference = await pickReferenceTemplate(ctx.client, ctx.services.storage);
        const result = await runAgentTask<WebsiteBriefOutput>(
          ctx.services.provider, digitalStrategist,
          "Produce a website brief for this organization.",
          [
            { label: "org_facts", content: JSON.stringify(facts) },
            { label: "intake", content: JSON.stringify({
              siteName: input.siteName,
              // An explicit answer beats the value captured when the site was
              // created — the user has seen the question since.
              donateUrl: (ctx.state.intake as Record<string, unknown> | undefined)?.site_donate_url
                ?? input.donateUrl,
            }) },
            { label: "intake_preferences", content: JSON.stringify(ctx.state.intake ?? {}) },
            ...siteGenerationDataBlocks(settings, reference),
          ]
        );
        await recordModelUsage(ctx, digitalStrategist.agentKey, result.tokensEstimated);
        // The prompt asks; this guarantees. A required section the model
        // skipped becomes its own page before anyone approves the brief.
        const brief: WebsiteBriefOutput = {
          ...result.output,
          sitemap: ensureRequiredSections(result.output.sitemap, settings.requiredSections),
        };
        await ctx.client.query(
          "UPDATE sites SET theme = $2, reference_template_id = $3 WHERE id = $1",
          [input.siteId, JSON.stringify(brief.theme), reference?.id ?? null]
        );
        // Artifact for the workspace panel (versioned like everything else).
        const { rows: existing } = await ctx.client.query(
          "SELECT id, current_version FROM artifacts WHERE run_id = $1 AND type = 'website_brief'",
          [ctx.runId]
        );
        const artifactId = existing[0]?.id ?? uuidv7();
        const version = (existing[0]?.current_version ?? 0) + 1;
        if (!existing[0]) {
          await ctx.client.query(
            `INSERT INTO artifacts (id, tenant_id, project_id, run_id, type, title, current_version)
             VALUES ($1,$2,$3,$4,'website_brief',$5,0)`,
            [artifactId, ctx.tenantId, ctx.projectId, ctx.runId, `Website brief — ${input.siteName}`]
          );
        }
        await ctx.client.query(
          `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content,
             created_by_kind, created_by_agent, change_summary)
           VALUES ($1,$2,$3,$4,$5,'agent',$6,$7)`,
          [uuidv7(), ctx.tenantId, artifactId, version, JSON.stringify(brief),
           digitalStrategist.agentKey, `Brief with ${brief.sitemap.length}-page sitemap`]
        );
        await ctx.client.query("UPDATE artifacts SET current_version = $2 WHERE id = $1", [artifactId, version]);
        // Stage 2 (spec §5): the brief must be approved before any build starts.
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'website_brief',$4)`,
          [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
            artifactId,
            siteId: input.siteId,
            siteName: input.siteName,
            objectives: brief.objectives,
            audiences: brief.audiences,
            tone: brief.tone,
            theme: brief.theme,
            sitemap: brief.sitemap,
            referenceTemplate: reference ? { id: reference.id, title: reference.title } : null,
          })]
        );
        return {
          state: {
            ...ctx.state, brief, briefArtifactId: artifactId,
            referenceTemplate: reference ? { id: reference.id, title: reference.title } : null,
          },
          wait: { kind: "approval", payload: { approvalId, kind: "website_brief" }, resumeStep: "brief_gate" },
        };
      },

      async brief_gate(ctx): Promise<StepResult> {
        const { rows } = await ctx.client.query(
          `SELECT id, status FROM approvals WHERE run_id = $1 AND kind = 'website_brief'
           ORDER BY created_at DESC LIMIT 1`,
          [ctx.runId]
        );
        const approval = rows[0];
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "brief_gate" },
          };
        }
        if (approval.status === "rejected") {
          // Honest stop: the user shapes the brief conversationally and re-asks.
          return { state: { ...ctx.state, briefRejected: true }, complete: true };
        }
        return { state: ctx.state, next: "generate_content" };
      },

      /**
       * One page per step, cursored through the approved sitemap.
       *
       * A step body and everything it writes commit in a single transaction,
       * so a single call that returns six pages is invisible until the whole
       * thing finishes — the user watches a spinner and has no idea whether
       * anything is happening. Writing one page per step means one commit,
       * one run_updated event, and one line of visible progress each time.
       */
      async generate_content(ctx): Promise<StepResult> {
        const input = BuildInput.parse(ctx.state.input);
        const brief = ctx.state.brief as WebsiteBriefOutput | undefined;
        const sitemap = (brief?.sitemap ?? []).slice(0, 10);
        if (!sitemap.length) {
          // Nothing approved to write. Honest stop rather than inventing a site.
          return { state: { ...ctx.state, placeholders: [] }, complete: true };
        }

        // The delete sweep runs against the planned slug set before anything
        // is written, so pages dropped from the brief go away.
        const planned = normalizeHome(
          sitemap.map((entry) => ({ slug: entry.slug, title: entry.title, blocks: [], seoDescription: "" })) as SitePage[]
        ).map((p) => p.slug);
        await ctx.client.query(
          "DELETE FROM site_pages WHERE site_id = $1 AND NOT (slug = ANY($2))",
          [input.siteId, planned]
        );

        // Every page at once: they are independent of each other, and ten
        // sequential model calls was most of the wait.
        const facts = await fetchFacts(ctx, websiteCopywriter);
        const referenceId = (ctx.state.referenceTemplate as { id?: string } | null | undefined)?.id ?? null;
        const reference = await loadReferenceTemplate(ctx.client, ctx.services.storage, referenceId);
        const [results] = await Promise.all([
          Promise.all(sitemap.map((plan, i) =>
            writePage(ctx, { input, brief, plan, slug: i === 0 ? "home" : plan.slug, orderIdx: i, facts, reference })
          )),
          makeSiteImages(ctx, input.siteId, input.siteName, brief ?? null, sitemap, facts, reference),
        ]);
        const placeholders = [
          ...((ctx.state.placeholders as string[] | undefined) ?? []),
          ...results.flatMap((r) => r.placeholders),
        ];
        return {
          state: { ...ctx.state, cursor: sitemap.length, placeholders, designPhase: "system", designSystem: null },
          next: "design_pages",
        };
      },

      /**
       * One page per step, like the writing: the designer sees the reference
       * image and the finished copy and hands back the page's HTML. The home
       * page goes first and its styles, header and footer become the shared
       * design every later page must reuse. A page the designer cannot
       * produce falls back to the template at build time, with an event
       * saying so, rather than stopping the build.
       */
      async design_pages(ctx): Promise<StepResult> {
        return designNextPage(ctx, BuildInput.parse(ctx.state.input).siteId, "build_release");
      },

      async build_release(ctx): Promise<StepResult> {
        return buildRelease(ctx, BuildInput.parse(ctx.state.input).siteId);
      },
      async publish_gate(ctx): Promise<StepResult> {
        return publishGate(ctx, BuildInput.parse(ctx.state.input).siteId);
      },
    },
  };
}

export function buildWebsiteUpdateWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_UPDATE_WORKFLOW,
    version: 1,
    initialStep: "apply_patch",
    stepBudget: 40,
    steps: {
      async apply_patch(ctx): Promise<StepResult> {
        const input = UpdateInput.parse(ctx.state.input);
        const pages = await loadPages(ctx, input.siteId);
        const result = await runAgentTask<SitePatchOutput>(
          ctx.services.provider, websiteDeveloper,
          "Translate the user's change request into a patch against the structured page model.",
          [
            { label: "pages", content: JSON.stringify(pages) },
            { label: "instruction", content: input.instruction },
          ]
        );
        await recordModelUsage(ctx, websiteDeveloper.agentKey, result.tokensEstimated);
        if (!result.output.applied) {
          // Honest failure surface — no fake success (BRD §15.3).
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
            action: "site.update_not_understood", entityType: "site", entityId: input.siteId,
            metadata: { instruction: input.instruction, reason: result.output.reason },
          });
          return {
            state: { ...ctx.state, applied: false, reason: result.output.reason },
            complete: true,
          };
        }
        // Destructive-output guard: a patch that silently drops pages the
        // user never asked to remove must not delete them — small models
        // sometimes return only the page they edited. Removals are honored
        // only when the instruction actually asks for one.
        const wantsRemoval = /\b(remove|delete|drop|take (down|off))\b/i.test(input.instruction);
        const returnedSlugs = new Set(result.output.pages.map((p) => p.slug));
        const preserved = wantsRemoval ? [] : pages.filter((p) => !returnedSlugs.has(p.slug));
        const mergedPages = [...result.output.pages, ...preserved];
        if (preserved.length) {
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
            action: "site.patch_pages_preserved", entityType: "site", entityId: input.siteId,
            metadata: { preserved: preserved.map((p) => p.slug), instruction: input.instruction },
          });
        }
        await replacePages(ctx, input.siteId, mergedPages);
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
          action: "site.pages_updated", entityType: "site", entityId: input.siteId,
          metadata: { changeSummary: result.output.changeSummary },
        });
        return {
          state: { ...ctx.state, applied: true, changeSummary: result.output.changeSummary },
          next: "design_pages",
        };
      },
      /** Re-design only the pages the patch changed; the rest keep their
       *  rendering, so an edit does not cost a full redesign. */
      async design_pages(ctx): Promise<StepResult> {
        return designNextPage(ctx, UpdateInput.parse(ctx.state.input).siteId, "build_release");
      },
      async build_release(ctx): Promise<StepResult> {
        return buildRelease(ctx, UpdateInput.parse(ctx.state.input).siteId);
      },
      async publish_gate(ctx): Promise<StepResult> {
        return publishGate(ctx, UpdateInput.parse(ctx.state.input).siteId);
      },
    },
  };
}
