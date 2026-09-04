import type { FastifyInstance } from "fastify";
import { audit, enqueueWebhookEvent, uuidv7 } from "@deedwell/database";
import {
  CreateWebsiteInput, CreateWebsiteRequestInput, RollbackInput, SubmitIntakeInput, WebsiteUpdateInput,
} from "@deedwell/schemas";
import { WEBSITE_BUILD_WORKFLOW, WEBSITE_UPDATE_WORKFLOW, websiteIntakeField } from "@deedwell/website-domain";
import { HttpError, type AppContext } from "./app.js";

/** Where the site-router serves a site, so the dashboard can link to it and
 *  frame it. Derived from the same env the router reads, never guessed by the
 *  browser. A partner-built site reports its own URL and that always wins. */
function siteUrls(row: { slug: string; external_build_url: string | null; live_version: number | null; preview_version: number | null }) {
  const base = process.env.SITES_BASE_DOMAIN ?? null;
  const scheme = process.env.SITES_SCHEME ?? "https";
  // Without a wildcard domain, the router's own origin still serves every
  // site by path — so a preview is reachable the moment it is built.
  const routerUrl = (process.env.SITES_ROUTER_URL ?? "").replace(/\/+$/, "") || null;
  if (row.external_build_url) {
    return { live_url: row.external_build_url, preview_url: null };
  }
  if (base) {
    return {
      live_url: row.live_version ? `${scheme}://${row.slug}.${base}` : null,
      preview_url: row.preview_version ? `${scheme}://preview-${row.slug}.${base}` : null,
    };
  }
  if (routerUrl) {
    return {
      live_url: row.live_version ? `${routerUrl}/${row.slug}/` : null,
      preview_url: row.preview_version ? `${routerUrl}/preview/${row.slug}/` : null,
    };
  }
  return { live_url: null, preview_url: null };
}

/** Subdomain labels that can never be claimed as site slugs. */
const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "preview", "sites", "mail", "status", "docs", "assets",
]);

