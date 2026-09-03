import type { Pool } from "pg";
import { ConnectorHealthService, unseal } from "./health.js";
import { SocialPublishingService } from "./publishing.js";

/**
 * Server-side scheduled-post worker. Nothing here depends on a browser being
 * open: a nonprofit schedules a post, closes Deedwell, and this publishes it.
 *
 * Claiming uses UPDATE ... FOR UPDATE SKIP LOCKED inside a transaction, so
 * several API instances can run this loop without two of them publishing the
 * same post. Retries are bounded and backed off; a credential failure stops
 * retrying entirely and flips the connection to needs_attention, because
 * hammering Meta with a revoked token just gets the app rate-limited.
 */
const MAX_ATTEMPTS = Number(process.env.PUBLISH_MAX_ATTEMPTS ?? 5);
const BATCH = Number(process.env.PUBLISH_BATCH ?? 5);
const POLL_MS = Number(process.env.PUBLISH_POLL_MS ?? 30_000);
/** A post claimed but never finished (instance died mid-publish) is retried. */
const STALE_LOCK_MS = Number(process.env.PUBLISH_STALE_LOCK_MS ?? 10 * 60_000);

const backoffMs = (attempt: number) => Math.min(2 ** attempt * 60_000, 6 * 60 * 60_000);

export interface WorkerDeps {
  pool: Pool;
  /** Turns stored file ids into URLs the provider can fetch. */
  mediaUrlFor: (tenantId: string, fileId: string) => string;
  log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export async function runPublishBatch(deps: WorkerDeps): Promise<number> {
  const { pool } = deps;
  const client = await pool.connect();
  let claimed: Record<string, any>[] = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM scheduled_posts
        WHERE status = 'scheduled'
          AND scheduled_at <= now()
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY scheduled_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH]
    );
    claimed = rows;
    if (rows.length) {
      await client.query(
        `UPDATE scheduled_posts SET status = 'publishing', locked_at = now(), attempts = attempts + 1
          WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const post of claimed) await publishOne(deps, post);
  return claimed.length;
}

async function publishOne(deps: WorkerDeps, post: Record<string, any>): Promise<void> {
  const { pool } = deps;
  const health = new ConnectorHealthService(pool);
  try {
    const { rows } = await pool.query(
      "SELECT * FROM connector_connections WHERE id = $1 AND tenant_id = $2",
      [post.connector_id, post.tenant_id]
    );
    const connection = rows[0];
    if (!connection) throw new Error("The connected account was removed.");
    if (connection.status === "disconnected") throw new Error("That account is no longer connected to Deedwell.");

    const media = (post.media ?? []) as string[];
    const result = await SocialPublishingService.publish({
      content: post.content,
      mediaUrls: media.map((fileId) => deps.mediaUrlFor(post.tenant_id, fileId)),
      connection: {
        provider: connection.provider,
        connectorType: connection.connector_type,
        providerAccountId: connection.provider_account_id,
        metadata: connection.metadata ?? {},
      },
      tokens: unseal(connection),
    });

    await pool.query(
      `UPDATE scheduled_posts
          SET status = 'published', published_at = now(), provider_post_id = $2,
              last_error = NULL, locked_at = NULL
        WHERE id = $1`,
      [post.id, result.providerPostId]
    );
    deps.log?.info({ postId: post.id, providerPostId: result.providerPostId }, "scheduled post published");
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    const verdict = ConnectorHealthService.classify(err);
    // A credential problem will not fix itself; stop and tell the tenant.
    const permanent = verdict.status === "expired" || /permission|no longer connected|was removed/i.test(message);
    const attempts = Number(post.attempts ?? 0) + 1;
    const giveUp = permanent || attempts >= MAX_ATTEMPTS;

    await pool.query(
      `UPDATE scheduled_posts
          SET status = $2, last_error = $3, locked_at = NULL, next_attempt_at = $4
        WHERE id = $1`,
      [post.id, giveUp ? "failed" : "scheduled", message.slice(0, 500),
       giveUp ? null : new Date(Date.now() + backoffMs(attempts))]
    );
    if (permanent && post.connector_id) {
      await health.record(post.tenant_id, post.connector_id, verdict, post.created_by).catch(() => {});
    }
    deps.log?.error({ postId: post.id, attempts, giveUp, err: message }, "scheduled post failed");
  }
}

/** Returns rows a dead instance left mid-publish to the queue. */
export async function reclaimStalePosts(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE scheduled_posts SET status = 'scheduled', locked_at = NULL
      WHERE status = 'publishing' AND locked_at < now() - ($1 || ' milliseconds')::interval`,
    [String(STALE_LOCK_MS)]
  );
  return rowCount ?? 0;
}

export function startPublishWorker(deps: WorkerDeps): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await reclaimStalePosts(deps.pool);
      await runPublishBatch(deps);
    } catch (err) {
      deps.log?.error({ err: String((err as Error)?.message ?? err) }, "publish worker tick failed");
    } finally {
      if (!stopped) setTimeout(tick, POLL_MS);
    }
  };
  setTimeout(tick, POLL_MS);
  return () => { stopped = true; };
}
