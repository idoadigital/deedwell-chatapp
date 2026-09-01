import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

/**
 * Cross-org grant-application oversight — generalizes the existing
 * per-org GET /v1/orgs/:orgId/applications (routes-grants-full.ts) to every
 * org. Read-only: application content is AI-authored, so an admin editing
 * it in place isn't a real product need — this is visibility, not a CMS.
 */
export function registerAdminGrantsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/grants", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT a.id, a.tenant_id AS org_id, o2.name AS org_name, a.project_id, a.opportunity_id,
              a.run_id, a.status, a.created_at,
              o.title AS opportunity_title, o.funder, o.deadline::text AS deadline,
              (SELECT status FROM grant_outcomes go WHERE go.application_id = a.id) AS outcome,
              (SELECT award_amount FROM grant_outcomes go WHERE go.application_id = a.id) AS award_amount
       FROM grant_applications a
       JOIN grant_opportunities o ON o.id = a.opportunity_id
       JOIN organizations o2 ON o2.id = a.tenant_id
       ORDER BY a.created_at DESC LIMIT 500`
    );
    return { applications: rows };
  });
}
