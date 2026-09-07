import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { audit, uuidv7 } from "@deedwell/database";
import { AD_GRANTS_WORKFLOW, revokeGoogleSession } from "@deedwell/adgrants-domain";
import { scopesForServices, type GoogleConnectionSummary } from "@deedwell/connectors";
import { HttpError, type AppContext } from "./app.js";
import { requireTokens } from "./billing-gate.js";
import { resolveInfoRequest } from "./fact-fields.js";
import { completionForRun } from "./workspace.js";

function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The Google account for Ad Grants is the workspace's Google connector
 *  connection — one source of truth for every Google integration. Same
 *  shape the wizard has always read, plus the connection id and what the
 *  Ad Grants service still needs from it. */
function googleOAuthView(connection: GoogleConnectionSummary | null) {
  if (!connection) return { connected: false, email: null, name: null, avatarUrl: null, connectionId: null, status: null, missingScopes: scopesForServices(["adgrants"]) };
  const adgrants = connection.services.find((s) => s.key === "adgrants");
  return {
    connected: connection.status === "connected",
    email: connection.accountHandle, name: connection.accountName, avatarUrl: connection.accountAvatarUrl,
    connectionId: connection.id, status: connection.status, missingScopes: adgrants?.missing ?? [],
  };
}

async function findOrCreateProject(
  client: import("pg").PoolClient,
  tenantId: string,
  userId: string
): Promise<string> {
  const existing = await client.query(
    `SELECT id FROM projects WHERE tenant_id = $1 AND name = 'Google Ad Grant' LIMIT 1`,
    [tenantId]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const projectId = uuidv7();
  await client.query(
    `INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'Google Ad Grant','other',$3)`,
    [projectId, tenantId, userId]
  );
  return projectId;
}

export function registerAdGrantsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- start (idempotent — reuses an already-active run) -----------------

  app.post("/v1/orgs/:orgId/ad-grants/start", async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const result = await ctx.inOrg(req, async (client) => {
      const projectId = await findOrCreateProject(client, req.orgId!, req.userId!);
      const existingRun = await client.query(
        `SELECT id FROM workflow_runs WHERE project_id = $1 AND definition = $2
           AND status NOT IN ('completed','cancelled')
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, AD_GRANTS_WORKFLOW]
      );
      if (existingRun.rows[0]) return { runId: existingRun.rows[0].id, projectId };

      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!, projectId, definition: AD_GRANTS_WORKFLOW, createdBy: req.userId!, input: {},
      });
      // The application reuses whatever Google account the workspace already
      // connected; record which one so the run's history says so.
      const google = await ctx.deps.googleConnections.describe(client, req.orgId!);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.started",
        entityType: "workflow_run", entityId: runId,
        metadata: { definition: AD_GRANTS_WORKFLOW, googleConnectionId: google?.id ?? null, googleAccount: google?.accountHandle ?? null },
      });
      return { runId, projectId };
    });
    return reply.status(201).send(result);
  });

  // ---- restart: cancel the active run and begin again from step 1 --------
  // Facts, files and the Google connection/session stay; the run, its
  // pending approval and its open timeline entries are closed out. Clearing
  // claimed_by makes a worker mid-step lose its lease (the engine's commit
  // is guarded on it), so a cancelled run can never write a later status.
  app.post("/v1/orgs/:orgId/ad-grants/restart", async (req, reply) => {
    ctx.requireRole(req, "admin");
    await requireTokens(ctx, req);
    const result = await ctx.inOrg(req, async (client) => {
      const projectId = await findOrCreateProject(client, req.orgId!, req.userId!);
      const active = await client.query(
        `SELECT id FROM workflow_runs WHERE project_id = $1 AND definition = $2 AND status NOT IN ('completed','cancelled')
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, AD_GRANTS_WORKFLOW]
      );
      const previousRunId: string | null = active.rows[0]?.id ?? null;
      if (previousRunId) {
        await client.query(
          `UPDATE workflow_runs SET status = 'cancelled', claimed_by = NULL, claimed_at = NULL, last_error = NULL WHERE id = $1`,
          [previousRunId]
        );
        await client.query(
          `UPDATE approvals SET status = 'rejected', decided_by = $2, decided_at = now(), note = 'Application restarted from the beginning'
           WHERE run_id = $1 AND status = 'pending'`,
          [previousRunId, req.userId]
        );
        await client.query(
          `UPDATE workspace_events SET status = 'completed', completed_at = now()
           WHERE run_id = $1 AND status IN ('in_progress','blocked')`,
          [previousRunId]
        );
        await audit(client, {
          tenantId: req.orgId!, actorUser: req.userId, action: "workflow.cancelled",
          entityType: "workflow_run", entityId: previousRunId, metadata: { definition: AD_GRANTS_WORKFLOW, reason: "restart" },
        });
      }
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!, projectId, definition: AD_GRANTS_WORKFLOW, createdBy: req.userId!, input: {},
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.started",
        entityType: "workflow_run", entityId: runId, metadata: { definition: AD_GRANTS_WORKFLOW, restartOf: previousRunId },
      });
      return { runId, projectId, previousRunId };
    });
    ctx.deps.engine.events.emit("event", { type: "run_updated", tenantId: req.orgId!, runId: result.runId, status: "pending", step: "start" } as never);
    return reply.status(201).send(result);
  });

  // ---- status: everything the dashboard and the Ad Grants page need ------

  app.get("/v1/orgs/:orgId/ad-grants/status", async (req) => {
    ctx.requireRole(req, "viewer");
    return ctx.inOrg(req, async (client) => {
      const project = await client.query(
        `SELECT id, name, status, created_at FROM projects WHERE tenant_id = $1 AND name = 'Google Ad Grant' LIMIT 1`,
        [req.orgId]
      );
      if (!project.rows[0]) {
        return {
          project: null, run: null, completion: 0, events: [], artifacts: [],
          approvals: [], files: [], questions: [], allowSkip: false, googleSession: null, googleOAuth: null,
        };
      }
      const projectId = project.rows[0].id;

      const run = await client.query(
        `SELECT id, status, current_step, steps_used, step_budget, last_error,
                state->'waiting' AS waiting, state->>'result' AS result,
                state->>'eligibilityReasons' AS eligibility_reasons,
                state->>'reviewRejectionReason' AS review_rejection_reason,
                state->>'googleCampaignId' AS google_campaign_id,
                created_at, updated_at
         FROM workflow_runs WHERE project_id = $1 AND definition = $2
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, AD_GRANTS_WORKFLOW]
      );
      const runRow = run.rows[0] ?? null;

      const events = await client.query(
        `SELECT id, event_type, title, summary, status, agent_key, created_at, completed_at,
                metadata->>'phase' AS phase, (metadata->>'screenshotKey') IS NOT NULL AS has_screenshot
         FROM workspace_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 80`,
        [projectId]
      );
      const artifacts = await client.query(
        `SELECT id, type, title, current_version, updated_at FROM artifacts WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId]
      );
      const approvals = runRow
        ? await client.query(
            `SELECT id, kind, payload, status, decided_by, decided_at, note, created_at
             FROM approvals WHERE run_id = $1 ORDER BY created_at DESC`,
            [runRow.id]
          )
        : { rows: [] as unknown[] };
      const files = await client.query(
        `SELECT f.id, f.filename, f.mime, f.size_bytes, fl.created_at AS linked_at
         FROM file_links fl JOIN files f ON f.id = fl.file_id
         WHERE fl.project_id = $1 ORDER BY fl.created_at DESC`,
        [projectId]
      );
      const googleSession = await client.query(
        `SELECT google_account_hint, status FROM google_sessions
         WHERE tenant_id = $1 AND status = 'active' ORDER BY connected_at DESC LIMIT 1`,
        [req.orgId]
      );

      const resolved = runRow && runRow.status === "waiting_for_info"
        ? await resolveInfoRequest(client, runRow.id)
        : null;

      const googleConnection = await ctx.deps.googleConnections.describe(client, req.orgId!);

      return {
        project: project.rows[0],
        run: runRow,
        completion: runRow ? completionForRun(runRow.current_step, runRow.status, AD_GRANTS_WORKFLOW) : 0,
        events: events.rows,
        artifacts: artifacts.rows,
        approvals: approvals.rows,
        files: files.rows,
        questions: resolved?.fields ?? [],
        waitingContext: resolved?.context ?? null,
        allowSkip: resolved?.allowSkip ?? false,
        googleSession: googleSession.rows[0]
          ? { connected: true, accountHint: googleSession.rows[0].google_account_hint, status: googleSession.rows[0].status }
          : { connected: false, accountHint: null, status: null },
        googleOAuth: googleOAuthView(googleConnection),
      };
    });
  });

  // ---- Google account connect (ephemeral token issuance) -----------------

  app.post("/v1/orgs/:orgId/ad-grants/google-connect/session", async (req, reply) => {
    ctx.requireRole(req, "member");
    const result = await ctx.inOrg(req, async (client) => {
      const run = await client.query(
        `SELECT r.id FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         WHERE p.tenant_id = $1 AND r.definition = $2 AND r.status NOT IN ('completed','cancelled')
         ORDER BY r.created_at DESC LIMIT 1`,
        [req.orgId, AD_GRANTS_WORKFLOW]
      );
      if (!run.rows[0]) throw new HttpError(404, "No active Ad Grants application to connect a Google account to");
      const token = randomBytes(24).toString("base64url");
      await client.query(
        `INSERT INTO google_connect_sessions (id, tenant_id, run_id, user_id, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`,
        [uuidv7(), req.orgId, run.rows[0].id, req.userId, sha(token)]
      );
      return { token };
    });
    return reply.status(201).send({ ...result, wsPath: `/v1/ad-grants/google-connect?token=${result.token}` });
  });

  // ---- live view: the screenshot attached to a progress event ------------
  app.get("/v1/orgs/:orgId/ad-grants/events/:eventId/screenshot", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { eventId } = req.params as { eventId: string };
    const row = await ctx.inOrg(req, async (client) =>
      (await client.query("SELECT metadata->>'screenshotKey' AS key FROM workspace_events WHERE id = $1 AND tenant_id = $2", [eventId, req.orgId])).rows[0] as { key?: string | null } | undefined
    );
    const key = row?.key;
    if (!key || !key.startsWith(`tenants/${req.orgId}/`)) throw new HttpError(404, "No screenshot for this event");
    const bytes = await ctx.deps.storage.get(key);
    return reply.header("cache-control", "private, max-age=3600").type(key.endsWith(".png") ? "image/png" : "image/jpeg").send(bytes);
  });

  // ---- approval preview: the filled Google form, before Approve ----------
  // Screenshots are tenant files in object storage keyed inside the approval
  // payload; the approval row is RLS-scoped, so the id alone cannot reach
  // another workspace's image.
  app.get("/v1/orgs/:orgId/approvals/:approvalId/preview", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { approvalId } = req.params as { approvalId: string };
    const row = await ctx.inOrg(req, async (client) =>
      (await client.query("SELECT payload FROM approvals WHERE id = $1", [approvalId])).rows[0] as { payload?: { screenshotKey?: string } } | undefined
    );
    const key = row?.payload?.screenshotKey;
    if (!key) throw new HttpError(404, "No preview image for this approval");
    const bytes = await ctx.deps.storage.get(key);
    return reply
      .header("cache-control", "private, max-age=300")
      .type(key.endsWith(".jpg") || key.endsWith(".jpeg") ? "image/jpeg" : "image/png")
      .send(bytes);
  });

  // ---- revoke --------------------------------------------------------------

  app.delete("/v1/orgs/:orgId/ad-grants/google-session", async (req) => {
    ctx.requireRole(req, "admin");
    const revoked = await ctx.inOrg(req, (client) => revokeGoogleSession(client, req.orgId!, req.userId!));
    if (!revoked) throw new HttpError(404, "No active Google session to revoke");
    return { ok: true };
  });

  // The Google account itself is connected through the Google connector
  // (/v1/orgs/:orgId/connectors/google/*) — the former Ad Grants-only OAuth
  // routes are gone, and `googleOAuth` in the status above reads from there.

  // ---- explicit consent, recorded at the moment "Start My Application" is
  // clicked — deliberately separate from /start above, which is idempotent
  // and also fires from earlier wizard steps that auto-create a run; this
  // is the one write that only ever happens behind the checkbox.

  app.post("/v1/orgs/:orgId/ad-grants/authorize", async (req) => {
    ctx.requireRole(req, "member");
    return ctx.inOrg(req, async (client) => {
      const run = await client.query(
        `SELECT r.id FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         WHERE p.tenant_id = $1 AND r.definition = $2 AND r.status NOT IN ('completed','cancelled')
         ORDER BY r.created_at DESC LIMIT 1`,
        [req.orgId, AD_GRANTS_WORKFLOW]
      );
      if (!run.rows[0]) throw new HttpError(404, "No active Ad Grants application to authorize");
      const google = await ctx.deps.googleConnections.describe(client, req.orgId!);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "ad_grants.authorized",
        entityType: "workflow_run", entityId: run.rows[0].id,
        metadata: { googleConnectionId: google?.id ?? null, googleAccount: google?.accountHandle ?? null },
      });
      return { ok: true };
    });
  });
}
