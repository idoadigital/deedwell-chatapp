import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { audit, uuidv7, withContext } from "@deedwell/database";
import {
  AD_GRANTS_WORKFLOW, revokeGoogleSession,
  loadOAuthConfig, startGoogleOAuth, redeemOAuthState, exchangeGoogleCode,
  saveOAuthConnection, loadActiveOAuthConnection, revokeOAuthConnection,
} from "@deedwell/adgrants-domain";
import { HttpError, type AppContext } from "./app.js";
import { resolveInfoRequest } from "./fact-fields.js";
import { completionForRun } from "./workspace.js";

function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Only ever redirect back to an origin this deployment already trusts
// (the same allowlist CORS uses) — redirectTo is attacker-controllable
// input from a query string, so an unvalidated value here would be an
// open redirect off the Google OAuth callback.
function trustedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",");
}

function resolveRedirectTarget(candidate: string | undefined): string {
  const fallback = `${trustedOrigins()[0]}/dashboard/ad-grants/apply`;
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return trustedOrigins().includes(url.origin) ? candidate : fallback;
  } catch {
    return fallback;
  }
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
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.started",
        entityType: "workflow_run", entityId: runId, metadata: { definition: AD_GRANTS_WORKFLOW },
      });
      return { runId, projectId };
    });
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
        `SELECT id, event_type, title, summary, status, agent_key, created_at, completed_at
         FROM workspace_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
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

      const oauthConnection = await loadActiveOAuthConnection(client, req.orgId!);

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
        googleOAuth: oauthConnection
          ? { connected: true, email: oauthConnection.email, name: oauthConnection.name, avatarUrl: oauthConnection.avatarUrl }
          : { connected: false, email: null, name: null, avatarUrl: null },
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

  // ---- revoke --------------------------------------------------------------

  app.delete("/v1/orgs/:orgId/ad-grants/google-session", async (req) => {
    ctx.requireRole(req, "admin");
    const revoked = await ctx.inOrg(req, (client) => revokeGoogleSession(client, req.orgId!, req.userId!));
    if (!revoked) throw new HttpError(404, "No active Google session to revoke");
    return { ok: true };
  });

  // ---- Google OAuth: identity + permitted API access ----------------------
  // Structurally separate from google-connect above: this is a standard
  // OAuth 2.0 grant used to show a connected profile and (later) mint
  // short-lived API access tokens for the agent — it is never treated as a
  // substitute for the interactive browser login Google itself requires.

  app.get("/v1/orgs/:orgId/ad-grants/google-oauth/start", async (req, reply) => {
    ctx.requireRole(req, "member");
    const config = loadOAuthConfig();
    if (!config) throw new HttpError(503, "Google sign-in isn't configured yet");
    const redirectTo = resolveRedirectTarget((req.query as { redirectTo?: string }).redirectTo);
    const authUrl = await ctx.inOrg(req, (client) =>
      startGoogleOAuth(client, config, { tenantId: req.orgId!, userId: req.userId!, redirectTo })
    );
    return reply.send({ authUrl });
  });

  // Top-level (not /v1/orgs/:orgId/...): Google redirects the browser here
  // as a plain top-level navigation, before any org context is resolvable
  // from the URL — identity comes entirely from the single-use `state` row,
  // same reasoning as the google-connect WebSocket route. Exempted from
  // session auth in app.ts's preHandler for the same reason.
  app.get("/v1/ad-grants/google-oauth/callback", async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const fallback = resolveRedirectTarget(undefined);
    if (error || !code || !state) {
      return reply.redirect(`${fallback}?google_oauth=error`);
    }
    const redeemed = await redeemOAuthState(ctx.deps.adminPool, state);
    if (!redeemed) return reply.redirect(`${fallback}?google_oauth=error`);
    const redirectTo = resolveRedirectTarget(redeemed.redirectTo ?? undefined);
    const config = loadOAuthConfig();
    if (!config) return reply.redirect(`${redirectTo}?google_oauth=error`);

    try {
      const identity = await exchangeGoogleCode(config, code, redeemed.codeVerifier);
      await withContext(ctx.deps.appPool, { tenantId: redeemed.tenantId, userId: redeemed.userId }, (client) =>
        saveOAuthConnection(client, { tenantId: redeemed.tenantId, connectedBy: redeemed.userId, identity })
      );
      return reply.redirect(`${redirectTo}?google_oauth=connected`);
    } catch (err) {
      req.log.error({ err }, "google oauth callback failed");
      return reply.redirect(`${redirectTo}?google_oauth=error`);
    }
  });

  app.delete("/v1/orgs/:orgId/ad-grants/google-oauth", async (req) => {
    ctx.requireRole(req, "admin");
    const revoked = await ctx.inOrg(req, (client) => revokeOAuthConnection(client, req.orgId!, req.userId!));
    if (!revoked) throw new HttpError(404, "No connected Google account to disconnect");
    return { ok: true };
  });

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
      const oauth = await loadActiveOAuthConnection(client, req.orgId!);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "ad_grants.authorized",
        entityType: "workflow_run", entityId: run.rows[0].id,
        metadata: { googleOAuthConnectionId: oauth?.id ?? null },
      });
      return { ok: true };
    });
  });
}
