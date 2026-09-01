import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { uuidv7 } from "@deedwell/database";
import { HttpError, type AppContext } from "./app.js";

async function findOrCreateThread(pool: Pool, tenantId: string): Promise<string> {
  const existing = await pool.query(`SELECT id FROM support_threads WHERE tenant_id = $1`, [tenantId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = uuidv7();
  await pool.query(
    `INSERT INTO support_threads (id, tenant_id) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING`,
    [id, tenantId]
  );
  const row = await pool.query(`SELECT id FROM support_threads WHERE tenant_id = $1`, [tenantId]);
  return row.rows[0].id;
}

/**
 * Platform-admin side of the admin<->org support channel — cross-tenant by
 * nature, so every query goes through ctx.deps.adminPool directly (same
 * reasoning as routes-admin-ad-grants.ts). The org-facing side lives in
 * routes-core.ts, tenant-scoped through the normal ctx.inOrg path.
 */
export function registerAdminSupportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/support/threads", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT o.id AS org_id, o.name AS org_name, t.id AS thread_id,
              (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT max(created_at) FROM support_messages m WHERE m.thread_id = t.id) AS last_message_at,
              (SELECT count(*)::int FROM support_messages m
               WHERE m.thread_id = t.id AND m.author_kind = 'org_user'
                 AND m.created_at > coalesce(
                   (SELECT max(created_at) FROM support_messages a WHERE a.thread_id = t.id AND a.author_kind = 'platform_admin'),
                   '-infinity'
                 )
              ) AS unread_by_admin
       FROM support_threads t JOIN organizations o ON o.id = t.tenant_id
       ORDER BY last_message_at DESC NULLS LAST`
    );
    return { threads: rows };
  });

  app.get("/v1/admin/support/orgs/:orgId/messages", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT m.id, m.author_kind, m.author_user_id, m.body, m.created_at
       FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
       WHERE t.tenant_id = $1 ORDER BY m.created_at ASC`,
      [orgId]
    );
    return { messages: rows };
  });

  app.post("/v1/admin/support/orgs/:orgId/messages", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const { body } = req.body as { body?: string };
    if (!body?.trim()) throw new HttpError(400, "Message body is required");
    const threadId = await findOrCreateThread(ctx.deps.adminPool, orgId);
    const id = uuidv7();
    await ctx.deps.adminPool.query(
      `INSERT INTO support_messages (id, tenant_id, thread_id, author_kind, author_user_id, body)
       VALUES ($1,$2,$3,'platform_admin',$4,$5)`,
      [id, orgId, threadId, req.userId, body.trim()]
    );
    return reply.status(201).send({ id });
  });
}
