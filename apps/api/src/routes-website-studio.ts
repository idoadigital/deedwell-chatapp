import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, uuidv7, withContext } from "@deedwell/database";
import {
  SiteBlock, SiteDomainInput, SiteDonationsInput, SiteEditorMessageInput, SiteEventInput, SiteMediaInput, SitePage, SitePageStatusInput, SitePostInput, SiteQaStartInput,
} from "@deedwell/schemas";
import {
  WEBSITE_EDIT_WORKFLOW, WEBSITE_QA_WORKFLOW, assembleRelease, createJob, instructionsFor, loadJob, loadSiteLogoFrom, loadWorkingState, newVerificationToken, nextStatus, normalizeComposition, observeDns, patchDesignedCopy, probeHttps, publishRelease, restoreRelease, saveWorkingState, siteUrls,
} from "@deedwell/website-domain";
import { HttpError, type AppContext } from "./app.js";
import { requireTokens } from "./billing-gate.js";
import { transcribeClip } from "./transcribe.js";

/**
 * The website studio: the AI editor's conversation and jobs, versions
 * (undo / restore / publish), QA runs and findings, structured content
 * (pages, blog, events, donations) and custom domains — all on the
 * existing sites model. Long work goes through the workflow engine; these
 * routes start it and read its state.
 */

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "post";

