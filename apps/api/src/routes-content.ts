import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { audit, tenantFileKey, uuidv7, withContext } from "@deedwell/database";
import {
  createImageGenerator, generateCampaign, readProviderKey,
  type ContentKind, type OrgContext,
} from "@deedwell/content-domain";
import { CreateContentInput } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";

/** A campaign takes minutes, which is far longer than any sane HTTP request.
 *  The POST returns immediately with a 'generating' row; the client polls the
 *  GET. Nothing is streamed because nothing needs to be — the client shows a
 *  skeleton until status flips. */
const MAX_CONCURRENT = Number(process.env.CONTENT_MAX_CONCURRENT ?? 2);
let running = 0;

async function loadOrgContext(client: PoolClient, orgId: string): Promise<OrgContext> {
  const [org, facts, knowledge] = await Promise.all([
    client.query("SELECT name FROM organizations WHERE id = $1", [orgId]),
    client.query("SELECT fact_key, value FROM org_facts WHERE status <> 'rejected' ORDER BY fact_key LIMIT 60"),
    client.query(
      `SELECT filename FROM files WHERE project_id IS NULL ORDER BY created_at DESC LIMIT 12`
    ),
  ]);
  return {
    name: org.rows[0]?.name ?? "This nonprofit",
    facts: facts.rows.map((r) => ({ key: r.fact_key as string, value: String(r.value) })),
    // Filenames only: the knowledge files themselves are not parsed here, and
    // claiming to have read them would be worse than naming them.
    knowledge: knowledge.rows.map((r) => ({ title: r.filename as string, excerpt: "" })),
  };
}

export function registerContentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.post("/v1/orgs/:orgId/content", async (req, reply) => {
    ctx.requireRole(req, "member");
    const input = CreateContentInput.parse(req.body);
    if (running >= MAX_CONCURRENT) {
      throw new HttpError(429, "Another campaign is still generating — try again in a moment.");
    }
    // Fail before creating a row: a campaign that can never generate should
    // not sit in the library looking like it might.
    if ((process.env.MODEL_PROVIDER ?? "mock") !== "mock" && !(await readProviderKey(deps.appPool, "openai"))) {
      throw new HttpError(503, "Content generation is not configured yet — an administrator needs to add an OpenAI API key.");
    }
    const orgId = req.orgId!;
    const userId = req.userId!;
    const id = uuidv7();
    const title = input.title ?? input.prompt.slice(0, 60);

    const row = await ctx.inOrg(req, async (client) => {
      await client.query(
        `INSERT INTO content_projects (id, tenant_id, kind, title, prompt, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, orgId, input.kind, title, input.prompt, userId]
      );
      await audit(client, {
        tenantId: orgId, actorUser: userId, action: "content.generate",
        entityType: "content_projects", entityId: id, metadata: { kind: input.kind },
      });
      const { rows } = await client.query("SELECT * FROM content_projects WHERE id = $1", [id]);
      return rows[0];
    });

    // Detached on purpose: the request is done, the work is not.
    running += 1;
    void runCampaign({ deps, orgId, userId, id, kind: input.kind, prompt: input.prompt })
      .catch((err) => app.log.error({ err, contentProjectId: id }, "content generation failed"))
      .finally(() => { running -= 1; });

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

/** The actual work, outside the request. Runs in its own tenant-scoped
 *  transaction because the request's one is long gone by the time it starts. */
async function runCampaign(args: {
  deps: AppContext["deps"];
  orgId: string;
  userId: string;
  id: string;
  kind: ContentKind;
  prompt: string;
}): Promise<void> {
  const { deps, orgId, userId, id, kind, prompt } = args;
  try {
    const org = await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      loadOrgContext(client, orgId)
    );
    const apiKey = await readProviderKey(deps.appPool, "openai");
    const result = await generateCampaign({
      model: deps.provider,
      images: createImageGenerator({ apiKey }),
      kind,
      prompt,
      org,
    });

    for (const design of result.designs) {
      const fileId = uuidv7();
      const filename = `${design.caption.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "design"}.png`;
      const storageKey = tenantFileKey(orgId, fileId, filename);
      await deps.storage.put(storageKey, design.bytes);
      await withContext(deps.appPool, { tenantId: orgId, userId }, async (client) => {
        await client.query(
          `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
          [fileId, orgId, filename, design.mime, design.bytes.length,
           createHash("sha256").update(design.bytes).digest("hex"), storageKey, userId]
        );
        await client.query(
          `INSERT INTO content_assets (id, tenant_id, content_project_id, file_id, position, prompt, caption)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), orgId, id, fileId, design.position, design.prompt, design.caption]
        );
      });
    }

    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects SET status = 'ready', strategy = $2, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(result.strategy)]
      )
    );
  } catch (err) {
    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [id, String((err as Error).message ?? err).slice(0, 500)]
      )
    ).catch(() => {});
    throw err;
  }
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
