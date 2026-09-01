import type { FastifyInstance } from "fastify";
import { audit, withContext } from "@deedwell/database";
import { HttpError, type AppContext } from "./app.js";

/**
 * Cross-org grant-application oversight AND intervention. The list
 * generalizes the existing per-org GET /v1/orgs/:orgId/applications
 * (routes-grants-full.ts); the detail route generalizes the per-org run
 * assembler (routes-grant.ts's GET /v1/orgs/:orgId/runs/:runId) to any
 * org's run. The decide route lets an admin unblock a run stuck on a
 * pending approval — the same "intervene when stuck" precedent already
 * established for Google sign-in, tenant-scoped audit()'d the same way so
 * it's never a silent cross-tenant action. Application CONTENT stays
 * read-only (it's AI-authored, not something an admin hand-edits); the
 * approval gate is the one real lever an admin needs.
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

  app.get("/v1/admin/grants/:applicationId", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { applicationId } = req.params as { applicationId: string };
    const appRow = await ctx.deps.adminPool.query(
      `SELECT a.id, a.tenant_id AS org_id, o.name AS org_name, a.project_id, a.run_id, a.status, a.created_at,
              op.title AS opportunity_title, op.funder, op.deadline::text AS deadline,
              op.geography, op.funding_min, op.funding_max, op.source_url,
              (SELECT status FROM grant_outcomes go WHERE go.application_id = a.id) AS outcome,
              (SELECT award_amount FROM grant_outcomes go WHERE go.application_id = a.id) AS award_amount,
              (SELECT feedback FROM grant_outcomes go WHERE go.application_id = a.id) AS feedback
       FROM grant_applications a
       JOIN grant_opportunities op ON op.id = a.opportunity_id
       JOIN organizations o ON o.id = a.tenant_id
       WHERE a.id = $1`,
      [applicationId]
    );
    if (!appRow.rows[0]) throw new HttpError(404, "Application not found");
    const runId = appRow.rows[0].run_id;
    const [run, steps, approvals, artifacts] = await Promise.all([
      ctx.deps.adminPool.query(
        `SELECT id, status, current_step, steps_used, step_budget, last_error,
                state->'waiting' AS waiting, created_at, updated_at
         FROM workflow_runs WHERE id = $1`,
        [runId]
      ),
      ctx.deps.adminPool.query(
        `SELECT seq, step, attempt, status, error, duration_ms, created_at
         FROM workflow_steps WHERE run_id = $1 ORDER BY seq`,
        [runId]
      ),
      ctx.deps.adminPool.query(
        `SELECT id, kind, payload, status, decided_by, decided_at, note, created_at
         FROM approvals WHERE run_id = $1 ORDER BY created_at DESC`,
        [runId]
      ),
      ctx.deps.adminPool.query(
        `SELECT id, type, title, current_version, updated_at FROM artifacts WHERE run_id = $1 ORDER BY updated_at DESC`,
        [runId]
      ),
    ]);
    return {
      application: appRow.rows[0],
      run: run.rows[0] ?? null,
      steps: steps.rows,
      approvals: approvals.rows,
      artifacts: artifacts.rows,
    };
  });

  // Generic across every workflow type (grant, ad-grants, website) —
  // `approvals` isn't grant-specific, this is just where the first admin
  // approval-intervention UI needed it. Resolves its own tenant from the
  // approval row since, unlike the org-facing route, no :orgId is known
  // ahead of time here.
  app.post("/v1/admin/approvals/:approvalId/decide", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { approvalId } = req.params as { approvalId: string };
    const { decision, note } = req.body as { decision?: string; note?: string };
    if (decision !== "approved" && decision !== "rejected") {
      throw new HttpError(400, "decision must be 'approved' or 'rejected'");
    }
    const lookup = await ctx.deps.adminPool.query(`SELECT tenant_id FROM approvals WHERE id = $1`, [approvalId]);
    if (!lookup.rows[0]) throw new HttpError(404, "Approval not found");
    const tenantId = lookup.rows[0].tenant_id;
    await withContext(ctx.deps.appPool, { tenantId, userId: req.userId }, async (client) => {
      const { rows } = await client.query(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), note = $4
         WHERE id = $1 AND status = 'pending' RETURNING run_id`,
        [approvalId, decision, req.userId, note ?? null]
      );
      if (!rows[0]) throw new HttpError(404, "No pending approval with that id");
      await ctx.deps.engine.signal(client, rows[0].run_id, "approval", { approvalId, decision });
      await audit(client, {
        tenantId, actorUser: req.userId, action: `admin.approval_${decision}`,
        entityType: "approval", entityId: approvalId, metadata: { note: note ?? null },
      });
    });
    return { ok: true };
  });
}
