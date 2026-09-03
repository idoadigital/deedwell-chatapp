import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { hashSessionToken, roleAtLeast } from "@deedwell/auth";
import { withContext, type PoolClient } from "@deedwell/database";
import { PINO_REDACT_PATHS } from "@deedwell/observability";
import type { OrgRole } from "@deedwell/schemas";
import type { Deps } from "./bootstrap.js";
import { registerCoreRoutes } from "./routes-core.js";
import { registerGrantRoutes } from "./routes-grant.js";
import { registerGrantFullRoutes } from "./routes-grants-full.js";
import { registerWebsiteRoutes } from "./routes-website.js";
import { registerContentRoutes, registerContentPublishingRoutes } from "./routes-content.js";
import { registerConnectorRoutes } from "./routes-connectors.js";
import { registerAdminIntegrationRoutes } from "./routes-admin-integrations.js";
import { registerDataDeletionRoutes } from "./routes-data-deletion.js";
import { registerPublicRoutes } from "./routes-public.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAdminAdGrantsRoutes } from "./routes-admin-ad-grants.js";
import { registerAdminSupportRoutes } from "./routes-admin-support.js";
import { registerAdminUsersRoutes } from "./routes-admin-users.js";
import { registerAdminGrantsRoutes } from "./routes-admin-grants.js";
import { registerAdminWebsitesRoutes } from "./routes-admin-websites.js";
import { registerAdminChatsRoutes } from "./routes-admin-chats.js";
import { registerAdminAnalyticsRoutes } from "./routes-admin-analytics.js";
import { registerChatRoutes } from "./routes-chat.js";
import { registerHuddleRoutes } from "./routes-huddle.js";
import { registerGcpRoutes } from "./routes-gcp.js";
import { registerAdGrantsRoutes } from "./routes-ad-grants.js";
import { registerAdGrantsConnectWs } from "./ad-grants-connect-ws.js";
import { registerBillingRoutes } from "./routes-billing.js";
import { registerRtc } from "./rtc.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    orgId: string | null;
    orgRole: OrgRole | null;
    apiKeyScopes: string[] | null;
    isPlatformAdmin: boolean;
  }
}