export function registerWebsiteStudioRoutes(app: FastifyInstance, ctx: AppContext): void {
  const base = "/v1/orgs/:orgId/sites/:siteId";
  const siteOf = async (req: FastifyRequest, client: import("pg").PoolClient) => {
    const { siteId } = req.params as { siteId: string };
    const { rows } = await client.query(
      `SELECT s.*, (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version,
              (SELECT version FROM site_releases r WHERE r.id = s.active_release_id) AS live_version
         FROM sites s WHERE s.id = $1`, [siteId]);
    if (!rows[0]) throw new HttpError(404, "Site not found");
    return rows[0];
  };
  /** A run that is actually working. A build parked at its publish gate is
   *  not: iterating on the preview in the editor is exactly what that gate
   *  waits for, and publishing later takes the current preview. */
  const activeRun = async (client: import("pg").PoolClient, projectId: string) => {
    const { rows } = await client.query(
      `SELECT r.id, r.status, r.definition FROM workflow_runs r
        WHERE r.project_id = $1 AND r.definition LIKE 'website%'
          AND r.status IN ('pending','running','waiting_for_info','waiting_approval')
          AND NOT (r.status = 'waiting_approval' AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.kind = 'publish_site' AND a.status = 'pending'))
        ORDER BY r.created_at DESC LIMIT 1`, [projectId]);
    return (rows[0] as { id: string; status: string; definition: string } | undefined) ?? null;
  };

  // ---- studio overview ------------------------------------------------------
  app.get(`${base}/studio`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const pages = await client.query("SELECT slug, title, status, order_idx, updated_at, jsonb_array_length(blocks) AS blocks FROM site_pages WHERE site_id = $1 ORDER BY order_idx", [site.id]);
      const jobs = await client.query("SELECT DISTINCT ON (kind) id, kind, status, summary, error, steps, result, created_at, finished_at, release_after FROM site_jobs WHERE site_id = $1 ORDER BY kind, created_at DESC", [site.id]);
      const run = await activeRun(client, site.project_id);
      const versions = await client.query("SELECT count(*)::int AS n FROM site_releases WHERE site_id = $1", [site.id]);
      const domains = await client.query("SELECT id, domain, status FROM site_domains WHERE site_id = $1 ORDER BY created_at", [site.id]);
      const counts = await client.query("SELECT (SELECT count(*)::int FROM site_posts WHERE site_id = $1) AS posts, (SELECT count(*)::int FROM site_events WHERE site_id = $1) AS events, (SELECT count(*)::int FROM site_qa_findings f WHERE f.site_id = $1 AND f.job_id = $2 AND f.status = 'needs_review') AS open_findings", [site.id, site.qa_job_id]);
      const { theme, ...rest } = site; void theme;
      return {
        site: { ...rest, editable: Boolean((site.theme as { tokens?: unknown })?.tokens) || true, ...siteUrls(site as never) },
        pages: pages.rows, jobs: Object.fromEntries(jobs.rows.map((j) => [j.kind, j])), activeRun: run, versions: versions.rows[0].n, domains: domains.rows, counts: counts.rows[0],
      };
    });
  });

  // ---- the editor ------------------------------------------------------------
  app.get(`${base}/editor/messages`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const messages = await client.query("SELECT m.id, m.role, m.body, m.context, m.job_id, m.created_at, u.display_name AS author FROM site_edit_messages m LEFT JOIN users u ON u.id = m.created_by WHERE m.site_id = $1 ORDER BY m.created_at DESC LIMIT 120", [site.id]);
      const active = await client.query("SELECT * FROM site_jobs WHERE site_id = $1 AND kind = 'edit' AND status NOT IN ('complete','failed') ORDER BY created_at DESC LIMIT 1", [site.id]);
      const last = await client.query("SELECT id, status, result, release_before, release_after, created_at FROM site_jobs WHERE site_id = $1 AND kind = 'edit' AND status = 'complete' AND release_after IS NOT NULL AND (result->>'undone') IS NULL ORDER BY created_at DESC LIMIT 1", [site.id]);
      return { messages: messages.rows.reverse(), activeJob: active.rows[0] ?? null, undoable: last.rows[0] ? { jobId: last.rows[0].id, title: last.rows[0].result?.plan?.title ?? "last change" } : null };
    });
  });

  app.post(`${base}/editor/messages`, async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const input = SiteEditorMessageInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight) throw new HttpError(409, inFlight.definition === WEBSITE_EDIT_WORKFLOW ? "Deedwell is still working on the previous change." : `A website ${inFlight.definition.replace("website-", "")} is running for this site; try again when it finishes.`);
      const messageId = uuidv7();
      const jobId = await createJob(client, { tenantId: req.orgId!, siteId: site.id, kind: "edit", instruction: input.body, context: input.context, createdBy: req.userId, releaseBefore: site.preview_release_id });
      await client.query("INSERT INTO site_edit_messages (id, tenant_id, site_id, job_id, role, body, context, created_by) VALUES ($1,$2,$3,$4,'user',$5,$6,$7)",
        [messageId, req.orgId, site.id, jobId, input.body, JSON.stringify(input.context), req.userId]);
      const runId = await ctx.deps.engine.start(client, { tenantId: req.orgId!, projectId: site.project_id, definition: WEBSITE_EDIT_WORKFLOW, createdBy: req.userId!, input: { siteId: site.id, jobId } });
      await client.query("UPDATE site_jobs SET run_id = $2 WHERE id = $1", [jobId, runId]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.edit_requested", entityType: "site", entityId: site.id, metadata: { jobId, runId, instruction: input.body.slice(0, 200), context: input.context } });
      return { messageId, jobId, runId };
    });
    return reply.status(202).send(result);
  });

  app.get(`${base}/jobs`, async (req) => {
    ctx.requireRole(req, "viewer");
    const q = (req.query ?? {}) as { kind?: string; limit?: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT id, kind, status, instruction, summary, error, steps, result, release_before, release_after, created_at, finished_at FROM site_jobs WHERE site_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC LIMIT $3", [site.id, q.kind ?? null, Math.min(Number(q.limit) || 20, 100)]);
      return { jobs: rows };
    });
  });

  app.get(`${base}/jobs/:jobId`, async (req) => {
    ctx.requireRole(req, "viewer");
    const { jobId } = req.params as { jobId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const job = await loadJob(client, jobId);
      if (!job || job.site_id !== site.id) throw new HttpError(404, "Job not found");
      const findings = job.kind === "qa" ? (await client.query("SELECT id, severity, category, page, viewport, title, description, evidence, status, repair, attempts, created_at, updated_at FROM site_qa_findings WHERE job_id = $1 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at", [jobId])).rows : [];
      return { job, findings };
    });
  });

  // ---- versions: undo, history, restore, publish -----------------------------
  app.post(`${base}/undo`, async (req) => {
    ctx.requireRole(req, "member");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight) throw new HttpError(409, "Wait for the current change to finish before undoing.");
      const { rows } = await client.query("SELECT id, release_before, result FROM site_jobs WHERE site_id = $1 AND kind = 'edit' AND status = 'complete' AND release_after IS NOT NULL AND (result->>'undone') IS NULL ORDER BY created_at DESC LIMIT 1", [site.id]);
      const job = rows[0];
      if (!job?.release_before) throw new HttpError(409, "There is no change to undo.");
      const restored = await restoreRelease(client, { storage: ctx.deps.storage, tenantId: req.orgId!, siteId: site.id, releaseId: job.release_before, userId: req.userId, label: `Undid: ${job.result?.plan?.title ?? "last change"}` });
      await client.query("UPDATE site_jobs SET result = result || '{\"undone\": true}'::jsonb WHERE id = $1", [job.id]);
      await client.query("INSERT INTO site_edit_messages (id, tenant_id, site_id, job_id, role, body, context, created_by) VALUES ($1,$2,$3,$4,'assistant',$5,$6,$7)",
        [uuidv7(), req.orgId, site.id, job.id, `Undone — I put the previous version back (now version ${restored.version}).`, JSON.stringify({ undo: true, releaseId: restored.releaseId }), null]);
      return { ok: true, ...restored };
    });
  });

  app.get(`${base}/versions`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query(
        `SELECT r.id, r.version, r.status, r.kind, r.label, r.created_by_kind, r.published_at, r.created_at, u.display_name AS created_by_name,
                (r.id = s.preview_release_id) AS is_preview, (r.id = s.active_release_id) AS is_live,
                jsonb_array_length(COALESCE(r.checks, '[]'::jsonb)) AS checks
           FROM site_releases r JOIN sites s ON s.id = r.site_id LEFT JOIN users u ON u.id = r.created_by
          WHERE r.site_id = $1 ORDER BY r.version DESC LIMIT 200`, [site.id]);
      return { versions: rows.map((r) => ({ ...r, label: r.label ?? (r.kind === "build" ? (r.version === 1 ? "Initial website generated" : "Website rebuilt") : r.kind), actor: r.created_by_kind === "agent" ? `AI${r.created_by_name ? ` + ${r.created_by_name}` : ""}` : r.created_by_name ?? "Deedwell" })) };
    });
  });

  app.post(`${base}/versions/:releaseId/restore`, async (req) => {
    ctx.requireRole(req, "member");
    const { releaseId } = req.params as { releaseId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight) throw new HttpError(409, "Wait for the current work to finish before restoring a version.");
      return { ok: true, ...(await restoreRelease(client, { storage: ctx.deps.storage, tenantId: req.orgId!, siteId: site.id, releaseId, userId: req.userId })) };
    });
  });

  app.post(`${base}/publish`, async (req) => {
    ctx.requireRole(req, "admin");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      if (!site.preview_release_id) throw new HttpError(409, "There is no preview to publish yet.");
      if (site.preview_release_id === site.active_release_id) return { ok: true, unchanged: true };
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight && inFlight.definition !== "website-build") throw new HttpError(409, "Wait for the current change to finish before publishing.");
      // A build parked at its publish gate is answered here too, so the run
      // does not stay waiting on an approval nobody will see.
      const pending = await client.query("SELECT id, run_id FROM approvals WHERE tenant_id = $1 AND kind = 'publish_site' AND status = 'pending' AND payload->>'siteId' = $2", [req.orgId, site.id]);
      if (pending.rows[0]) {
        // The parked build resumes through its own gate, which publishes the
        // current preview — the same thing, recorded once.
        const a = pending.rows[0];
        await client.query("UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now(), note = 'Published from the website studio' WHERE id = $1", [a.id, req.userId]);
        try { await ctx.deps.engine.signal(client, a.run_id, "approval", { approvalId: a.id, decision: "approved" }); }
        catch (err) { req.log.warn({ err, runId: a.run_id }, "publish approved but the build run could not be resumed"); }
        for (const extra of pending.rows.slice(1)) await client.query("UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now(), note = 'Superseded by the studio publish' WHERE id = $1", [extra.id, req.userId]);
      }
      await publishRelease(client, { tenantId: req.orgId!, siteId: site.id, releaseId: site.preview_release_id, userId: req.userId! });
      return { ok: true, releaseId: site.preview_release_id };
    });
  });

  app.post(`${base}/archive`, async (req) => {
    ctx.requireRole(req, "admin");
    const { archived } = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      await client.query("UPDATE sites SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [site.id, archived]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: archived ? "site.archived" : "site.unarchived", entityType: "site", entityId: site.id, metadata: {} });
      return { ok: true };
    });
  });

  // ---- QA -----------------------------------------------------------------------
  app.post(`${base}/qa`, async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const input = SiteQaStartInput.parse(req.body ?? {});
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      if (!site.preview_release_id) throw new HttpError(409, "Generate the website before running QA.");
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight) throw new HttpError(409, `A website ${inFlight.definition.replace("website-", "")} is already running for this site.`);
      const jobId = await createJob(client, { tenantId: req.orgId!, siteId: site.id, kind: "qa", instruction: input.instruction ?? null, context: { scope: input.instruction ? "instruction" : "full" }, createdBy: req.userId, releaseBefore: site.preview_release_id });
      const runId = await ctx.deps.engine.start(client, { tenantId: req.orgId!, projectId: site.project_id, definition: WEBSITE_QA_WORKFLOW, createdBy: req.userId!, input: { siteId: site.id, jobId } });
      await client.query("UPDATE site_jobs SET run_id = $2 WHERE id = $1", [jobId, runId]);
      await client.query("UPDATE sites SET qa_status = 'running', qa_job_id = $2 WHERE id = $1", [site.id, jobId]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.qa_requested", entityType: "site", entityId: site.id, metadata: { jobId, runId, instruction: input.instruction ?? null } });
      return { jobId, runId };
    });
    return reply.status(202).send(result);
  });

  app.get(`${base}/qa`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows: jobs } = await client.query("SELECT id, status, instruction, summary, error, steps, result, release_after, created_at, finished_at FROM site_jobs WHERE site_id = $1 AND kind = 'qa' ORDER BY created_at DESC LIMIT 10", [site.id]);
      const latest = jobs[0] ?? null;
      const findings = latest ? (await client.query("SELECT id, severity, category, page, viewport, title, description, evidence, status, repair, attempts, created_at FROM site_qa_findings WHERE job_id = $1 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at", [latest.id])).rows : [];
      return { qaStatus: site.qa_status, lastQaAt: site.last_qa_at, latest, findings, history: jobs.slice(1) };
    });
  });

  // "Fix it" on a finding: the AI editor takes exactly that finding as its
  // request — page, viewport and evidence included — and the finding is
  // settled from the edit job's outcome.
  app.post(`${base}/qa/findings/:findingId/fix`, async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const { findingId } = req.params as { findingId: string };
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT id, severity, category, page, viewport, title, description, evidence, status, attempts FROM site_qa_findings WHERE id = $1 AND site_id = $2", [findingId, site.id]);
      const finding = rows[0];
      if (!finding) throw new HttpError(404, "Finding not found");
      if (finding.status === "repairing") throw new HttpError(409, "This finding is already being fixed.");
      const inFlight = await activeRun(client, site.project_id);
      if (inFlight) throw new HttpError(409, inFlight.definition === WEBSITE_EDIT_WORKFLOW ? "Deedwell is still working on the previous change." : `A website ${inFlight.definition.replace("website-", "")} is running for this site; try again when it finishes.`);
      const vp = finding.viewport == null ? "desktop" : finding.viewport <= 480 ? "mobile" : finding.viewport <= 1024 ? "tablet" : "desktop";
      const body = `Fix this QA finding: ${finding.title}. ${finding.description}`.slice(0, 2000);
      const context = { page: finding.page ?? "home", viewport: vp, findingId: finding.id, finding: { title: finding.title, description: finding.description, category: finding.category, severity: finding.severity, page: finding.page, viewport: finding.viewport, evidence: finding.evidence } };
      const messageId = uuidv7();
      const jobId = await createJob(client, { tenantId: req.orgId!, siteId: site.id, kind: "edit", instruction: body, context, createdBy: req.userId, releaseBefore: site.preview_release_id });
      await client.query("INSERT INTO site_edit_messages (id, tenant_id, site_id, job_id, role, body, context, created_by) VALUES ($1,$2,$3,$4,'user',$5,$6,$7)",
        [messageId, req.orgId, site.id, jobId, body, JSON.stringify(context), req.userId]);
      await client.query("UPDATE site_qa_findings SET status = 'repairing', repair = repair || $2::jsonb WHERE id = $1", [finding.id, JSON.stringify({ jobId, requestedBy: req.userId })]);
      const runId = await ctx.deps.engine.start(client, { tenantId: req.orgId!, projectId: site.project_id, definition: WEBSITE_EDIT_WORKFLOW, createdBy: req.userId!, input: { siteId: site.id, jobId } });
      await client.query("UPDATE site_jobs SET run_id = $2 WHERE id = $1", [jobId, runId]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.qa_fix_requested", entityType: "site", entityId: site.id, metadata: { findingId: finding.id, jobId, runId, title: finding.title } });
      return { jobId, runId, findingId: finding.id };
    });
    return reply.status(202).send(result);
  });

  app.get(`${base}/qa/:jobId/screenshots/:name`, async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { jobId, name } = req.params as { jobId: string; name: string };
    if (!/^[a-z0-9-]+-\d+$/.test(name)) throw new HttpError(404, "Unknown screenshot");
    const key = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const job = await loadJob(client, jobId);
      if (!job || job.site_id !== site.id) throw new HttpError(404, "Job not found");
      return (job.result as { screenshots?: Record<string, string> })?.screenshots?.[name] ?? null;
    });
    if (!key) throw new HttpError(404, "No screenshot");
    const bytes = await ctx.deps.storage.get(key);
    return reply.type("image/jpeg").header("cache-control", "private, max-age=3600").send(bytes);
  });

  // ---- media ---------------------------------------------------------------------
  // Featured images for posts and events. Stored with the site (not inside a
  // release) and served by the router at /media/<key>, so publishing a post
  // with a picture never rebuilds the website.
  const MEDIA_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  const MAX_MEDIA_BYTES = 8_000_000;
  app.post(`${base}/media`, async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = SiteMediaInput.parse(req.body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0) throw new HttpError(400, "The image is empty");
    if (content.length > MAX_MEDIA_BYTES) throw new HttpError(413, "Images are limited to 8 MB");
    const magic = content.subarray(0, 4).toString("hex");
    const looksLike = { "image/png": magic.startsWith("89504e47"), "image/jpeg": magic.startsWith("ffd8ff"), "image/webp": content.subarray(0, 4).toString() === "RIFF" && content.subarray(8, 12).toString() === "WEBP", "image/gif": content.subarray(0, 3).toString() === "GIF" }[input.mime];
    if (!looksLike) throw new HttpError(400, "That file is not the kind of image it claims to be");
    const key = `${uuidv7()}.${MEDIA_EXT[input.mime]}`;
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      await ctx.deps.storage.put(`tenants/${req.orgId}/sites/${site.id}/media/${key}`, content);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.media_uploaded", entityType: "site", entityId: site.id, metadata: { key, filename: input.filename, bytes: content.length } });
      const previewBase = siteUrls(site as never).preview_url?.replace(/\/$/, "") ?? null;
      return reply.status(201).send({ key, url: previewBase ? `${previewBase}/media/${key}` : null });
    });
  });

  // ---- pages -------------------------------------------------------------------
  app.patch(`${base}/pages/:slug`, async (req) => {
    ctx.requireRole(req, "member");
    const { slug } = req.params as { slug: string };
    const input = SitePageStatusInput.parse(req.body);
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      if (slug === "home" && input.status === "hidden") throw new HttpError(409, "The home page cannot be hidden.");
      const { rowCount } = await client.query("UPDATE site_pages SET status = $3 WHERE site_id = $1 AND slug = $2", [site.id, slug, input.status]);
      if (!rowCount) throw new HttpError(404, "Page not found");
      const logo = await loadSiteLogoFrom(client, ctx.deps.storage);
      const release = await assembleRelease({ client, storage: ctx.deps.storage, tenantId: req.orgId!, siteId: site.id, kind: "content", label: `${input.status === "hidden" ? "Hid" : "Restored"} the ${slug} page`, createdBy: req.userId, createdByKind: "user", logo });
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.page_status", entityType: "site", entityId: site.id, metadata: { slug, status: input.status, releaseId: release.releaseId } });
      return { ok: true, version: release.version };
    });
  });

  // ---- structured page content --------------------------------------------------
  // The copy blocks of every page, as the CMS sees them: programs, team,
  // FAQs, stats, partners and plain copy all live here. Editing a block
  // re-renders only its page (deterministically) into a new content release;
  // a page that keeps designed markup is read-only here and styled in the
  // AI editor instead.
  app.get(`${base}/content`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const state = await loadWorkingState(client, site.id);
      const { rows: meta } = await client.query("SELECT slug, updated_at FROM site_pages WHERE site_id = $1", [site.id]);
      const updated = new Map<string, unknown>(meta.map((r) => [r.slug, r.updated_at]));
      return {
        pages: state.pages.map((p) => ({ slug: p.page.slug, title: p.page.title, status: p.status, designed: Boolean(p.designedHtml), updatedAt: updated.get(p.page.slug) ?? null, blocks: p.page.blocks })),
      };
    });
  });
  app.put(`${base}/pages/:slug/blocks/:index`, async (req) => {
    ctx.requireRole(req, "member");
    const { slug, index } = req.params as { slug: string; index: string };
    const body = z.object({ block: z.unknown(), label: z.string().max(80).optional() }).parse(req.body);
    const at = Number(index);
    if (!Number.isInteger(at) || at < 0) throw new HttpError(400, "Bad block index");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const state = await loadWorkingState(client, site.id);
      const wp = state.pages.find((p) => p.page.slug === slug);
      const current = wp?.page.blocks[at];
      if (!wp || !current) throw new HttpError(404, "Block not found");
      const parsed = SiteBlock.safeParse(body.block);
      if (!parsed.success) throw new HttpError(400, `Invalid content: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      if (parsed.data.kind !== current.kind) throw new HttpError(400, "A section's type cannot change here.");
      if (wp.designedHtml) {
        // The design is kept: the wording is changed inside the page itself.
        const patched = patchDesignedCopy(wp.designedHtml, current, parsed.data);
        if ("error" in patched) throw new HttpError(409, patched.error);
        wp.designedHtml = patched.html;
      }
      wp.page.blocks[at] = parsed.data;
      const page = SitePage.safeParse(wp.page);
      if (!page.success) throw new HttpError(400, `Invalid page: ${page.error.issues[0]?.message}`);
      if (!wp.designedHtml) wp.composition = normalizeComposition(wp.composition, { page: wp.page, images: state.images, donateUrl: state.donateUrl, language: state.language });
      await saveWorkingState(client, state, [slug]);
      const logo = await loadSiteLogoFrom(client, ctx.deps.storage);
      const label = body.label ?? `${wp.page.title}: ${current.kind} content updated`;
      const release = await assembleRelease({ client, storage: ctx.deps.storage, tenantId: req.orgId!, siteId: site.id, kind: "content", label: label.slice(0, 80), createdBy: req.userId, createdByKind: "user", logo });
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.block_updated", entityType: "site", entityId: site.id, metadata: { slug, index: at, kind: current.kind, releaseId: release.releaseId } });
      return { ok: true, version: release.version, block: parsed.data };
    });
  });

  // ---- blog ---------------------------------------------------------------------
  const postView = (r: Record<string, unknown>) => ({ id: r.id, slug: r.slug, title: r.title, excerpt: r.excerpt, content: r.content, author: r.author, featuredImageKey: r.featured_image_key, status: r.status, publishedAt: r.published_at, seoTitle: r.seo_title, seoDescription: r.seo_description, createdAt: r.created_at, updatedAt: r.updated_at, authorName: r.author_name ?? null });
  app.get(`${base}/posts`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT p.*, u.display_name AS author_name FROM site_posts p LEFT JOIN users u ON u.id = p.created_by WHERE p.site_id = $1 ORDER BY COALESCE(p.published_at, p.created_at) DESC", [site.id]);
      return { posts: rows.map(postView) };
    });
  });
  app.post(`${base}/posts`, async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = SitePostInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const id = uuidv7();
      let slug = input.slug || slugify(input.title);
      const taken = await client.query("SELECT 1 FROM site_posts WHERE site_id = $1 AND slug = $2", [site.id, slug]);
      if (taken.rows[0]) slug = `${slug}-${id.slice(-4)}`;
      const status = input.status ?? "draft";
      const { rows } = await client.query(
        `INSERT INTO site_posts (id, tenant_id, site_id, slug, title, excerpt, content, author, featured_image_key, status, published_at, seo_title, seo_description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [id, req.orgId, site.id, slug, input.title, input.excerpt, input.content, input.author ?? null, input.featuredImageKey ?? null, status, input.publishedAt ?? (status === "published" ? new Date().toISOString() : null), input.seoTitle ?? null, input.seoDescription ?? null, req.userId]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.post_created", entityType: "site", entityId: site.id, metadata: { postId: id, slug, status } });
      return { post: postView(rows[0]) };
    });
    return reply.status(201).send(result);
  });
  app.get(`${base}/posts/:postId`, async (req) => {
    ctx.requireRole(req, "viewer");
    const { postId } = req.params as { postId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT * FROM site_posts WHERE id = $1 AND site_id = $2", [postId, site.id]);
      if (!rows[0]) throw new HttpError(404, "Post not found");
      return { post: postView(rows[0]) };
    });
  });
  app.patch(`${base}/posts/:postId`, async (req) => {
    ctx.requireRole(req, "member");
    const { postId } = req.params as { postId: string };
    const input = SitePostInput.partial().parse(req.body);
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows: cur } = await client.query("SELECT * FROM site_posts WHERE id = $1 AND site_id = $2", [postId, site.id]);
      if (!cur[0]) throw new HttpError(404, "Post not found");
      const c = cur[0];
      const status = input.status ?? c.status;
      const publishedAt = input.publishedAt !== undefined ? input.publishedAt : (status === "published" && !c.published_at ? new Date().toISOString() : c.published_at);
      const { rows } = await client.query(
        `UPDATE site_posts SET title = $3, slug = $4, excerpt = $5, content = $6, author = $7, featured_image_key = $8, status = $9, published_at = $10, seo_title = $11, seo_description = $12
          WHERE id = $1 AND site_id = $2 RETURNING *`,
        [postId, site.id, input.title ?? c.title, input.slug ?? c.slug, input.excerpt ?? c.excerpt, input.content ?? c.content, input.author !== undefined ? input.author : c.author, input.featuredImageKey !== undefined ? input.featuredImageKey : c.featured_image_key, status, publishedAt, input.seoTitle !== undefined ? input.seoTitle : c.seo_title, input.seoDescription !== undefined ? input.seoDescription : c.seo_description]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.post_updated", entityType: "site", entityId: site.id, metadata: { postId, status } });
      return { post: postView(rows[0]) };
    });
  });
  app.delete(`${base}/posts/:postId`, async (req) => {
    ctx.requireRole(req, "member");
    const { postId } = req.params as { postId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rowCount } = await client.query("DELETE FROM site_posts WHERE id = $1 AND site_id = $2", [postId, site.id]);
      if (!rowCount) throw new HttpError(404, "Post not found");
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.post_deleted", entityType: "site", entityId: site.id, metadata: { postId } });
      return { ok: true };
    });
  });

  // ---- events -------------------------------------------------------------------
  const eventView = (r: Record<string, unknown>) => ({ id: r.id, slug: r.slug, title: r.title, description: r.description, featuredImageKey: r.featured_image_key, startsAt: r.starts_at, endsAt: r.ends_at, location: r.location, mode: r.mode, registrationUrl: r.registration_url, ctaLabel: r.cta_label, organizer: r.organizer, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, upcoming: new Date(String(r.ends_at ?? r.starts_at)) >= new Date() });
  app.get(`${base}/events`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT * FROM site_events WHERE site_id = $1 ORDER BY starts_at DESC", [site.id]);
      return { events: rows.map(eventView) };
    });
  });
  app.post(`${base}/events`, async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = SiteEventInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const id = uuidv7();
      let slug = input.slug || slugify(input.title);
      if ((await client.query("SELECT 1 FROM site_events WHERE site_id = $1 AND slug = $2", [site.id, slug])).rows[0]) slug = `${slug}-${id.slice(-4)}`;
      const { rows } = await client.query(
        `INSERT INTO site_events (id, tenant_id, site_id, slug, title, description, featured_image_key, starts_at, ends_at, location, mode, registration_url, cta_label, organizer, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [id, req.orgId, site.id, slug, input.title, input.description, input.featuredImageKey ?? null, input.startsAt, input.endsAt ?? null, input.location ?? null, input.mode, input.registrationUrl ?? null, input.ctaLabel ?? null, input.organizer ?? null, input.status ?? "draft", req.userId]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.event_created", entityType: "site", entityId: site.id, metadata: { eventId: id, slug } });
      return { event: eventView(rows[0]) };
    });
    return reply.status(201).send(result);
  });
  app.patch(`${base}/events/:eventId`, async (req) => {
    ctx.requireRole(req, "member");
    const { eventId } = req.params as { eventId: string };
    const input = SiteEventInput.partial().parse(req.body);
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows: cur } = await client.query("SELECT * FROM site_events WHERE id = $1 AND site_id = $2", [eventId, site.id]);
      if (!cur[0]) throw new HttpError(404, "Event not found");
      const c = cur[0];
      const v = <K extends keyof typeof input>(k: K, col: string) => (input[k] !== undefined ? input[k] : c[col]);
      const { rows } = await client.query(
        `UPDATE site_events SET title = $3, slug = $4, description = $5, featured_image_key = $6, starts_at = $7, ends_at = $8, location = $9, mode = $10, registration_url = $11, cta_label = $12, organizer = $13, status = $14
          WHERE id = $1 AND site_id = $2 RETURNING *`,
        [eventId, site.id, v("title", "title"), v("slug", "slug"), v("description", "description"), v("featuredImageKey", "featured_image_key"), v("startsAt", "starts_at"), v("endsAt", "ends_at"), v("location", "location"), v("mode", "mode"), v("registrationUrl", "registration_url"), v("ctaLabel", "cta_label"), v("organizer", "organizer"), v("status", "status")]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.event_updated", entityType: "site", entityId: site.id, metadata: { eventId } });
      return { event: eventView(rows[0]) };
    });
  });
  app.delete(`${base}/events/:eventId`, async (req) => {
    ctx.requireRole(req, "member");
    const { eventId } = req.params as { eventId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rowCount } = await client.query("DELETE FROM site_events WHERE id = $1 AND site_id = $2", [eventId, site.id]);
      if (!rowCount) throw new HttpError(404, "Event not found");
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.event_deleted", entityType: "site", entityId: site.id, metadata: { eventId } });
      return { ok: true };
    });
  });

  // ---- donations ------------------------------------------------------------------
  app.get(`${base}/donations`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const intake = await client.query("SELECT value FROM site_intake_answers WHERE site_id = $1 AND question_key = 'site_donate_url'", [site.id]);
      const d = (site.donations ?? {}) as Record<string, unknown>;
      return { donations: { donateUrl: d.donateUrl ?? (typeof intake.rows[0]?.value === "string" ? intake.rows[0].value : null), heading: d.heading ?? null, blurb: d.blurb ?? null, presets: d.presets ?? [25, 50, 100, 250], monthly: d.monthly ?? true, hasDonatePage: Boolean((await client.query("SELECT 1 FROM site_pages WHERE site_id = $1 AND slug = 'donate'", [site.id])).rows[0]) } };
    });
  });
  app.put(`${base}/donations`, async (req) => {
    ctx.requireRole(req, "member");
    const input = SiteDonationsInput.parse(req.body);
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      if (input.donateUrl && !/^https:\/\//.test(input.donateUrl)) throw new HttpError(400, "The donation link must use https.");
      await client.query("UPDATE sites SET donations = donations || $2::jsonb WHERE id = $1", [site.id, JSON.stringify(input)]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.donations_updated", entityType: "site", entityId: site.id, metadata: { donateUrl: input.donateUrl ?? null } });
      return { ok: true };
    });
  });

  // ---- domains ---------------------------------------------------------------------
  const domainView = (r: Record<string, unknown>) => ({ id: r.id, domain: r.domain, status: r.status, dns: r.dns, lastCheckedAt: r.last_checked_at, lastError: r.last_error, connectedAt: r.connected_at, createdAt: r.created_at, instructions: instructionsFor(String(r.domain), String(r.verification_token)) });
  app.get(`${base}/domains`, async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT * FROM site_domains WHERE site_id = $1 ORDER BY created_at", [site.id]);
      return { domains: rows.map(domainView), defaultHost: siteUrls(site as never).live_url };
    });
  });
  app.post(`${base}/domains`, async (req, reply) => {
    ctx.requireRole(req, "admin");
    const input = SiteDomainInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      if (/deedwell\.org$/.test(input.domain)) throw new HttpError(400, "Use your own domain; deedwell.org addresses are assigned automatically.");
      const id = uuidv7();
      try {
        const { rows } = await client.query("INSERT INTO site_domains (id, tenant_id, site_id, domain, verification_token, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id, req.orgId, site.id, input.domain, newVerificationToken(), req.userId]);
        await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.domain_added", entityType: "site", entityId: site.id, metadata: { domain: input.domain } });
        return { domain: domainView(rows[0]) };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "That domain is already connected to a website.");
        throw err;
      }
    });
    return reply.status(201).send(result);
  });
  app.post(`${base}/domains/:domainId/verify`, async (req) => {
    ctx.requireRole(req, "member");
    const { domainId } = req.params as { domainId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rows } = await client.query("SELECT * FROM site_domains WHERE id = $1 AND site_id = $2", [domainId, site.id]);
      const d = rows[0];
      if (!d) throw new HttpError(404, "Domain not found");
      const obs = await observeDns(d.domain, d.verification_token);
      const https = obs.verified && obs.pointed ? await probeHttps(d.domain) : null;
      const mapped = Boolean((d.dns as { mapped?: boolean })?.mapped);
      const status = d.status === "connected" && https?.ok !== false ? "connected" : nextStatus(obs, https, mapped);
      const { rows: upd } = await client.query(
        "UPDATE site_domains SET status = $2, dns = dns || $3::jsonb, last_checked_at = now(), last_error = $4, connected_at = CASE WHEN $2 = 'connected' AND connected_at IS NULL THEN now() ELSE connected_at END WHERE id = $1 RETURNING *",
        [d.id, status, JSON.stringify({ observed: obs, https }), obs.error]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.domain_checked", entityType: "site", entityId: site.id, metadata: { domain: d.domain, status } });
      return { domain: domainView(upd[0]) };
    });
  });
  app.delete(`${base}/domains/:domainId`, async (req) => {
    ctx.requireRole(req, "admin");
    const { domainId } = req.params as { domainId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await siteOf(req, client);
      const { rowCount } = await client.query("DELETE FROM site_domains WHERE id = $1 AND site_id = $2", [domainId, site.id]);
      if (!rowCount) throw new HttpError(404, "Domain not found");
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "site.domain_removed", entityType: "site", entityId: site.id, metadata: { domainId } });
      return { ok: true };
    });
  });

  // Platform Admin: the hostnames waiting for their Cloud Run domain mapping.
  app.get("/v1/admin/site-domains", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT d.id, d.tenant_id, d.domain, d.status, d.dns, d.last_checked_at, d.last_error, d.created_at, s.slug, s.name AS site_name, o.name AS org_name
         FROM site_domains d JOIN sites s ON s.id = d.site_id JOIN organizations o ON o.id = d.tenant_id ORDER BY d.created_at DESC`);
    return { domains: rows, service: process.env.SITES_SERVICE_NAME ?? "deedwell-sites", region: process.env.GCP_REGION ?? "us-central1" };
  });
  app.post("/v1/admin/site-domains/:domainId", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { domainId } = req.params as { domainId: string };
    const { mapped, status } = z.object({ mapped: z.boolean().optional(), status: z.enum(["pending_dns", "verifying", "ssl_provisioning", "connected", "error"]).optional() }).parse(req.body ?? {});
    const { rows } = await ctx.deps.adminPool.query("SELECT id, tenant_id FROM site_domains WHERE id = $1", [domainId]);
    if (!rows[0]) throw new HttpError(404, "Domain not found");
    await withContext(ctx.deps.appPool, { tenantId: rows[0].tenant_id, userId: req.userId }, async (client) => {
      await client.query("UPDATE site_domains SET dns = dns || $2::jsonb, status = COALESCE($3, status), connected_at = CASE WHEN $3 = 'connected' AND connected_at IS NULL THEN now() ELSE connected_at END WHERE id = $1", [domainId, JSON.stringify(mapped === undefined ? {} : { mapped }), status ?? null]);
    });
    return { ok: true };
  });

  // ---- dictation for the editor's microphone -------------------------------------
  app.post("/v1/orgs/:orgId/dictate", async (req) => {
    ctx.requireRole(req, "member");
    const { audioBase64, mime } = z.object({ audioBase64: z.string().max(12_000_000), mime: z.string().max(80) }).parse(req.body);
    const bytes = Buffer.from(audioBase64, "base64");
    if (bytes.length < 1000) throw new HttpError(400, "That recording was too short to transcribe.");
    try {
      return { text: await transcribeClip(bytes, mime) };
    } catch (err) {
      const message = String((err as Error).message ?? err);
      throw new HttpError(/not available|Unsupported/i.test(message) ? 503 : 502, /not available/i.test(message)
        ? "Voice input is not available on this server — type your request instead."
        : "Could not transcribe that recording. Try again, or type your request.");
    }
  });
}
