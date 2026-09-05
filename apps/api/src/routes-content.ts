import { randomBytes } from "node:crypto";
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

  /** Share a design outside the team. The design's bytes sit behind the
   *  session-gated files route, so a public link is a random token that the
   *  unauthenticated /v1/share route resolves back to the file. One live
   *  token per asset: asking again returns the same link rather than minting
   *  a second one, so revoking it revokes every copy that was handed out. */
  app.post("/v1/orgs/:orgId/content/assets/:assetId/share", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { assetId } = req.params as { assetId: string };
    const orgId = req.orgId!;
    const userId = req.userId!;
    const share = await ctx.inOrg(req, async (client) => {
      const { rows: assets } = await client.query("SELECT id, file_id FROM content_assets WHERE id = $1", [assetId]);
      const asset = assets[0];
      if (!asset) throw new HttpError(404, "Design not found");
      if (!asset.file_id) throw new HttpError(409, "This design has no image to share yet");
      const { rows: existing } = await client.query(
        `SELECT token FROM content_asset_shares
          WHERE asset_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [assetId]
      );
      if (existing[0]) return { token: existing[0].token as string, created: false };
      const token = randomBytes(24).toString("base64url");
      await client.query(
        `INSERT INTO content_asset_shares (token, tenant_id, asset_id, file_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [token, orgId, assetId, asset.file_id, userId]
      );
      await audit(client, {
        tenantId: orgId, actorUser: userId, action: "content.share",
        entityType: "content_assets", entityId: assetId, metadata: {},
      });
      return { token, created: true };
    });
    reply.code(share.created ? 201 : 200);
    return { token: share.token, path: designSharePath(share.token) };
  });

  /** Stop sharing: every link handed out for this design stops working. */
  app.delete("/v1/orgs/:orgId/content/assets/:assetId/share", async (req) => {
    ctx.requireRole(req, "member");
    const { assetId } = req.params as { assetId: string };
    const orgId = req.orgId!;
    const userId = req.userId!;
    const revoked = await ctx.inOrg(req, async (client) => {
      const { rows: assets } = await client.query("SELECT id FROM content_assets WHERE id = $1", [assetId]);
      if (!assets[0]) throw new HttpError(404, "Design not found");
      const { rowCount } = await client.query(
        "UPDATE content_asset_shares SET revoked_at = now() WHERE asset_id = $1 AND revoked_at IS NULL",
        [assetId]
      );
      if (rowCount) {
        await audit(client, {
          tenantId: orgId, actorUser: userId, action: "content.unshare",
          entityType: "content_assets", entityId: assetId, metadata: { links: rowCount },
        });
      }
      return rowCount ?? 0;
    });
    return { ok: true, revoked };
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
        `SELECT a.id, a.position, a.caption, a.post_text, a.prompt, a.file_id, a.approval, a.approved_at,
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
        `SELECT a.id, a.file_id, a.approval, a.content_project_id, a.post_text
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
           connection.connector_type, (content && content.trim()) || row.post_text || "", JSON.stringify([row.file_id].filter(Boolean)),
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

  /** Move a queued post, or take it out of the queue. Only posts that have
   *  not started publishing can change; the worker owns them after that. */
  app.patch("/v1/orgs/:orgId/content/posts/:postId", async (req) => {
    ctx.requireRole(req, "member");
    const { postId } = req.params as { postId: string };
    const { scheduledAt, timezone } = req.body as { scheduledAt?: string; timezone?: string };
    const when = scheduledAt ? new Date(scheduledAt) : null;
    if (!when || Number.isNaN(when.getTime())) throw new HttpError(400, "scheduledAt must be a date");
    if (when.getTime() < Date.now() - 60_000) throw new HttpError(400, "That time has already passed.");
    const post = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `UPDATE scheduled_posts SET scheduled_at = $2::timestamptz, timezone = coalesce($3::text, timezone), status = 'scheduled',
                next_attempt_at = NULL, error = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('draft', 'scheduled', 'failed') RETURNING *`,
        [postId, when.toISOString(), timezone ?? null]
      );
      if (!rows[0]) throw new HttpError(409, "That post can't be moved any more.");
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "content.reschedule",
        entityType: "scheduled_posts", entityId: postId, metadata: { scheduledAt: when.toISOString() },
      });
      return rows[0];
    });
    return { post };
  });

  app.delete("/v1/orgs/:orgId/content/posts/:postId", async (req) => {
    ctx.requireRole(req, "member");
    const { postId } = req.params as { postId: string };
    await ctx.inOrg(req, async (client) => {
      const { rowCount } = await client.query(
        "DELETE FROM scheduled_posts WHERE id = $1 AND status IN ('draft', 'scheduled', 'failed')",
        [postId]
      );
      if (!rowCount) throw new HttpError(409, "That post is already publishing or published.");
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "content.unschedule",
        entityType: "scheduled_posts", entityId: postId, metadata: {},
      });
    });
    return { ok: true };
  });

  /** When to post. Ranked slots over the coming days from what is known
   *  about when each platform's audiences are around, shaped by this
   *  organisation's own queue: slots already taken are skipped and the next
   *  best kept a few hours clear of them, so a campaign spreads out instead
   *  of landing in a clump. Honest about its basis — `reason` says why. */
  app.get("/v1/orgs/:orgId/content/best-times", async (req) => {
    ctx.requireRole(req, "viewer");
    const q = req.query as { platform?: string; timezone?: string; days?: string; count?: string };
    const timezone = q.timezone && isValidTimeZone(q.timezone) ? q.timezone : "UTC";
    const days = Math.min(28, Math.max(3, Number(q.days) || 14));
    const count = Math.min(30, Math.max(1, Number(q.count) || 8));
    const platform = q.platform === "instagram_account" ? "instagram_account" : "facebook_page";
    const taken = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT scheduled_at FROM scheduled_posts
          WHERE scheduled_at IS NOT NULL AND scheduled_at > now() - interval '1 day'
            AND status IN ('scheduled', 'publishing', 'published')`
      )
    );
    const slots = bestTimes({
      platform, timezone, days, count,
      taken: taken.rows.map((r) => new Date(r.scheduled_at)),
      now: new Date(),
    });
    return { platform, timezone, slots, suggested: slots[0] ?? null };
  });
}

function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Audience windows by platform, in the viewer's local time. Weekday-first;
 *  the weights encode broadly agreed engagement patterns rather than a
 *  guarantee — the reason text says so. */
const WINDOWS: Record<string, Array<{ days: number[]; hours: number[]; weight: number; why: string }>> = {
  facebook_page: [
    { days: [2, 3, 4], hours: [9, 10, 11], weight: 1.0, why: "Mid-week mornings are when Facebook audiences are most active" },
    { days: [1, 2, 3, 4, 5], hours: [13, 14, 15], weight: 0.85, why: "Early-afternoon weekday lull, when people check their feeds" },
    { days: [1, 5], hours: [9, 10], weight: 0.7, why: "Monday and Friday mornings still draw steady attention" },
    { days: [6, 0], hours: [10, 11, 12], weight: 0.6, why: "Late weekend mornings, for a relaxed audience" },
    { days: [1, 2, 3, 4, 5], hours: [18, 19], weight: 0.55, why: "Early evening, after work" },
  ],
  instagram_account: [
    { days: [1, 2, 3, 4, 5], hours: [11, 12, 13], weight: 1.0, why: "Weekday lunch hours are Instagram's busiest stretch" },
    { days: [1, 2, 3, 4], hours: [19, 20], weight: 0.85, why: "Weekday evenings, when scrolling peaks" },
    { days: [2, 3, 4], hours: [8, 9], weight: 0.7, why: "Mid-week mornings, first check of the day" },
    { days: [6, 0], hours: [10, 11], weight: 0.6, why: "Weekend late mornings" },
    { days: [5], hours: [16, 17], weight: 0.5, why: "Friday late afternoon, heading into the weekend" },
  ],
};

export interface BestTimeSlot { at: string; local: string; score: number; reason: string }

export function bestTimes(opts: {
  platform: string; timezone: string; days: number; count: number; taken: Date[]; now: Date;
}): BestTimeSlot[] {
  const windows = WINDOWS[opts.platform] ?? WINDOWS.facebook_page!;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timezone, weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric", hour12: false,
  });
  const parts = (d: Date) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday).slice(0, 3));
    return { dow, hour: Number(p.hour) % 24, label: `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute}` };
  };
  const candidates: BestTimeSlot[] = [];
  // Walk every hour of the horizon in UTC; classify each in the viewer's zone.
  const start = new Date(opts.now.getTime() + 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = opts.now.getTime() + opts.days * 24 * 60 * 60 * 1000;
  for (let t = start.getTime(); t < end; t += 60 * 60 * 1000) {
    const d = new Date(t);
    const { dow, hour, label } = parts(d);
    let best: { weight: number; why: string } | null = null;
    for (const w of windows) {
      if (w.days.includes(dow) && w.hours.includes(hour) && (!best || w.weight > best.weight)) best = { weight: w.weight, why: w.why };
    }
    if (!best) continue;
    // Sooner is a little better (a campaign should start), and anything within
    // three hours of something already queued is crowded.
    const daysOut = (t - opts.now.getTime()) / (24 * 60 * 60 * 1000);
    const recency = Math.max(0, 1 - daysOut / (opts.days * 1.5)) * 0.25;
    const crowded = opts.taken.some((x) => Math.abs(x.getTime() - t) < 3 * 60 * 60 * 1000);
    if (crowded) continue;
    const score = Math.round((best.weight + recency) * 100) / 100;
    candidates.push({ at: d.toISOString(), local: label, score, reason: best.why });
  }
  candidates.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at));
  // Spread the picks out: no two suggestions within six hours of each other.
  const picked: BestTimeSlot[] = [];
  for (const c of candidates) {
    if (picked.length >= opts.count) break;
    const near = picked.some((p) => Math.abs(new Date(p.at).getTime() - new Date(c.at).getTime()) < 6 * 60 * 60 * 1000);
    if (!near) picked.push(c);
  }
  return picked;
}

/** Where a shared design is fetched from, relative to the API origin. The
 *  prefix is exempt from authentication in app.ts — the token is the only
 *  credential, which is the point of a share link. */
export const DESIGN_SHARE_PREFIX = "/v1/share/designs/";
export const designSharePath = (token: string): string => `${DESIGN_SHARE_PREFIX}${token}`;

/** The public side of a share link: no session, no API key — the token is
 *  looked up through the admin pool (there is no tenant context to scope to
 *  until the row says which one) and the file streams straight back. Cached
 *  only briefly so a revoked link goes dark within minutes, and marked
 *  noindex so a link that leaks does not end up in a search engine. */
export function registerDesignShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/share/designs/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new HttpError(404, "This link is not valid");
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT f.filename, f.mime, f.storage_key
         FROM content_asset_shares s JOIN files f ON f.id = s.file_id
        WHERE s.token = $1 AND s.revoked_at IS NULL`,
      [token]
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "This link is no longer available");
    const bytes = await ctx.deps.storage.get(row.storage_key);
    const download = (req.query as { download?: string }).download === "1";
    reply.header("content-type", row.mime);
    reply.header("content-disposition", `${download ? "attachment" : "inline"}; filename="${String(row.filename).replace(/"/g, "")}"`);
    reply.header("cache-control", "public, max-age=300");
    reply.header("x-robots-tag", "noindex");
    return reply.send(bytes);
  });
}