/** Shared across every *.deedwell.org origin — see routes-core.ts for where it's set. */
export const SESSION_COOKIE_NAME = "deedwell_session";

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface AppContext {
  deps: Deps;
  /** Run `fn` in a tenant-scoped transaction for the request's org. */
  inOrg<T>(req: FastifyRequest, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  requireRole(req: FastifyRequest, minimum: OrgRole): void;
  requireApiScope(req: FastifyRequest, scope: string): void;
  requirePlatformAdmin(req: FastifyRequest): void;
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: PINO_REDACT_PATHS, censor: "[REDACTED]" },
    },
    bodyLimit: 15_000_000,
  });

  // Desktop clients: Vite dev server and the Tauri webview origins. Also the
  // marketing site (deedwell.org) posting to /v1/auth/* cross-origin — that
  // login exchange is what plants the shared session cookie, so credentials
  // must be allowed and the origin list can't be a wildcard.
  const corsOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:5173,tauri://localhost,http://tauri.localhost"
  ).split(",");
  void app.register(cors, { origin: corsOrigins, credentials: true });
  void app.register(cookie);

  app.decorateRequest("userId", null);
  app.decorateRequest("orgId", null);
  app.decorateRequest("orgRole", null);
  app.decorateRequest("apiKeyScopes", null);
  app.decorateRequest("isPlatformAdmin", false);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Invalid input", details: err.issues.slice(0, 10) });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "Internal error" });
  });

  // ---- authentication -----------------------------------------------------
  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    const url = req.url;
    // Every API route lives under /v1/ (rtc and auth are public within
    // that); anything else is the static SPA shell (coworkers.deedwell.org
    // serves apps/desktop's build from this same app) or /healthz — public
    // by nature, since the SPA itself is what shows the login screen.
    if (
      !url.startsWith("/v1/") || url.startsWith("/v1/auth/") || url.startsWith("/v1/rtc") ||
      url.startsWith("/v1/ad-grants/google-connect") || url.startsWith("/v1/ad-grants/google-oauth/callback") ||
      url.startsWith("/v1/billing/stripe/webhook") ||
      // Provider-initiated: the OAuth redirect and Meta's data-deletion
      // callback arrive without a session. Both are authenticated by their own
      // means (single-use state / HMAC signature) rather than by a cookie.
      // Tenant connector routes live under /v1/orgs/ and are unaffected.
      url.startsWith("/v1/connectors/")
    ) return;

    const header = req.headers.authorization;
    const bearerToken = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

    // Public API keys are a distinct credential class from session tokens:
    // dw_live_-prefixed, platform-wide (not tied to any one org or user),
    // and only accepted on /v1/public/* routes. There's deliberately no
    // per-org scoping here — a key is provisioned by a platform admin (see
    // routes-admin.ts) for one external integration that reads across every
    // nonprofit's website data, not a credential a nonprofit holds itself.
    if (bearerToken?.startsWith("dw_live_")) {
      if (!url.startsWith("/v1/public/")) throw new HttpError(401, "Authentication required");
      const keyHash = hashSessionToken(bearerToken);
      const { rows } = await deps.appPool.query(
        `SELECT scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
        [keyHash]
      );
      if (!rows[0]) throw new HttpError(401, "Invalid or revoked API key");
      req.apiKeyScopes = rows[0].scopes;
      void deps.appPool.query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [keyHash]);
      return;
    }
    if (url.startsWith("/v1/public/")) throw new HttpError(401, "Authentication required");

    // Some reverse proxies (e.g. Google Cloud Shell's web preview) intercept
    // or strip the Authorization header for their own auth. x-deedwell-token
    // carries the same bearer token through those environments. The session
    // cookie is a third, equally valid credential: it's what lets a login on
    // deedwell.org carry over to coworkers.deedwell.org automatically.
    const altToken = req.headers["x-deedwell-token"];
    const token = bearerToken ?? (typeof altToken === "string" ? altToken : req.cookies[SESSION_COOKIE_NAME]);
    if (!token) throw new HttpError(401, "Authentication required");
    const tokenHash = hashSessionToken(token);
    const { rows } = await deps.appPool.query(
      `SELECT s.user_id FROM sessions s
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash]
    );
    if (!rows[0]) throw new HttpError(401, "Invalid or expired session");
    req.userId = rows[0].user_id;

    // Platform admin: a user-level flag, unrelated to any org membership —
    // gates /v1/admin/* (API key + webhook management for the platform-wide
    // developer API, routes-admin.ts). Loaded only for that namespace so
    // every other authenticated request doesn't pay for an extra query.
    if (url.startsWith("/v1/admin/")) {
      const admin = await deps.appPool.query(
        "SELECT is_platform_admin FROM users WHERE id = $1",
        [req.userId]
      );
      req.isPlatformAdmin = admin.rows[0]?.is_platform_admin === true;
    }

    // Org scoping for /v1/orgs/:orgId/... routes. Membership is checked here
    // (API layer); RLS enforces it again at the database layer.
    const orgMatch = url.match(/^\/v1\/orgs\/([0-9a-f-]{36})(\/|\?|$)/);
    if (orgMatch) {
      const orgId = orgMatch[1]!;
      const membership = await withContext(
        deps.appPool,
        { tenantId: orgId, userId: req.userId },
        (client) =>
          client.query(
            "SELECT role FROM organization_memberships WHERE tenant_id = $1 AND user_id = $2",
            [orgId, req.userId]
          )
      );
      if (!membership.rows[0]) throw new HttpError(404, "Organization not found");
      req.orgId = orgId;
      req.orgRole = membership.rows[0].role;
    }
  });

  const ctx: AppContext = {
    deps,
    inOrg(req, fn) {
      // userId is intentionally not required here: an API-key-authenticated
      // public request resolves req.orgId with no user behind it at all
      // (see the preHandler above), and still needs the same tenant-scoped
      // transaction session-authenticated routes use.
      if (!req.orgId) throw new HttpError(404, "Organization not found");
      return withContext(deps.appPool, { tenantId: req.orgId, userId: req.userId }, fn);
    },
    requireRole(req, minimum) {
      if (!req.orgRole || !roleAtLeast(req.orgRole, minimum)) {
        throw new HttpError(403, `This action requires the ${minimum} role or higher`);
      }
    },
    requireApiScope(req, scope) {
      if (!req.apiKeyScopes?.includes(scope)) {
        throw new HttpError(403, `This API key does not have the "${scope}" scope`);
      }
    },
    requirePlatformAdmin(req) {
      if (!req.isPlatformAdmin) throw new HttpError(403, "Platform admin access required");
    },
  };

  app.get("/healthz", async () => ({ ok: true }));
  registerCoreRoutes(app, ctx);
  registerGrantRoutes(app, ctx);
  registerGrantFullRoutes(app, ctx);
  registerWebsiteRoutes(app, ctx);
  registerContentRoutes(app, ctx);
  registerContentPublishingRoutes(app, ctx);
  registerConnectorRoutes(app, ctx);
  registerAdminIntegrationRoutes(app, ctx);
  registerDataDeletionRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerAdminAdGrantsRoutes(app, ctx);
  registerAdminSupportRoutes(app, ctx);
  registerAdminUsersRoutes(app, ctx);
  registerAdminGrantsRoutes(app, ctx);
  registerAdminWebsitesRoutes(app, ctx);
  registerAdminChatsRoutes(app, ctx);
  registerAdminAnalyticsRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerHuddleRoutes(app, ctx);
  registerGcpRoutes(app, ctx);
  registerAdGrantsRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerRtc(app, ctx);
  registerAdGrantsConnectWs(app, ctx);

  // coworkers.deedwell.org is this same origin: the chat app's built static
  // assets ship alongside the API so there's no CORS boundary between them
  // and the session cookie applies to both without any extra wiring. Only
  // present once apps/desktop has actually been built (the production
  // Docker image does this; plain local dev serves the desktop app itself
  // via `pnpm dev` instead, so this is a no-op there).
  const desktopDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "dist");
  if (existsSync(desktopDist)) {
    void app.register(fastifyStatic, { root: desktopDist, prefix: "/", decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/v1/")) return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
