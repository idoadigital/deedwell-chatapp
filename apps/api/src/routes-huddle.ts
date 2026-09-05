import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, uuidv7 } from "@deedwell/database";
import { insertMessage } from "./assistant.js";
import { TEAMMATES, teammateByKey } from "./teammates.js";
import { DEFAULT_VOICE, synthesize, voiceEnabled, voiceProvider } from "./tts.js";
import { HttpError, type AppContext } from "./app.js";

/**
 * Huddles (BRD Phase 6): a live voice layer over a channel. Utterances are
 * REAL channel messages (metadata.huddleId), so approvals, workflows, memory,
 * and the bridge all keep working mid-huddle. Maya facilitates; each teammate
 * speaks with their own Kokoro voice; ending posts a summary to the channel.
 */
export function registerHuddleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/orgs/:orgId/huddles", async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = z.object({ channelId: z.string().uuid() }).parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const channel = await client.query(
        `SELECT c.id, c.name, c.kind, c.agent_key, c.project_id, p.type AS project_type
         FROM channels c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
        [input.channelId]
      );
      if (!channel.rows[0]) throw new HttpError(404, "Channel not found");
      const existing = await client.query(
        "SELECT id FROM huddles WHERE channel_id = $1 AND status = 'active'",
        [input.channelId]
      );
      const ch = channel.rows[0];
      if (existing.rows[0]) {
        // Rejoining: the natural team plus anyone brought in since.
        const participants = await huddleParticipants(client, existing.rows[0].id, ch);
        return { huddleId: existing.rows[0].id, resumed: true, participants };
      }

      const huddleId = uuidv7();
      await client.query(
        `INSERT INTO huddles (id, tenant_id, channel_id, started_by) VALUES ($1,$2,$3,$4)`,
        [huddleId, req.orgId, input.channelId, req.userId]
      );
      // Participants: the channel's natural team (spec §9 — huddle includes
      // the agents associated with that conversation).
      const participants = defaultParticipants(ch);

      await insertMessage(client, {
        tenantId: req.orgId!, channelId: input.channelId, authorKind: "agent",
        authorAgent: "core.executive_assistant",
        body: `We're in a huddle. I'll facilitate — speak (or type) and I'll bring in the right teammates. Say "wrap up" when you're done and I'll post the summary and action items here.`,
        metadata: { huddleId, huddleEvent: "started" },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "huddle.started",
        entityType: "huddle", entityId: huddleId, metadata: { channelId: input.channelId },
      });
      return { huddleId, resumed: false, participants };
    });
    ctx.deps.engine.events.emit("event", { type: "message_created", tenantId: req.orgId, channelId: input.channelId } as never);
    return reply.status(201).send({
      ...result,
      voices: voiceEnabled(),
      teammates: TEAMMATES.map((t) => ({ agentKey: t.agentKey, name: t.name, role: t.role })),
    });
  });

  app.post("/v1/orgs/:orgId/huddles/:huddleId/end", async (req) => {
    ctx.requireRole(req, "member");
    const { huddleId } = req.params as { huddleId: string };
    await ctx.inOrg(req, async (client) => {
      const huddle = await client.query(
        "SELECT id, channel_id, started_at FROM huddles WHERE id = $1 AND status = 'active'",
        [huddleId]
      );
      if (!huddle.rows[0]) throw new HttpError(404, "No active huddle with that id");
      const { channel_id, started_at } = huddle.rows[0];

      const spoken = await client.query(
        `SELECT author_kind, author_agent, body FROM messages
         WHERE channel_id = $1 AND metadata->>'huddleId' = $2 AND metadata->>'huddleEvent' IS NULL
         ORDER BY created_at`,
        [channel_id, huddleId]
      );
      const decisions = await client.query(
        `SELECT a.kind, a.status FROM approvals a
         WHERE a.decided_at >= $1 AND a.status <> 'pending'
           AND a.run_id IN (SELECT id FROM workflow_runs WHERE project_id =
             (SELECT project_id FROM channels WHERE id = $2))`,
        [started_at, channel_id]
      );
      const lines = spoken.rows.map((m) => {
        const who = m.author_kind === "user" ? "You" : (teammateByKey.get(m.author_agent)?.name ?? m.author_agent);
        return `• ${who}: ${String(m.body).slice(0, 160)}`;
      });
      const summary = [
        `**Huddle summary** (${spoken.rows.length} exchanges)`,
        ...(decisions.rows.length
          ? [`Decisions made: ${decisions.rows.map((d) => `${d.kind.replace(/_/g, " ")} → ${d.status}`).join(", ")}`]
          : []),
        ``,
        `Transcript:`,
        ...lines.slice(0, 30),
      ].join("\n");

      await client.query(
        "UPDATE huddles SET status = 'ended', ended_at = now(), summary = $2 WHERE id = $1",
        [huddleId, summary]
      );
      await insertMessage(client, {
        tenantId: req.orgId!, channelId: channel_id, authorKind: "agent",
        authorAgent: "core.executive_assistant", body: summary,
        metadata: { huddleId, huddleEvent: "ended" },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "huddle.ended",
        entityType: "huddle", entityId: huddleId, metadata: { exchanges: spoken.rows.length },
      });
    });
    return { ok: true };
  });

  // Agent speech: synthesized server-side with the teammate's own voice.
  app.get("/v1/orgs/:orgId/tts", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const query = z.object({
      agent: z.string().min(1).max(120),
      text: z.string().min(1).max(600),
    }).parse(req.query);
    if (!voiceEnabled()) {
      throw new HttpError(503, "Voice is disabled on this server (VOICE_PROVIDER=off)");
    }
    const mate = teammateByKey.get(query.agent);
    const voice = mate ? { kokoro: mate.voice, google: mate.googleVoice } : DEFAULT_VOICE;
    try {
      const wav = await synthesize(ctx.deps.storage, voice, query.text);
      return reply
        .type(voiceProvider() === "google" ? "audio/mpeg" : "audio/wav")
        .header("cache-control", "private, max-age=86400")
        .send(wav);
    } catch (err) {
      throw new HttpError(503, err instanceof Error ? err.message : "Voice synthesis failed");
    }
  });
}

/** The teammates a channel's huddle starts with: the DM partner (with Maya
 *  facilitating), the grant team, the website team, or the core four. */
export function defaultParticipants(ch: { kind: string; agent_key: string | null; project_type: string | null }): string[] {
  return ch.kind === "dm"
    ? [...new Set(["core.executive_assistant", ch.agent_key].filter(Boolean) as string[])]
    : ch.project_type === "grant_application"
      ? TEAMMATES.filter((t) => t.team !== "website").map((t) => t.agentKey)
      : ch.project_type === "website"
        ? ["core.executive_assistant", ...TEAMMATES.filter((t) => t.team === "website").map((t) => t.agentKey)]
        : TEAMMATES.slice(0, 4).map((t) => t.agentKey);
}

/** Who is on the call right now: the defaults plus everyone a host has
 *  brought in (recorded as participant_joined events on the huddle). */
export async function huddleParticipants(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  huddleId: string,
  ch: { kind: string; agent_key: string | null; project_type: string | null }
): Promise<string[]> {
  const joined = await client.query(
    "SELECT payload->>'agent' AS agent FROM huddle_events WHERE huddle_id = $1 AND type = 'participant_joined'",
    [huddleId]
  );
  const set = new Set(defaultParticipants(ch));
  for (const row of joined.rows) if (typeof row.agent === "string" && teammateByKey.has(row.agent)) set.add(row.agent);
  return [...set];
}
