import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, tenantFileKey, uuidv7 } from "@deedwell/database";
import { PostMessageInput, UploadFileInput } from "@deedwell/schemas";
import {
  createProjectChannel,
  ensureChannels,
  handleUserMessage,
  type ChannelRow,
} from "./assistant.js";
import { TEAMMATES } from "./teammates.js";
import { HttpError, type AppContext } from "./app.js";
import { resolveInfoRequest } from "./fact-fields.js";

/** The reaction bar. Deliberately short — a fixed set keeps rendering
 *  predictable and stops the column becoming a free-text field. */
export const ALLOWED_REACTIONS = ["👍", "🎉", "❤️", "👀", "✅", "🙏"];

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Cancel a run that hasn't finished (safe: steps are transactional).
  app.post("/v1/orgs/:orgId/runs/:runId/cancel", async (req) => {
    ctx.requireRole(req, "member");
    const { runId } = req.params as { runId: string };
    await ctx.inOrg(req, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE workflow_runs SET status = 'cancelled'
         WHERE id = $1 AND status IN ('pending','running','waiting_for_info','waiting_approval','suspended_budget')`,
        [runId]
      );
      if (!rowCount) throw new HttpError(409, "Run is already finished");
      // The cancel writes workflow_runs directly rather than going through the
      // engine, so attachWorkspaceBridge never fires and any in-progress
      // timeline row would spin forever. Close them here, in the same
      // transaction, so the activity feed reflects what actually happened.
      await client.query(
        `UPDATE workspace_events SET status = 'completed', completed_at = now()
         WHERE run_id = $1 AND status = 'in_progress'`,
        [runId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.cancelled",
        entityType: "workflow_run", entityId: runId, metadata: {},
      });
    });
    return { ok: true };
  });

  // Secure diagnostics (spec §2): component health, no secrets/prompts/content.
  app.get("/v1/diagnostics", async () => {
    const out: Record<string, unknown> = {
      modelProviderConfigured: ctx.deps.provider.name !== "mock",
      modelProvider: ctx.deps.provider.name,
      grantSource: ctx.deps.grantSource.name,
    };
    try {
      await ctx.deps.appPool.query("SELECT 1");
      out.database = "healthy";
    } catch { out.database = "unhealthy"; }
    try {
      const { rows } = await ctx.deps.adminPool.query(
        "SELECT COUNT(*)::int AS n FROM workflow_runs WHERE status IN ('pending','running')"
      );
      out.workflowEngine = "healthy";
      out.activeRuns = rows[0].n;
    } catch { out.workflowEngine = "unhealthy"; }
    if (ctx.deps.provider.name === "openai") {
      try {
        const res = await fetch(
          `${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/models`,
          { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(5000) }
        );
        out.providerConnectivity = res.ok ? "healthy" : `unhealthy (${res.status})`;
      } catch { out.providerConnectivity = "unhealthy (unreachable)"; }
    } else {
      out.providerConnectivity = "n/a (mock)";
    }
    out.realtime = "in-process";
    return out;
  });

  // Everything the workspace shell needs, in ONE round trip / transaction.
  app.get("/v1/orgs/:orgId/workspace", async (req) => {
    ctx.requireRole(req, "viewer");
    const out = await ctx.inOrg(req, async (client) => {
      await ensureChannels(client, req.orgId!);
      const channels = await client.query(
        `SELECT c.id, c.key, c.name, c.kind, c.project_id, c.agent_key, c.starred,
                p.type AS project_type,
                (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at
         FROM channels c LEFT JOIN projects p ON p.id = c.project_id
         ORDER BY c.kind, c.created_at, c.name`
      );
      const runs = await client.query(
        `SELECT r.id, r.project_id, p.name AS project_name, r.definition, r.status,
                r.current_step, r.steps_used, r.step_budget, r.last_error,
                r.state->'waiting' AS waiting, r.created_at, r.updated_at
         FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         ORDER BY r.updated_at DESC LIMIT 100`
      );
      const sites = await client.query(
        `SELECT s.id, s.project_id, p.name AS project_name, s.slug, s.name, s.status,
                s.theme, s.created_at,
                (SELECT version FROM site_releases rr WHERE rr.id = s.preview_release_id) AS preview_version,
                (SELECT version FROM site_releases rr WHERE rr.id = s.active_release_id) AS live_version,
                (SELECT COUNT(*)::int FROM form_submissions fs WHERE fs.site_id = s.id) AS submissions
         FROM sites s JOIN projects p ON p.id = s.project_id ORDER BY s.created_at DESC`
      );
      const members = await client.query(
        `SELECT u.id, u.display_name, u.email, m.role
         FROM organization_memberships m JOIN users u ON u.id = m.user_id ORDER BY u.display_name`
      );
      const projects = await client.query(
        "SELECT id, name, type, status, created_at FROM projects ORDER BY created_at DESC"
      );
      const approvals = await client.query(
        `SELECT a.id, a.run_id, a.kind, a.payload, a.status, a.note, a.created_at,
                p.name AS project_name, r.project_id
         FROM approvals a JOIN workflow_runs r ON r.id = a.run_id
         JOIN projects p ON p.id = r.project_id
         ORDER BY a.created_at DESC LIMIT 100`
      );
      return {
        channels: channels.rows, runs: runs.rows, sites: sites.rows,
        members: members.rows, projects: projects.rows, approvals: approvals.rows,
      };
    });
    return { ...out, teammates: TEAMMATES };
  });

  // Grant application workspace: everything the panel needs in one call —
  // overview, timeline, sources, requirements, eligibility, questions, files.
  app.get("/v1/orgs/:orgId/projects/:projectId/grant-workspace", async (req) => {
    ctx.requireRole(req, "viewer");
    const { projectId } = req.params as { projectId: string };
    return ctx.inOrg(req, async (client) => {
      const project = await client.query(
        `SELECT p.id, p.name, p.type, p.workspace_status, p.workspace_phase, p.pending_intent,
                o.title AS grant_title, o.funder, o.opportunity_number, o.deadline, o.source_url
         FROM projects p
         LEFT JOIN grant_opportunities o ON o.project_id = p.id
         WHERE p.id = $1 ORDER BY o.created_at DESC LIMIT 1`,
        [projectId]
      );
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      const run = await client.query(
        `SELECT id, status, current_step, last_error, definition FROM workflow_runs
         WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [projectId]
      );
      const events = await client.query(
        `SELECT id, run_id, event_type, title, summary, status, agent_key, artifact_id, metadata, error, created_at, completed_at
         FROM workspace_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 60`,
        [projectId]
      );
      const sources = await client.query(
        `SELECT id, url, title, publisher, source_type, reliability, fetch_status, file_id, excerpt, retrieved_at
         FROM research_sources WHERE project_id = $1 ORDER BY retrieved_at DESC LIMIT 30`,
        [projectId]
      );
      const artifacts = await client.query(
        `SELECT id, type, title, current_version, updated_at FROM artifacts
         WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 30`,
        [projectId]
      );
      const matrix = await client.query(
        `SELECT av.content FROM artifacts a
         JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = a.current_version
         WHERE a.project_id = $1 AND a.type = 'compliance_matrix' LIMIT 1`,
        [projectId]
      );
      const eligibility = await client.query(
        `SELECT e.overall, e.rule_findings, e.missing_facts, e.created_at FROM eligibility_results e
         JOIN grant_opportunities o ON o.id = e.opportunity_id
         WHERE o.project_id = $1 ORDER BY e.created_at DESC LIMIT 1`,
        [projectId]
      );
      const files = await client.query(
        `SELECT f.id, f.filename, f.mime, f.size_bytes, f.created_at FROM files f
         JOIN file_links fl ON fl.file_id = f.id
         WHERE fl.project_id = $1 ORDER BY f.created_at DESC LIMIT 30`,
        [projectId]
      );
      // Open questions: whatever the running workflow is genuinely waiting on —
      // missing passport facts for grant work, or the unanswered half of the
      // website design catalog. Resolved in one place (fact-fields) so chat and
      // this panel can never disagree about what is being asked.
      const infoRequest = run.rows[0]
        ? await resolveInfoRequest(client, run.rows[0].id)
        : { fields: [], context: "eligibility", stage: null, allowSkip: false };
      const knownFacts = await client.query(
        `SELECT fact_key, value FROM org_facts WHERE status IN ('user_certified', 'verified')`
      );
      // The site backing this project, if any — drives the Preview tab.
      const site = await client.query(
        `SELECT s.id, s.slug, s.name, s.status,
                (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version,
                (SELECT version FROM site_releases r WHERE r.id = s.active_release_id)  AS live_version
           FROM sites s WHERE s.project_id = $1 LIMIT 1`,
        [projectId]
      );
      const { completionForRun } = await import("./workspace.js");
      const base = {
        project: project.rows[0],
        run: run.rows[0] ?? null,
        completion: run.rows[0]
          ? completionForRun(run.rows[0].current_step, run.rows[0].status, run.rows[0].definition)
          : project.rows[0].pending_intent ? 2 : 5,
        events: events.rows as Array<Record<string, unknown>>,
        sources: sources.rows,
        artifacts: artifacts.rows,
        requirements: (matrix.rows[0]?.content?.requirements ?? []) as Array<Record<string, unknown>>,
        eligibility: eligibility.rows[0] ?? null,
        files: files.rows as Array<Record<string, unknown>>,
        site: site.rows[0] ?? null,
        allowSkip: infoRequest.allowSkip,
        questions: infoRequest.fields.map((field) => ({
          ...field,
          reasonNeeded: field.reason,
          // Website design answers live per-site, not in org_facts, so only
          // passport-backed questions can be prefilled from certified facts.
          prefill: knownFacts.rows.find((f) => f.fact_key === field.key)?.value ?? null,
        })) as Array<Record<string, unknown>>,
        gcp: null as Record<string, unknown> | null,
      };
      // Platform-backed workspace: real persisted state from the grant
      // platform replaces the local workflow's view of this project. The
      // existing tabs read the same fields; extra platform views come from
      // the `gcp` block.
      if (ctx.deps.gcp) {
        const { buildGcpWorkspace, gcpActivityEvents, gcpQuestions } = await import("./gcp/workspace.js");
        const block = await buildGcpWorkspace(ctx.deps, client, { tenantId: req.orgId!, userId: req.userId! }, projectId)
          .catch((err) => {
            console.log(JSON.stringify({ at: "gcp_workspace_failed", projectId, error: String(err instanceof Error ? err.message : err).slice(0, 200) }));
            return null;
          });
        if (block) {
          const readiness = (block.readiness ?? {}) as { percent_complete?: number };
          base.gcp = block as unknown as Record<string, unknown>;
          base.events = gcpActivityEvents(block);
          base.questions = gcpQuestions(block);
          base.requirements = block.requirements.map((r) => ({
            text: r.title, key: r.requirement_key, mandatory: r.is_required !== false,
            sourceLine: (r.source as { quote?: string } | null)?.quote ?? null,
            status: r.status, statusReason: r.status_reason ?? null,
            wordLimit: r.word_limit ?? null,
          }));
          base.files = block.documents.map((d) => ({
            id: d.document_id, filename: d.original_filename,
            mime: String(d.document_type ?? "document").replace(/_/g, " ").toLowerCase(),
            size_bytes: Number(d.size_bytes ?? 0), created_at: d.created_at,
            ingestion_status: d.ingestion_status, fact_count: d.fact_count ?? 0,
          }));
          if (typeof readiness.percent_complete === "number") base.completion = readiness.percent_complete;
        }
      }
      return base;
    });
  });

  app.get("/v1/orgs/:orgId/channels", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, async (client) => {
      await ensureChannels(client, req.orgId!);
      return client.query(
        `SELECT c.id, c.key, c.name, c.kind, c.project_id, c.agent_key, c.starred,
                p.type AS project_type,
                (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_message_at
         FROM channels c LEFT JOIN projects p ON p.id = c.project_id
         ORDER BY c.kind, c.created_at, c.name`
      );
    });
    return { channels: rows, teammates: TEAMMATES };
  });

  app.post("/v1/orgs/:orgId/channels", async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
    const result = await ctx.inOrg(req, (client) =>
      createProjectChannel(client, req.orgId!, req.userId!, input.name, "other")
    );
    return reply.status(201).send(result);
  });

  app.post("/v1/orgs/:orgId/channels/:channelId/star", async (req) => {
    ctx.requireRole(req, "viewer");
    const { channelId } = req.params as { channelId: string };
    const input = z.object({ starred: z.boolean() }).parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const { rowCount } = await client.query(
        "UPDATE channels SET starred = $2 WHERE id = $1", [channelId, input.starred]
      );
      if (!rowCount) throw new HttpError(404, "Channel not found");
    });
    return { ok: true };
  });

  app.get("/v1/orgs/:orgId/members", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT u.id, u.display_name, u.email, m.role
         FROM organization_memberships m JOIN users u ON u.id = m.user_id
         ORDER BY u.display_name`
      )
    );
    return { members: rows };
  });

  // Attach a file inside a conversation. Files land in the channel's project,
  // or in a shared inbox project for DMs and team channels.
  app.post("/v1/orgs/:orgId/channels/:channelId/files", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { channelId } = req.params as { channelId: string };
    const input = UploadFileInput.parse(req.body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0) throw new HttpError(400, "File is empty");
    if (content.length > 8_000_000) throw new HttpError(413, "File exceeds the 8 MB limit");
    const result = await ctx.inOrg(req, async (client) => {
      const channel = await client.query(
        "SELECT id, project_id FROM channels WHERE id = $1", [channelId]
      );
      if (!channel.rows[0]) throw new HttpError(404, "Channel not found");
      let projectId: string | null = channel.rows[0].project_id;
      if (!projectId) {
        const shared = await client.query(
          "SELECT id FROM projects WHERE name = 'Shared Files' LIMIT 1"
        );
        projectId = shared.rows[0]?.id ?? uuidv7();
        if (!shared.rows[0]) {
          await client.query(
            `INSERT INTO projects (id, tenant_id, name, type, created_by)
             VALUES ($1,$2,'Shared Files','other',$3)`,
            [projectId, req.orgId, req.userId]
          );
        }
      }
      const fileId = uuidv7();
      const storageKey = tenantFileKey(req.orgId!, fileId, input.filename);
      await ctx.deps.storage.put(storageKey, content);
      await client.query(
        `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, req.orgId, projectId, input.filename, input.mime, content.length,
         createHash("sha256").update(content).digest("hex"), storageKey, req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "file.uploaded",
        entityType: "file", entityId: fileId,
        metadata: { filename: input.filename, via: "chat" },
      });
      return { fileId, filename: input.filename };
    });
    return reply.status(201).send(result);
  });

  /** A page of a channel, newest-anchored: the most recent `limit` messages,
   *  or the `limit` before `?before=<iso>` when scrolling back. Ascending in
   *  the response so the client renders top to bottom. `hasMore` says
   *  whether an older page exists. Each message carries its attachment (the
   *  file named by metadata.fileId) so the client can show it without a
   *  second request. */
  app.get("/v1/orgs/:orgId/channels/:channelId/messages", async (req) => {
    ctx.requireRole(req, "viewer");
    const { channelId } = req.params as { channelId: string };
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(300, Math.max(20, Number(q.limit) || 120));
    // The cursor is a message id. Replies land in the same transaction as
    // the message they answer and so share its timestamp; (created_at, id)
    // is the total order, and paging by time alone would drop ties.
    const beforeId = q.before && /^[0-9a-f-]{36}$/.test(q.before) ? q.before : null;
    const { rows, hasMore } = await ctx.inOrg(req, async (client) => {
      const channel = await client.query("SELECT id FROM channels WHERE id = $1", [channelId]);
      if (!channel.rows[0]) throw new HttpError(404, "Channel not found");
      let beforeAt: string | null = null;
      if (beforeId) {
        const anchor = await client.query("SELECT created_at FROM messages WHERE id = $1 AND channel_id = $2", [beforeId, channelId]);
        if (!anchor.rows[0]) throw new HttpError(404, "That message is not in this channel");
        beforeAt = anchor.rows[0].created_at;
      }
      const messages = await client.query(
        `SELECT * FROM (
         SELECT m.id, m.author_kind, m.author_user, m.author_agent, u.display_name AS author_name,
                m.body, m.metadata, m.created_at, m.edited_at, m.deleted_at,
                CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', f.id, 'filename', f.filename, 'mime', f.mime, 'size', f.size_bytes
                ) END AS attachment,
                -- Grouped in SQL rather than in the client: the counts and the
                -- "did I react" flag are the same question, and answering them
                -- here keeps one round trip instead of N.
                COALESCE((
                  SELECT jsonb_agg(r ORDER BY r.emoji)
                    FROM (
                      SELECT mr.emoji,
                             count(*)::int AS count,
                             bool_or(mr.user_id = $2) AS reacted,
                             array_agg(ru.display_name ORDER BY ru.display_name) AS names
                        FROM message_reactions mr
                        JOIN users ru ON ru.id = mr.user_id
                       WHERE mr.message_id = m.id
                       GROUP BY mr.emoji
                    ) r
                ), '[]'::jsonb) AS reactions
         FROM messages m
         LEFT JOIN users u ON u.id = m.author_user
         LEFT JOIN files f ON (m.metadata->>'fileId') ~ '^[0-9a-f-]{36}$' AND f.id = (m.metadata->>'fileId')::uuid
         WHERE m.channel_id = $1
           AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
         ORDER BY m.created_at DESC, m.id DESC LIMIT $5
         ) page ORDER BY created_at ASC, id ASC`,
        [channelId, req.userId, beforeAt, beforeId, limit + 1]
      );
      // One extra row was asked for purely to learn whether more exist.
      const more = messages.rows.length > limit;
      if (more) messages.rows.shift();
      // A deleted message stays as a tombstone so the thread keeps its shape,
      // but nothing of what it said leaves the server.
      for (const m of messages.rows) {
        if (m.deleted_at) { m.body = ""; m.metadata = {}; m.attachment = null; m.reactions = []; m.deleted = true; }
      }

      // Whether each info-request form is still worth showing. Computed here
      // rather than stored on the message because `messages` is append-only
      // (GRANT SELECT, INSERT — 0004_chat.sql). A form is open only if its run
      // is still waiting AND it is the newest request for that run, so a
      // partial answer that triggers a fresh round retires the older form
      // instead of leaving two contradictory copies on screen.
      const infoRows = messages.rows.filter(
        (m) => Array.isArray(m.metadata?.infoRequest) && m.metadata?.runId
      );
      if (infoRows.length) {
        const runIds = [...new Set(infoRows.map((m) => m.metadata.runId as string))];
        const waiting = await client.query(
          `SELECT id FROM workflow_runs WHERE id = ANY($1::uuid[]) AND status = 'waiting_for_info'`,
          [runIds]
        );
        const stillWaiting = new Set<string>(waiting.rows.map((r) => r.id as string));
        const newestPerRun = new Map<string, string>();
        for (const m of infoRows) newestPerRun.set(m.metadata.runId as string, m.id as string);
        for (const m of infoRows) {
          const runId = m.metadata.runId as string;
          m.metadata = {
            ...m.metadata,
            infoRequestOpen: stillWaiting.has(runId) && newestPerRun.get(runId) === m.id,
          };
        }
      }
      return { rows: messages.rows, hasMore: more };
    });
    return { messages: rows, hasMore };
  });

  /** Toggle one reaction. Idempotent by construction: the unique constraint
   *  means "react twice" cannot happen, so a second call removes instead. */
  app.post("/v1/orgs/:orgId/messages/:messageId/reactions", async (req) => {
    ctx.requireRole(req, "member");
    const { messageId } = req.params as { messageId: string };
    const { emoji } = req.body as { emoji?: string };
    // A closed set, not free text: this is a reaction bar, not a place to
    // paste arbitrary strings into every teammate's view.
    if (!emoji || !ALLOWED_REACTIONS.includes(emoji)) {
      throw new HttpError(400, "That reaction is not available.");
    }
    return ctx.inOrg(req, async (client) => {
      // RLS scopes this to the tenant, so a message id from another workspace
      // simply is not found.
      const message = await client.query(
        "SELECT id, channel_id FROM messages WHERE id = $1", [messageId]
      );
      if (!message.rows[0]) throw new HttpError(404, "Message not found");

      const removed = await client.query(
        `DELETE FROM message_reactions
          WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING id`,
        [messageId, req.userId, emoji]
      );
      if (!removed.rows[0]) {
        await client.query(
          `INSERT INTO message_reactions (id, tenant_id, message_id, user_id, emoji)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv7(), req.orgId, messageId, req.userId, emoji]
        );
      }
      const { rows } = await client.query(
        `SELECT emoji, count(*)::int AS count, bool_or(user_id = $2) AS reacted
           FROM message_reactions WHERE message_id = $1 GROUP BY emoji ORDER BY emoji`,
        [messageId, req.userId]
      );
      // Wake everyone else looking at this channel.
      ctx.deps.engine.events.emit("event", {
        type: "reaction_changed", tenantId: req.orgId, channelId: message.rows[0].channel_id,
      } as never);
      return { reactions: rows, reacted: !removed.rows[0] };
    });
  });

  /** Edit your own message. The previous text is kept in message_edits, so
   *  "edited" is honest — the history exists, it is just not shown. */
  app.patch("/v1/orgs/:orgId/messages/:messageId", async (req) => {
    ctx.requireRole(req, "member");
    const { messageId } = req.params as { messageId: string };
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const message = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        "SELECT id, channel_id, author_kind, author_user, body, deleted_at FROM messages WHERE id = $1", [messageId]
      );
      const m = rows[0];
      if (!m) throw new HttpError(404, "Message not found");
      if (m.deleted_at) throw new HttpError(409, "That message was deleted.");
      if (m.author_kind !== "user" || m.author_user !== req.userId) throw new HttpError(403, "You can only edit your own messages.");
      if (m.body === body) return m;
      await client.query(
        "INSERT INTO message_edits (id, tenant_id, message_id, previous_body, edited_by) VALUES ($1,$2,$3,$4,$5)",
        [uuidv7(), req.orgId, messageId, m.body, req.userId]
      );
      const { rows: updated } = await client.query(
        "UPDATE messages SET body = $2, edited_at = now() WHERE id = $1 RETURNING id, channel_id, body, edited_at",
        [messageId, body]
      );
      return updated[0];
    });
    ctx.deps.engine.events.emit("event", { type: "message_updated", tenantId: req.orgId, channelId: message.channel_id } as never);
    return { message: { id: message.id, body: message.body, editedAt: message.edited_at ?? null } };
  });

  /** Delete: your own message, or any message if you administer the
   *  workspace. A tombstone stays so the thread keeps its shape. */
  app.delete("/v1/orgs/:orgId/messages/:messageId", async (req) => {
    ctx.requireRole(req, "member");
    const { messageId } = req.params as { messageId: string };
    const admin = req.orgRole === "admin" || req.orgRole === "owner";
    const channelId = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        "SELECT id, channel_id, author_kind, author_user, deleted_at FROM messages WHERE id = $1", [messageId]
      );
      const m = rows[0];
      if (!m) throw new HttpError(404, "Message not found");
      if (m.deleted_at) return m.channel_id as string;
      const mine = m.author_kind === "user" && m.author_user === req.userId;
      if (!mine && !admin) throw new HttpError(403, "You can only delete your own messages.");
      await client.query("UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [messageId, req.userId]);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "message.delete",
        entityType: "messages", entityId: messageId, metadata: { own: mine },
      });
      return m.channel_id as string;
    });
    ctx.deps.engine.events.emit("event", { type: "message_deleted", tenantId: req.orgId, channelId } as never);
    return { ok: true };
  });

  app.post("/v1/orgs/:orgId/channels/:channelId/messages", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { channelId } = req.params as { channelId: string };
    const input = PostMessageInput.parse(req.body);
    const messages = await ctx.inOrg(req, async (client) => {
      const channel = await client.query(
        `SELECT c.id, c.key, c.name, c.kind, c.project_id, c.agent_key, p.type AS project_type
         FROM channels c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
        [channelId]
      );
      if (!channel.rows[0]) throw new HttpError(404, "Channel not found");
      if (input.fileId) {
        const file = await client.query("SELECT id FROM files WHERE id = $1", [input.fileId]);
        if (!file.rows[0]) throw new HttpError(404, "Attached file not found");
      }
      // "@Michael, what should the budget be?" is addressed to Michael, not
      // to whoever usually speaks in this channel — the same rule a huddle
      // applies when a teammate is named out loud.
      const mentioned = mentionedTeammate(input.body);
      return handleUserMessage(
        ctx.deps, client,
        { tenantId: req.orgId!, userId: req.userId! },
        channel.rows[0] as ChannelRow,
        input.body,
        input.fileId ?? null,
        input.clientKey ?? null,
        input.huddleId ?? null,
        mentioned,
        input.action ?? null,
        input.timezone ?? null
      );
    });
    // Wake any live listeners (SSE) in this org.
    ctx.deps.engine.events.emit("event", {
      type: "message_created", tenantId: req.orgId, channelId,
    } as never);
    return reply.status(201).send({ messages });
  });
}

/** The teammate a message is addressed to by name ("@Michael …", "@Maya"),
 *  or null. Only the roster's names count, so a stray @ cannot re-route. */
export function mentionedTeammate(body: string): string | null {
  const m = /(?:^|\s)@([A-Za-z]+)/.exec(body);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return TEAMMATES.find((t) => t.name.toLowerCase() === name)?.agentKey ?? null;
}
