import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
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
import { registerChatRoutes } from "./routes-chat.js";
import { registerHuddleRoutes } from "./routes-huddle.js";
import { registerGcpRoutes } from "./routes-gcp.js";
import { registerRtc } from "./rtc.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    orgId: string | null;
    orgRole: OrgRole | null;
  }
}

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
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: PINO_REDACT_PATHS, censor: "[REDACTED]" },
    },
    bodyLimit: 15_000_000,
  });

  // Desktop clients: Vite dev server and the Tauri webview origins.
  const corsOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:5173,tauri://localhost,http://tauri.localhost"
  ).split(",");
  void app.register(cors, { origin: corsOrigins, credentials: false });

  app.decorateRequest("userId", null);
  app.decorateRequest("orgId", null);
  app.decorateRequest("orgRole", null);

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
    if (url.startsWith("/v1/auth/") || url === "/healthz" || url.startsWith("/v1/rtc")) return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
    const tokenHash = hashSessionToken(header.slice("Bearer ".length));
    const { rows } = await deps.appPool.query(
      `SELECT s.user_id FROM sessions s
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash]
    );
    if (!rows[0]) throw new HttpError(401, "Invalid or expired session");
    req.userId = rows[0].user_id;

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
      if (!req.orgId || !req.userId) throw new HttpError(404, "Organization not found");
      return withContext(deps.appPool, { tenantId: req.orgId, userId: req.userId }, fn);
    },
    requireRole(req, minimum) {
      if (!req.orgRole || !roleAtLeast(req.orgRole, minimum)) {
        throw new HttpError(403, `This action requires the ${minimum} role or higher`);
      }
    },
  };

  app.get("/healthz", async () => ({ ok: true }));
  registerCoreRoutes(app, ctx);
  registerGrantRoutes(app, ctx);
  registerGrantFullRoutes(app, ctx);
  registerWebsiteRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerHuddleRoutes(app, ctx);
  registerGcpRoutes(app, ctx);
  registerRtc(app, ctx);
  return app;
}
