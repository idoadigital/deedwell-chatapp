import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

/**
 * Cross-org website-request oversight — the exact same cross-tenant query
 * shape already powering the public developer API (routes-public.ts's
 * GET /v1/public/websites[/:siteId]), just re-gated under
 * requirePlatformAdmin instead of the websites:read API-key scope. Same
 * data, admin-facing route: no new query design needed.
 */
export function registerAdminWebsitesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/websites", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT s.id, s.slug, s.name, s.status, s.source, s.external_build_url,
              s.project_id, s.tenant_id AS org_id, o.name AS org_name, s.created_at, s.updated_at
       FROM sites s JOIN organizations o ON o.id = s.tenant_id
       ORDER BY s.created_at DESC LIMIT 500`
    );
    return { websites: rows };
  });

  app.get("/v1/admin/websites/:siteId", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { siteId } = req.params as { siteId: string };
    const site = await ctx.deps.adminPool.query(
      `SELECT s.id, s.slug, s.name, s.status, s.source, s.external_build_url,
              s.tenant_id AS org_id, o.name AS org_name, s.created_at, s.updated_at
       FROM sites s JOIN organizations o ON o.id = s.tenant_id WHERE s.id = $1`,
      [siteId]
    );
    if (!site.rows[0]) return { website: null };
    const intake = await ctx.deps.adminPool.query(
      "SELECT question_key, value FROM site_intake_answers WHERE site_id = $1",
      [siteId]
    );
    return {
      website: {
        ...site.rows[0],
        intake: Object.fromEntries(intake.rows.map((r) => [r.question_key, r.value])),
      },
    };
  });
}
