import type { FastifyInstance } from "fastify";
import { audit, uuidv7 } from "@deedwell/database";
import { readProviderKey, type ContentKind } from "@deedwell/content-domain";
import { canStartCampaign, startCampaign, startMoreDesigns } from "./content-campaigns.js";
import { CreateContentInput } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";

/** A campaign takes minutes, which is far longer than any sane HTTP request.
 *  The POST returns immediately with a 'generating' row; the client polls the
 *  GET. Nothing is streamed because nothing needs to be — the client shows a
 *  skeleton until status flips. */
export function registerContentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.post("/v1/orgs/:orgId/content", async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = CreateContentInput.parse(req.body);
    if (!canStartCampaign()) {
      throw new HttpError(429, "Another campaign is still generating — try again in a moment.");
    }
    // Fail before creating a row: a campaign that can never generate should
    // not sit in the library looking like it might.
    if ((process.env.MODEL_PROVIDER ?? "mock") !== "mock" && !(await readProviderKey(deps.appPool, "openai"))) {
      throw new HttpError(503, "Content generation is not configured yet — an administrator needs to add an OpenAI API key.");
    }
    const orgId = req.orgId!;
    const userId = req.userId!;
    const row = await ctx.inOrg(req, async (client) => {
      const { project } = await startCampaign(deps, client, { orgId, userId, kind: input.kind, prompt: input.prompt, title: input.title ?? null });
      await audit(client, {
        tenantId: orgId, actorUser: userId, action: "content.generate",
        entityType: "content_projects", entityId: String(project.id), metadata: { kind: input.kind },
      });
      return project;
    });

    reply.code(202);
    return { contentProject: row, assets: [] };
  });

  app.get("/v1/orgs/:orgId/content", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT p.*, (
           SELECT a.file_id FROM content_assets a
           WHERE a.content_project_id = p.id ORDER BY a.position LIMIT 1
         ) AS cover_file_id,
         (SELECT count(*) FROM content_assets a WHERE a.content_project_id = p.id) AS asset_count
         FROM content_projects p ORDER BY p.created_at DESC LIMIT 60`
      )
    );
    return { contentProjects: rows };
  });

  /** Serves a stored file's bytes to the owning tenant. Content Studio needs
   *  this to show a generated design at all — every other consumer so far only
   *  ever read files server-side. Tenant-scoped through inOrg, so the RLS
   *  policy on `files` is what actually authorises it, not the URL. */
  app.get("/v1/orgs/:orgId/files/:fileId/content", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { fileId } = req.params as { fileId: string };
    const file = await ctx.inOrg(req, (client) =>
      client.query("SELECT filename, mime, storage_key FROM files WHERE id = $1", [fileId])
    );
    const row = file.rows[0];
    if (!row) throw new HttpError(404, "File not found");
    const bytes = await deps.storage.get(row.storage_key);
    reply.header("content-type", row.mime);
    reply.header("content-disposition", `inline; filename="${row.filename.replace(/"/g, "")}"`);
    // Content-addressed by id and never rewritten, so it can be cached hard —
    // but privately: this is tenant data behind a session cookie.
    reply.header("cache-control", "private, max-age=31536000, immutable");
    return reply.send(bytes);
  });

  /** "Generate more": add another round of designs to a finished campaign,
   *  briefed against the ones it already has so they are new approaches
   *  rather than repeats. Same detached shape as the first round — the
   *  campaign flips back to 'generating' and the client polls. */
  app.post("/v1/orgs/:orgId/content/:contentId/more", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { contentId } = req.params as { contentId: string };
    if (!canStartCampaign()) {
      throw new HttpError(429, "Another campaign is still generating — try again in a moment.");
    }
    if ((process.env.MODEL_PROVIDER ?? "mock") !== "mock" && !(await readProviderKey(deps.appPool, "openai"))) {
      throw new HttpError(503, "Content generation is not configured yet — an administrator needs to add an OpenAI API key.");
    }
    const orgId = req.orgId!;
    const userId = req.userId!;

    const row = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT * FROM content_projects WHERE id = $1", [contentId]);
      const project = rows[0];
      if (!project) throw new HttpError(404, "Content project not found");
      if (project.status === "generating") throw new HttpError(409, "This campaign is still generating.");
      const { rows: updated } = await client.query(
        `UPDATE content_projects SET status = 'generating', error = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [contentId]
      );
      await audit(client, {
        tenantId: orgId, actorUser: userId, action: "content.generate_more",
        entityType: "content_projects", entityId: contentId, metadata: { kind: project.kind },
      });
      return updated[0];
    });

    void startMoreDesigns(deps, { orgId, userId, id: contentId, kind: row.kind as ContentKind, prompt: row.prompt as string })
      .catch((err) => app.log.error({ err, contentProjectId: contentId }, "generate more failed"));

    reply.code(202);
    return { contentProject: row };
  });

  app.get("/v1/orgs/:orgId/content/:contentId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { contentId } = req.params as { contentId: string };
    const result = await ctx.inOrg(req, async (client) => {
      const project = await client.query("SELECT * FROM content_projects WHERE id = $1", [contentId]);
      if (!project.rows[0]) throw new HttpError(404, "Content project not found");
      const assets = await client.query(
        `SELECT a.id, a.position, a.caption, a.prompt, a.file_id, a.approval, a.approved_at,
                f.filename, f.mime
         FROM content_assets a LEFT JOIN files f ON f.id = a.file_id
         WHERE a.content_project_id = $1 ORDER BY a.position`,
        [contentId]
      );
      return { contentProject: project.rows[0], assets: assets.rows };
    });
    return result;
  });
}

/** Approval and publishing for generated designs. Split out from the
 *  generation routes above because it is a different lifecycle: generation is
 *  fire-and-forget, this is a human decision followed by scheduled work. */
export function registerContentPublishingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/orgs/:orgId/content/assets/:assetId/approval", async (req) => {
    ctx.requireRole(req, "member");
    const { assetId } = req.params as { assetId: string };
    const { approval } = req.body as { approval?: string };
    if (approval !== "approved" && approval !== "rejected" && approval !== "pending") {
      throw new HttpError(400, "approval must be approved, rejected or pending");
    }
    return ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `UPDATE content_assets
            SET approval = $2,
                approved_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $3::uuid END,
                approved_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
          WHERE id = $1 RETURNING id, approval`,
        [assetId, approval, req.userId]
      );
      if (!rows[0]) throw new HttpError(404, "Design not found");
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: `content.${approval}`,
        entityType: "content_assets", entityId: assetId,
      });
      return rows[0];
    });
  });

  /** Queue an approved design. `scheduledAt` absent means publish on the next
   *  worker tick; the browser is never the thing that publishes. */
  app.post("/v1/orgs/:orgId/content/assets/:assetId/publish", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { assetId } = req.params as { assetId: string };
    const { connectorIds, content, scheduledAt, timezone } = req.body as {
      connectorIds?: string[]; content?: string; scheduledAt?: string; timezone?: string;
    };
    if (!connectorIds?.length) throw new HttpError(400, "Choose at least one destination.");

    return ctx.inOrg(req, async (client) => {
      const asset = await client.query(
        `SELECT a.id, a.file_id, a.approval, a.content_project_id
           FROM content_assets a WHERE a.id = $1`,
        [assetId]
      );
      const row = asset.rows[0];
      if (!row) throw new HttpError(404, "Design not found");
      // Enforced here, not only in the UI: nothing unapproved can be published.
      if (row.approval !== "approved") throw new HttpError(409, "Approve this design before publishing it.");

      const queued = [];
      for (const connectorId of connectorIds) {
        const conn = await client.query(
          `SELECT id, provider, connector_type, status FROM connector_connections WHERE id = $1`,
          [connectorId]
        );
        const connection = conn.rows[0];
        // RLS means a connector from another workspace simply is not found.
        if (!connection) throw new HttpError(404, "That destination is not connected.");
        if (connection.status !== "connected") {
          throw new HttpError(409, "That connection needs to be reconnected before publishing.");
        }
        const { rows } = await client.query(
          `INSERT INTO scheduled_posts
             (id, tenant_id, connector_id, content_project_id, content_asset_id, platform, content,
              media, scheduled_at, timezone, status, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',$11,$12)
           ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
             SET scheduled_at = EXCLUDED.scheduled_at, status = 'scheduled', last_error = NULL
           RETURNING *`,
          [uuidv7(), req.orgId, connectorId, row.content_project_id, assetId,
           connection.connector_type, content ?? "", JSON.stringify([row.file_id].filter(Boolean)),
           scheduledAt ? new Date(scheduledAt) : new Date(), timezone ?? "UTC",
           `${assetId}:${connectorId}`, req.userId]
        );
        queued.push(rows[0]);
      }
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId,
        action: scheduledAt ? "content.scheduled" : "content.publish_now",
        entityType: "scheduled_posts", metadata: { assetId, destinations: connectorIds.length },
      });
      return reply.status(202).send({ posts: queued });
    });
  });

  app.get("/v1/orgs/:orgId/content/posts", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT p.*, c.provider, c.connector_type, c.provider_account_name
           FROM scheduled_posts p LEFT JOIN connector_connections c ON c.id = p.connector_id
          ORDER BY p.created_at DESC LIMIT 100`
      )
    );
    return { posts: rows };
  });
}