export function registerWebsiteRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- create a website (starts the build workflow) ----------------------

  app.post("/v1/orgs/:orgId/projects/:projectId/website", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = CreateWebsiteInput.parse(req.body);
    if (RESERVED_SLUGS.has(input.slug)) {
      throw new HttpError(409, `The address "${input.slug}" is reserved`);
    }
    const result = await ctx.inOrg(req, async (client) => {
      const project = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      const siteId = uuidv7();
      try {
        await client.query(
          `INSERT INTO sites (id, tenant_id, project_id, slug, name, theme, created_by)
           VALUES ($1,$2,$3,$4,$5,'{"palette":"slate","headingFont":"serif"}',$6)`,
          [siteId, req.orgId, projectId, input.slug, input.siteName, req.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, `The address "${input.slug}" is already taken`);
        }
        throw err;
      }
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!,
        projectId,
        definition: WEBSITE_BUILD_WORKFLOW,
        createdBy: req.userId!,
        input: { siteId, siteName: input.siteName, donateUrl: input.donateUrl ?? null },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "site.created",
        entityType: "site", entityId: siteId, metadata: { slug: input.slug, runId },
      });
      // Delivery is a periodic sweep (apps/api/src/main.ts), not inline here
      // — a slow or dead webhook consumer must never delay this response.
      // Webhook subscriptions are platform-wide, not per-org, so the payload
      // carries orgId itself rather than relying on delivery context.
      await enqueueWebhookEvent(client, "website.created", {
        orgId: req.orgId, siteId, slug: input.slug, siteName: input.siteName,
      });
      return { siteId, runId };
    });
    return reply.status(201).send(result);
  });

  // ---- website requests (external-partner pipeline; no workflow) ---------
  // deedwell.org's public "free website" intake flow lands here, NOT on the
  // create-website route above: it must never start Deedwell's own AI build
  // workflow. This only collects and stores what a third-party application
  // (an AI agent that actually builds the site) reads via the public API —
  // see routes-public.ts — and reports back to via the /complete callback.

  app.post("/v1/orgs/:orgId/projects/:projectId/website-request", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = CreateWebsiteRequestInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const project = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      const siteId = uuidv7();
      try {
        await client.query(
          `INSERT INTO sites (id, tenant_id, project_id, slug, name, source, created_by)
           VALUES ($1,$2,$3,$4,$5,'external_partner',$6)`,
          [siteId, req.orgId, projectId, input.slug, input.siteName, req.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, `The address "${input.slug}" is already taken`);
        }
        throw err;
      }
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "website_request.created",
        entityType: "site", entityId: siteId, metadata: { slug: input.slug },
      });
      await enqueueWebhookEvent(client, "website.created", {
        orgId: req.orgId, siteId, slug: input.slug, siteName: input.siteName,
      });
      return { siteId };
    });
    return reply.status(201).send(result);
  });

  app.post("/v1/orgs/:orgId/sites/:siteId/intake", async (req) => {
    ctx.requireRole(req, "member");
    const { siteId } = req.params as { siteId: string };
    const input = SubmitIntakeInput.parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const site = await client.query("SELECT source FROM sites WHERE id = $1", [siteId]);
      if (!site.rows[0]) throw new HttpError(404, "Site not found");
      // This is a direct write, not routed through a workflow's provide-info
      // gate (there is no workflow for an external-partner site) — keeping
      // it scoped to that pipeline avoids it becoming a second, ungated way
      // to feed answers into the internal build workflow's own sites.
      if (site.rows[0].source !== "external_partner") {
        throw new HttpError(409, "This site is managed by the internal website builder — use the conversational update flow instead");
      }
      const accepted: string[] = [];
      const ignored: string[] = [];
      for (const answer of input.answers) {
        if (!websiteIntakeField(answer.key)) { ignored.push(answer.key); continue; }
        await client.query(
          `INSERT INTO site_intake_answers (id, tenant_id, site_id, question_key, value, answered_by)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6)
           ON CONFLICT (site_id, question_key)
           DO UPDATE SET value = EXCLUDED.value, answered_by = EXCLUDED.answered_by, updated_at = now()`,
          [uuidv7(), req.orgId, siteId, answer.key, JSON.stringify(answer.value), req.userId]
        );
        accepted.push(answer.key);
      }
      if (!accepted.length) throw new HttpError(400, `No recognised answers (unknown keys: ${ignored.join(", ")})`);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "website_request.intake_submitted",
        entityType: "site", entityId: siteId, metadata: { keys: accepted },
      });
    });
    return { ok: true };
  });

  // ---- list & detail ------------------------------------------------------

  app.get("/v1/orgs/:orgId/sites", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT s.id, s.project_id, p.name AS project_name, s.slug, s.name, s.status,
                s.source, s.external_build_url, s.theme, s.created_at,
                (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version,
                (SELECT version FROM site_releases r WHERE r.id = s.active_release_id) AS live_version,
                (SELECT COUNT(*)::int FROM form_submissions fs WHERE fs.site_id = s.id) AS submissions
         FROM sites s JOIN projects p ON p.id = s.project_id
         ORDER BY s.created_at DESC`
      )
    );
    return { sites: rows.map((row) => ({ ...row, ...siteUrls(row as never) })) };
  });

  app.get("/v1/orgs/:orgId/sites/:siteId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { siteId } = req.params as { siteId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await client.query(
        `SELECT id, project_id, slug, name, status, source, external_build_url,
                theme, preview_release_id, active_release_id, created_at
         FROM sites WHERE id = $1`,
        [siteId]
      );
      if (!site.rows[0]) throw new HttpError(404, "Site not found");
      const pages = await client.query(
        "SELECT slug, title, order_idx, blocks, seo FROM site_pages WHERE site_id = $1 ORDER BY order_idx",
        [siteId]
      );
      const releases = await client.query(
        `SELECT id, version, status, checks, published_at, created_at
         FROM site_releases WHERE site_id = $1 ORDER BY version DESC`,
        [siteId]
      );
      // The answers behind this site. The partner-facing endpoint has always
      // returned these; the owner of the site could not read their own until
      // now, which made "edit your details" impossible to prefill.
      const intake = await client.query(
        "SELECT question_key, value FROM site_intake_answers WHERE site_id = $1",
        [siteId]
      );
      const versions = await client.query(
        `SELECT (SELECT version FROM site_releases r WHERE r.id = s.active_release_id)  AS live_version,
                (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version
         FROM sites s WHERE s.id = $1`,
        [siteId]
      );
      return {
        site: { ...site.rows[0], ...siteUrls({ ...site.rows[0], ...versions.rows[0] } as never) },
        pages: pages.rows,
        releases: releases.rows,
        intake: Object.fromEntries(intake.rows.map((r) => [r.question_key, r.value])),
      };
    });
  });

  // ---- generate (brief first, then the build) -----------------------------
  // The build workflow already does what the dashboard needs: it writes a
  // website brief, raises a `website_brief` approval and refuses to generate a
  // single page until that approval is decided. Until now the only way to
  // start it was to create a NEW site; this runs it for a site that already
  // exists, so "Generate" on a row means that row.

  app.post("/v1/orgs/:orgId/sites/:siteId/generate", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { siteId } = req.params as { siteId: string };
    const result = await ctx.inOrg(req, async (client) => {
      const site = await client.query(
        "SELECT id, project_id, name, source FROM sites WHERE id = $1",
        [siteId]
      );
      if (!site.rows[0]) throw new HttpError(404, "Site not found");
      const { activeRunFor } = await import("./assistant.js");
      const inFlight = await activeRunFor(client, site.rows[0].project_id, "website");
      if (inFlight) {
        throw new HttpError(409, `A website run is already active for this site (${inFlight.status})`);
      }
      const donate = await client.query(
        "SELECT value FROM site_intake_answers WHERE site_id = $1 AND question_key = 'site_donate_url'",
        [siteId]
      );
      const donateUrl = typeof donate.rows[0]?.value === "string" ? donate.rows[0].value : null;
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!,
        projectId: site.rows[0].project_id,
        definition: WEBSITE_BUILD_WORKFLOW,
        createdBy: req.userId!,
        input: { siteId, siteName: site.rows[0].name, donateUrl },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "site.generate_requested",
        entityType: "site", entityId: siteId, metadata: { runId, source: site.rows[0].source },
      });
      return { runId, siteId };
    });
    return reply.status(201).send(result);
  });

  // ---- conversational update ---------------------------------------------

  app.post("/v1/orgs/:orgId/sites/:siteId/update", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { siteId } = req.params as { siteId: string };
    const input = WebsiteUpdateInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const site = await client.query("SELECT id, project_id FROM sites WHERE id = $1", [siteId]);
      if (!site.rows[0]) throw new HttpError(404, "Site not found");
      const { activeRunFor } = await import("./assistant.js");
      const inFlight = await activeRunFor(client, site.rows[0].project_id, "website");
      if (inFlight) {
        throw new HttpError(409, `A website run is already active for this site (${inFlight.status})`);
      }
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!,
        projectId: site.rows[0].project_id,
        definition: WEBSITE_UPDATE_WORKFLOW,
        createdBy: req.userId!,
        input: { siteId, instruction: input.instruction },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "site.update_requested",
        entityType: "site", entityId: siteId, metadata: { instruction: input.instruction, runId },
      });
      return { runId };
    });
    return reply.status(201).send(result);
  });

  // ---- rollback (admin; only to a previously published release) ----------

  app.post("/v1/orgs/:orgId/sites/:siteId/rollback", async (req) => {
    ctx.requireRole(req, "admin");
    const { siteId } = req.params as { siteId: string };
    const input = RollbackInput.parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const release = await client.query(
        `SELECT id, status FROM site_releases WHERE id = $1 AND site_id = $2`,
        [input.releaseId, siteId]
      );
      if (!release.rows[0]) throw new HttpError(404, "Release not found");
      if (!["published", "superseded"].includes(release.rows[0].status)) {
        throw new HttpError(409, "Only previously published releases can be rolled back to");
      }
      await client.query(
        `UPDATE site_releases SET status = 'superseded' WHERE site_id = $1 AND status = 'published'`,
        [siteId]
      );
      await client.query(
        `UPDATE site_releases SET status = 'published', published_at = now(), approved_by = $2
         WHERE id = $1`,
        [input.releaseId, req.userId]
      );
      await client.query(
        "UPDATE sites SET active_release_id = $2, status = 'published' WHERE id = $1",
        [siteId, input.releaseId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "site.rolled_back",
        entityType: "site_release", entityId: input.releaseId, metadata: { siteId },
      });
      await enqueueWebhookEvent(client, "website.published", { orgId: req.orgId, siteId, releaseId: input.releaseId });
    });
    return { ok: true };
  });

  // ---- form submissions (tenant-scoped read) ------------------------------

  app.get("/v1/orgs/:orgId/sites/:siteId/submissions", async (req) => {
    ctx.requireRole(req, "viewer");
    const { siteId } = req.params as { siteId: string };
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT id, form_key, payload, created_at FROM form_submissions
         WHERE site_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [siteId]
      )
    );
    return { submissions: rows };
  });
}
