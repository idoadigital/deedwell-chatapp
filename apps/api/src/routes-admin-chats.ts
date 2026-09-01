import type { FastifyInstance } from "fastify";
import { audit, withContext } from "@deedwell/database";
import type { AppContext } from "./app.js";

/**
 * Cross-tenant chat monitoring — reading another org's private
 * conversations is sensitive, so every message read is logged into that
 * org's own audit trail (never a silent cross-tenant read), same
 * transparency principle as the Google sign-in intervention.
 */
export function registerAdminChatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/chats/orgs", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT o.id AS org_id, o.name AS org_name,
              (SELECT max(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.tenant_id = o.id) AS last_message_at
       FROM organizations o
       WHERE EXISTS (SELECT 1 FROM channels c WHERE c.tenant_id = o.id)
       ORDER BY last_message_at DESC NULLS LAST`
    );
    return { organizations: rows };
  });

  app.get("/v1/admin/chats/orgs/:orgId/channels", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT c.id, c.name, c.kind, c.agent_key,
              (SELECT max(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at
       FROM channels c WHERE c.tenant_id = $1 ORDER BY last_message_at DESC NULLS LAST`,
      [orgId]
    );
    return { channels: rows };
  });

  app.get("/v1/admin/chats/orgs/:orgId/channels/:channelId/messages", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { orgId, channelId } = req.params as { orgId: string; channelId: string };
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT id, author_kind, author_user, author_agent, body, created_at
       FROM messages WHERE tenant_id = $1 AND channel_id = $2 ORDER BY created_at ASC LIMIT 500`,
      [orgId, channelId]
    );
    await withContext(ctx.deps.appPool, { tenantId: orgId, userId: req.userId }, (client) =>
      audit(client, {
        tenantId: orgId, actorUser: req.userId, action: "admin.chat_viewed",
        entityType: "channel", entityId: channelId, metadata: {},
      })
    );
    return { messages: rows };
  });
}
