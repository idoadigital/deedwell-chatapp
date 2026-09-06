import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProactiveProposalInput } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";
import { onChannelRead, proposeProactiveMessage } from "./proactive/candidates.js";
import { loadProactivePolicy, PROACTIVE_SETTINGS_KEY, ProactivePolicy, ProactivePrefs } from "./proactive/policy.js";
import { recordHeartbeat } from "./proactive/presence.js";
import { logEvent } from "./proactive/store.js";
import { teammateByKey } from "./teammates.js";

/** Presence, per-channel read state, proactive notifications, preferences,
 *  and the Platform Admin policy — the HTTP surface of proactive messaging.
 *  Delivery itself has no route: only the orchestrator writes messages. */
export function registerProactiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.post("/v1/orgs/:orgId/presence", async (req) => {
    ctx.requireRole(req, "viewer");
    const { state } = z.object({ state: z.enum(["active", "idle", "offline"]) }).parse(req.body ?? {});
    await ctx.inOrg(req, (client) => recordHeartbeat(client, req.orgId!, req.userId!, state));
    return { ok: true };
  });

  app.post("/v1/orgs/:orgId/channels/:channelId/read", async (req) => {
    ctx.requireRole(req, "viewer");
    const { channelId } = req.params as { channelId: string };
    await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT id FROM channels WHERE id = $1", [channelId]);
      if (!rows[0]) throw new HttpError(404, "Channel not found");
      await onChannelRead(client, { tenantId: req.orgId!, userId: req.userId!, channelId });
    });
    return { ok: true };
  });

  /** Unread message counts per channel for this user. A channel never opened
   *  counts from the membership's start, not from the beginning of time. */
  app.get("/v1/orgs/:orgId/channels/unread", async (req) => {
    ctx.requireRole(req, "viewer");
    const rows = await ctx.inOrg(req, async (client) => (await client.query(
      `SELECT m.channel_id, COUNT(*)::int AS unread,
              COUNT(*) FILTER (WHERE m.metadata->>'proactive' = 'true')::int AS proactive
         FROM messages m
         LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = $2 AND r.tenant_id = $1
         JOIN organization_memberships om ON om.tenant_id = $1 AND om.user_id = $2
        WHERE m.tenant_id = $1 AND m.author_kind <> 'system' AND m.deleted_at IS NULL
          AND (m.author_user IS NULL OR m.author_user <> $2)
          AND m.created_at > COALESCE(r.last_read_at, om.created_at)
        GROUP BY m.channel_id`,
      [req.orgId, req.userId]
    )).rows);
    return { unread: Object.fromEntries(rows.map((r) => [r.channel_id, { count: r.unread, proactive: r.proactive }])) };
  });

  /** Proactive messages as notification items: agent, summary, time, read
   *  state, and a deep link to the message. Merged into the bell by the
   *  existing notifications route. */
  app.get("/v1/orgs/:orgId/proactive/notifications", async (req) => {
    ctx.requireRole(req, "viewer");
    const items = await ctx.inOrg(req, (client) => proactiveNotificationItems(client, req.orgId!, req.userId!));
    return { items };
  });

  app.post("/v1/orgs/:orgId/proactive/candidates/:id/read", async (req) => {
    ctx.requireRole(req, "viewer");
    const { id } = req.params as { id: string };
    await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `UPDATE proactive_candidates SET read_at = COALESCE(read_at, now()), status = CASE WHEN status = 'delivered' THEN 'read' ELSE status END
          WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, req.userId]
      );
      if (!rows[0]) throw new HttpError(404, "Not found");
      await logEvent(client, req.orgId!, id, "notification_opened");
    });
    return { ok: true };
  });

  app.get("/v1/orgs/:orgId/proactive/prefs", async (req) => {
    ctx.requireRole(req, "viewer");
    const row = await ctx.inOrg(req, async (client) =>
      (await client.query("SELECT proactive_prefs FROM organization_memberships WHERE tenant_id = $1 AND user_id = $2", [req.orgId, req.userId])).rows[0]);
    const parsed = ProactivePrefs.safeParse(row?.proactive_prefs ?? {});
    return { prefs: parsed.success ? parsed.data : {} };
  });

  app.put("/v1/orgs/:orgId/proactive/prefs", async (req) => {
    ctx.requireRole(req, "viewer");
    const prefs = ProactivePrefs.parse(req.body ?? {});
    await ctx.inOrg(req, (client) =>
      client.query("UPDATE organization_memberships SET proactive_prefs = $3 WHERE tenant_id = $1 AND user_id = $2", [req.orgId, req.userId, JSON.stringify(prefs)]));
    return { prefs };
  });

  /** For agents that run outside this process (the GCP platform, future
   *  services): the same proposal tool, never a send. */
  app.post("/v1/orgs/:orgId/proactive/propose", async (req) => {
    ctx.requireRole(req, "member");
    const input = ProactiveProposalInput.parse({ ...(req.body as object), userId: (req.body as { userId?: string })?.userId ?? req.userId });
    return proposeProactiveMessage(deps, req.orgId!, input);
  });

  // ---- Platform Admin: policy + observability -------------------------------

  app.get("/v1/admin/proactive/settings", async (req) => {
    ctx.requirePlatformAdmin(req);
    return { settings: await loadProactivePolicy(deps.adminPool), defaults: ProactivePolicy.parse({}) };
  });

  app.put("/v1/admin/proactive/settings", async (req) => {
    ctx.requirePlatformAdmin(req);
    const settings = ProactivePolicy.parse(req.body ?? {});
    await deps.adminPool.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [PROACTIVE_SETTINGS_KEY, JSON.stringify(settings), req.userId]
    );
    return { settings };
  });

  app.get("/v1/admin/proactive/stats", async (req) => {
    ctx.requirePlatformAdmin(req);
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days ?? 7)));
    const since = new Date(Date.now() - days * 86400_000);
    const [byStatus, byReason, byAgent, byType, response, recent] = await Promise.all([
      deps.adminPool.query("SELECT status, COUNT(*)::int AS n FROM proactive_candidates WHERE created_at > $1 GROUP BY status", [since]),
      deps.adminPool.query("SELECT COALESCE(reason, '') AS reason, COUNT(*)::int AS n FROM proactive_log WHERE event = 'suppressed' AND created_at > $1 GROUP BY 1 ORDER BY n DESC LIMIT 12", [since]),
      deps.adminPool.query(
        `SELECT agent_key, COUNT(*)::int AS proposed, COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
                COUNT(*) FILTER (WHERE responded_at IS NOT NULL)::int AS responded, COUNT(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
           FROM proactive_candidates WHERE created_at > $1 GROUP BY agent_key ORDER BY proposed DESC`, [since]),
      deps.adminPool.query("SELECT type, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered FROM proactive_candidates WHERE created_at > $1 GROUP BY type", [since]),
      deps.adminPool.query(
        `SELECT COUNT(*)::int AS delivered, COUNT(*) FILTER (WHERE read_at IS NOT NULL)::int AS read, COUNT(*) FILTER (WHERE responded_at IS NOT NULL)::int AS responded,
                COUNT(*) FILTER (WHERE notified)::int AS notified,
                ROUND(AVG(EXTRACT(EPOCH FROM (responded_at - delivered_at)) / 60) FILTER (WHERE responded_at IS NOT NULL))::int AS median_minutes_to_response
           FROM proactive_candidates WHERE delivered_at > $1 AND combined_into IS NULL`, [since]),
      deps.adminPool.query(
        `SELECT c.id, c.tenant_id, o.name AS org_name, c.agent_key, c.type, c.status, c.score, c.reason, c.decision, c.created_at, c.delivered_at, c.responded_at, c.notified
           FROM proactive_candidates c JOIN organizations o ON o.id = c.tenant_id WHERE c.created_at > $1 ORDER BY c.created_at DESC LIMIT 50`, [since]),
    ]);
    return {
      days, byStatus: byStatus.rows, suppressionReasons: byReason.rows,
      byAgent: byAgent.rows.map((r) => ({ ...r, agentName: teammateByKey.get(r.agent_key)?.name ?? r.agent_key })),
      byType: byType.rows, response: response.rows[0], recent: recent.rows,
    };
  });
}

export async function proactiveNotificationItems(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> }, tenantId: string, userId: string) {
  const { rows } = await client.query(
    `SELECT c.id, c.agent_key, c.type, c.reason, c.proposed_message, c.metadata, c.channel_id, c.delivered_message_id, c.delivered_at, c.read_at, c.responded_at, c.notified,
            ch.name AS channel_name, ch.key AS channel_key
       FROM proactive_candidates c LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.tenant_id = $1 AND c.user_id = $2 AND c.delivered_at IS NOT NULL AND c.combined_into IS NULL
        AND c.delivered_at > now() - interval '14 days' AND c.responded_at IS NULL
      ORDER BY c.delivered_at DESC LIMIT 20`,
    [tenantId, userId]
  );
  return rows.map((r) => {
    const mate = teammateByKey.get(r.agent_key);
    const summary: string = r.metadata?.summary ?? r.proposed_message ?? r.reason;
    return {
      id: `proactive:${r.id}`, kind: "proactive", candidateId: r.id, agentKey: r.agent_key, agentName: mate?.name ?? r.agent_key.split(".").pop()?.replace(/_/g, " ") ?? "Deedwell AI",
      title: `${mate?.name ?? "Deedwell AI"}${r.channel_name && r.channel_name !== mate?.name ? ` · ${r.channel_name}` : ""}`, detail: String(summary).slice(0, 160),
      href: r.channel_id ? `/dashboard/chat?channel=${r.channel_id}${r.delivered_message_id ? `&message=${r.delivered_message_id}` : ""}` : "/dashboard/chat",
      channelId: r.channel_id, messageId: r.delivered_message_id, createdAt: r.delivered_at, read: Boolean(r.read_at), type: r.type,
    };
  });
}
