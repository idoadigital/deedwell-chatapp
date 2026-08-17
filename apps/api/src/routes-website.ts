import type { FastifyInstance } from "fastify";
import { audit, uuidv7 } from "@deedwell/database";
import { CreateWebsiteInput, RollbackInput, WebsiteUpdateInput } from "@deedwell/schemas";
import { WEBSITE_BUILD_WORKFLOW, WEBSITE_UPDATE_WORKFLOW } from "@deedwell/website-domain";
import { HttpError, type AppContext } from "./app.js";

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
      return { siteId, runId };
    });
    return reply.status(201).send(result);
  });

  // ---- list & detail ------------------------------------------------------

  app.get("/v1/orgs/:orgId/sites", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT s.id, s.project_id, p.name AS project_name, s.slug, s.name, s.status,
                s.theme, s.created_at,
                (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version,
                (SELECT version FROM site_releases r WHERE r.id = s.active_release_id) AS live_version,
                (SELECT COUNT(*)::int FROM form_submissions fs WHERE fs.site_id = s.id) AS submissions
         FROM sites s JOIN projects p ON p.id = s.project_id
         ORDER BY s.created_at DESC`
      )
    );
    return { sites: rows };
  });

  app.get("/v1/orgs/:orgId/sites/:siteId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { siteId } = req.params as { siteId: string };
    return ctx.inOrg(req, async (client) => {
      const site = await client.query(
        `SELECT id, project_id, slug, name, status, theme, preview_release_id, active_release_id, created_at
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
      return { site: site.rows[0], pages: pages.rows, releases: releases.rows };
    });
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
