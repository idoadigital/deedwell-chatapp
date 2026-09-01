import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { audit, uuidv7, withContext } from "@deedwell/database";
import { AD_GRANTS_WORKFLOW } from "@deedwell/adgrants-domain";
import { HttpError, type AppContext } from "./app.js";

function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Platform-admin oversight of every organization's Google Ad Grants
 * application, and the ability to intervene when one is stuck — most
 * commonly a Google browser session that's expired mid-automation and the
 * org's own user hasn't reconnected yet. Cross-tenant by nature (an admin
 * is not a member of the orgs they're helping), so every read here goes
 * through ctx.deps.adminPool directly rather than ctx.inOrg — same idiom
 * routes-public.ts and ad-grants-connect-ws.ts's redeemToken already use
 * for "no single tenant context applies" reads.
 */
export function registerAdminAdGrantsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/ad-grants", async (req) => {
    ctx.requirePlatformAdmin(req);
    // "In progress" deliberately includes failed/waiting runs, not just
    // healthy-and-moving ones — those are exactly the ones that need an
    // admin's attention, not the ones that don't.
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT DISTINCT ON (o.id) o.id AS org_id, o.name AS org_name, o.slug,
              r.id AS run_id, r.status, r.current_step, r.last_error,
              r.state->'waiting' AS waiting, r.updated_at, r.created_at
       FROM organizations o
       JOIN projects p ON p.tenant_id = o.id AND p.name = 'Google Ad Grant'
       JOIN workflow_runs r ON r.project_id = p.id AND r.definition = $1
       WHERE r.status NOT IN ('completed', 'cancelled')
       ORDER BY o.id, r.created_at DESC`,
      [AD_GRANTS_WORKFLOW]
    );
    return { applications: rows };
  });

  // Mints the same single-use token the org-facing
  // POST /v1/orgs/:orgId/ad-grants/google-connect/session issues — the WS
  // route (ad-grants-connect-ws.ts) and the browser-automation package
  // resolve identity purely from this token's tenant_id/run_id/user_id, so
  // they need zero changes to work for an admin-initiated session.
  app.post("/v1/admin/orgs/:orgId/ad-grants/google-connect/session", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const run = await ctx.deps.adminPool.query(
      `SELECT r.id FROM workflow_runs r JOIN projects p ON p.id = r.project_id
       WHERE p.tenant_id = $1 AND r.definition = $2 AND r.status NOT IN ('completed','cancelled')
       ORDER BY r.created_at DESC LIMIT 1`,
      [orgId, AD_GRANTS_WORKFLOW]
    );
    if (!run.rows[0]) throw new HttpError(404, "No active Ad Grants application for this organization");
    const token = randomBytes(24).toString("base64url");
    await ctx.deps.adminPool.query(
      `INSERT INTO google_connect_sessions (id, tenant_id, run_id, user_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`,
      [uuidv7(), orgId, run.rows[0].id, req.userId, sha(token)]
    );
    // Tenant-scoped, not the platform-wide req.log.info the rest of
    // routes-admin.ts uses — an admin connecting on an org's behalf must
    // show up in that org's own audit trail, never as a silent cross-tenant
    // action, even though the action was initiated outside the org.
    await withContext(ctx.deps.appPool, { tenantId: orgId, userId: req.userId }, (client) =>
      audit(client, {
        tenantId: orgId, actorUser: req.userId, action: "admin.google_connect_initiated",
        entityType: "workflow_run", entityId: run.rows[0].id, metadata: {},
      })
    );
    return reply.status(201).send({ token, wsPath: `/v1/ad-grants/google-connect?token=${token}` });
  });
}
