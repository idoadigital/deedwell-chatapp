import type { FastifyInstance } from "fastify";
import { HttpError, type AppContext } from "./app.js";
import { TEAMMATES, teammateByKey } from "./teammates.js";

/**
 * AI teammate profiles: who they are, what they are for, and what they have
 * actually done in this organisation. Identity comes from the teammate
 * roster (a constant); history is read from the tables that already record
 * agent work — workspace events (workflow steps with an agent on them),
 * artifact versions they wrote, huddle transcript turns, and the messages
 * they posted. Nothing here is invented: an agent with no history shows an
 * empty history.
 */

const HISTORY_LIMIT = 60;

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The roster with per-organisation activity counts. */
  app.get("/v1/orgs/:orgId/agents", async (req) => {
    ctx.requireRole(req, "viewer");
    const counts = await ctx.inOrg(req, async (client) => {
      const [messages, events, versions] = await Promise.all([
        client.query("SELECT author_agent AS agent, count(*)::int AS n, max(created_at) AS last FROM messages WHERE author_kind = 'agent' GROUP BY 1"),
        client.query("SELECT agent_key AS agent, count(*)::int AS n, max(created_at) AS last FROM workspace_events WHERE agent_key IS NOT NULL GROUP BY 1"),
        client.query("SELECT created_by_agent AS agent, count(*)::int AS n, max(created_at) AS last FROM artifact_versions WHERE created_by_kind = 'agent' GROUP BY 1"),
      ]);
      const by = new Map<string, { messages: number; events: number; artifacts: number; last: string | null }>();
      const bump = (rows: Array<{ agent: string; n: number; last: string }>, field: "messages" | "events" | "artifacts") => {
        for (const r of rows) {
          const cur = by.get(r.agent) ?? { messages: 0, events: 0, artifacts: 0, last: null };
          cur[field] += r.n;
          if (!cur.last || (r.last && r.last > cur.last)) cur.last = r.last;
          by.set(r.agent, cur);
        }
      };
      bump(messages.rows, "messages"); bump(events.rows, "events"); bump(versions.rows, "artifacts");
      return by;
    });
    return {
      agents: TEAMMATES.map((t) => ({
        agentKey: t.agentKey, name: t.name, role: t.role, team: t.team, bio: t.bio, skills: t.skills,
        activity: counts.get(t.agentKey) ?? { messages: 0, events: 0, artifacts: 0, last: null },
      })),
    };
  });

  /** One teammate: profile, numbers, the DM channel, and a work history. */
  app.get("/v1/orgs/:orgId/agents/:agentKey", async (req) => {
    ctx.requireRole(req, "viewer");
    const { agentKey } = req.params as { agentKey: string };
    const mate = teammateByKey.get(agentKey);
    if (!mate) throw new HttpError(404, "No teammate with that key");

    const data = await ctx.inOrg(req, async (client) => {
      const [dm, stats, events, versions, huddles, messages] = await Promise.all([
        client.query("SELECT id FROM channels WHERE kind = 'dm' AND agent_key = $1 LIMIT 1", [agentKey]),
        client.query(
          `SELECT
             (SELECT count(*)::int FROM messages WHERE author_kind = 'agent' AND author_agent = $1) AS messages,
             (SELECT count(*)::int FROM workspace_events WHERE agent_key = $1) AS events,
             (SELECT count(*)::int FROM workspace_events WHERE agent_key = $1 AND status = 'completed') AS completed,
             (SELECT count(*)::int FROM artifact_versions WHERE created_by_kind = 'agent' AND created_by_agent = $1) AS artifacts,
             (SELECT count(DISTINCT huddle_id)::int FROM transcript_segments WHERE speaker_kind = 'agent' AND speaker_agent = $1) AS huddles,
             (SELECT min(created_at) FROM messages WHERE author_kind = 'agent' AND author_agent = $1) AS first_seen,
             (SELECT max(created_at) FROM messages WHERE author_kind = 'agent' AND author_agent = $1) AS last_seen`,
          [agentKey]
        ),
        client.query(
          `SELECT e.id, e.event_type, e.title, e.summary, e.status, e.created_at, e.completed_at, e.artifact_id,
                  e.project_id, p.name AS project_name
             FROM workspace_events e LEFT JOIN projects p ON p.id = e.project_id
            WHERE e.agent_key = $1 ORDER BY e.created_at DESC LIMIT $2`,
          [agentKey, HISTORY_LIMIT]
        ),
        client.query(
          `SELECT v.id, v.version, v.change_summary, v.created_at, a.id AS artifact_id, a.title, a.type, a.project_id, p.name AS project_name
             FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id LEFT JOIN projects p ON p.id = a.project_id
            WHERE v.created_by_kind = 'agent' AND v.created_by_agent = $1 ORDER BY v.created_at DESC LIMIT $2`,
          [agentKey, HISTORY_LIMIT]
        ),
        client.query(
          `SELECT h.id, h.channel_id, c.name AS channel_name, h.started_at, h.ended_at, count(s.id)::int AS turns
             FROM transcript_segments s JOIN huddles h ON h.id = s.huddle_id JOIN channels c ON c.id = h.channel_id
            WHERE s.speaker_kind = 'agent' AND s.speaker_agent = $1
            GROUP BY h.id, h.channel_id, c.name, h.started_at, h.ended_at ORDER BY h.started_at DESC LIMIT 20`,
          [agentKey]
        ),
        client.query(
          `SELECT m.id, m.channel_id, c.name AS channel_name, left(m.body, 240) AS excerpt, m.created_at
             FROM messages m JOIN channels c ON c.id = m.channel_id
            WHERE m.author_kind = 'agent' AND m.author_agent = $1 ORDER BY m.created_at DESC LIMIT 30`,
          [agentKey]
        ),
      ]);
      return { dm: dm.rows[0]?.id ?? null, stats: stats.rows[0], events: events.rows, versions: versions.rows, huddles: huddles.rows, messages: messages.rows };
    });

    // One timeline, newest first, each entry saying what kind of work it was.
    type Entry = { kind: "step" | "artifact" | "huddle" | "message"; at: string; title: string; detail: string; status?: string; projectId?: string | null; projectName?: string | null; channelId?: string | null; artifactId?: string | null };
    const timeline: Entry[] = [
      ...data.events.map((e) => ({ kind: "step" as const, at: e.created_at, title: e.title, detail: e.summary, status: e.status, projectId: e.project_id, projectName: e.project_name, artifactId: e.artifact_id })),
      ...data.versions.map((v) => ({ kind: "artifact" as const, at: v.created_at, title: `${v.title} · v${v.version}`, detail: v.change_summary, projectId: v.project_id, projectName: v.project_name, artifactId: v.artifact_id })),
      ...data.huddles.map((h) => ({ kind: "huddle" as const, at: h.started_at, title: `Huddle in #${h.channel_name}`, detail: `${h.turns} turn${h.turns === 1 ? "" : "s"}${h.ended_at ? "" : " · still open"}`, channelId: h.channel_id })),
      ...data.messages.map((m) => ({ kind: "message" as const, at: m.created_at, title: `In #${m.channel_name}`, detail: m.excerpt, channelId: m.channel_id })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, HISTORY_LIMIT);

    return {
      agent: { agentKey: mate.agentKey, name: mate.name, role: mate.role, team: mate.team, bio: mate.bio, skills: mate.skills },
      dmChannelId: data.dm,
      stats: data.stats,
      timeline,
    };
  });
}
