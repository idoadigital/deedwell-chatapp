/**
 * Background tick: run queued publish jobs, keep snapshots fresh, and retry
 * pending manager links. Claims on the admin pool (SKIP LOCKED) and does
 * every piece of work inside that tenant's own context.
 * GOOGLE_ADS_WORKER=off disables it.
 */
import { withContext } from "@deedwell/database";
import type { Deps } from "../bootstrap.js";
import { ensureManagerLink } from "./connection.js";
import { runPublishJob } from "./publish.js";
import { loadAccountById } from "./store.js";
import { syncAccount } from "./sync.js";

export const SYNC_INTERVAL_MS = Number(process.env.GOOGLE_ADS_SYNC_MS ?? 6 * 60 * 60_000);
const LINK_RETRY_MS = Number(process.env.GOOGLE_ADS_LINK_RETRY_MS ?? 15 * 60_000);
const STALE_JOB_MINUTES = 20;

export interface TickStats { jobs: number; synced: number; links: number }

export async function runGoogleAdsTick(deps: Deps, opts: { log?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void }; now?: Date } = {}): Promise<TickStats> {
  const stats: TickStats = { jobs: 0, synced: 0, links: 0 };
  const workerId = `google-ads-${process.pid}`;

  const { rows: jobs } = await deps.adminPool.query(
    `UPDATE google_ads_publish_jobs SET claimed_by = $1, claimed_at = now()
      WHERE id IN (SELECT id FROM google_ads_publish_jobs
                    WHERE (status = 'queued' OR (status = 'running' AND claimed_at < now() - make_interval(mins => $2)))
                      AND attempts < 3
                    ORDER BY created_at LIMIT 2 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [workerId, STALE_JOB_MINUTES]);
  for (const job of jobs) {
    stats.jobs++;
    await runPublishJob(deps, job, { log: opts.log });
  }

  const { rows: due } = await deps.adminPool.query(
    `SELECT id, tenant_id FROM google_ads_accounts
      WHERE status = 'connected' AND (last_sync_at IS NULL OR last_sync_at < now() - ($1::bigint * interval '1 millisecond'))
      ORDER BY last_sync_at NULLS FIRST LIMIT 5`, [SYNC_INTERVAL_MS]);
  for (const row of due) {
    stats.synced++;
    const result = await syncAccount(deps, row.tenant_id, row.id);
    if (!result.ok) opts.log?.error({ at: "google_ads.sync_failed", accountId: row.id, error: result.error });
  }

  const { rows: pending } = await deps.adminPool.query(
    `SELECT id, tenant_id FROM google_ads_accounts
      WHERE status IN ('manager_link_pending','account_selected')
        AND (metadata->>'link_checked_at' IS NULL OR (metadata->>'link_checked_at')::timestamptz < now() - ($1::bigint * interval '1 millisecond'))
      ORDER BY updated_at LIMIT 5`, [LINK_RETRY_MS]);
  for (const row of pending) {
    stats.links++;
    await withContext(deps.appPool, { tenantId: row.tenant_id, userId: null }, async (client) => {
      const account = await loadAccountById(client, row.tenant_id, row.id);
      if (!account) return;
      await client.query(`UPDATE google_ads_accounts SET metadata = metadata || jsonb_build_object('link_checked_at', now()::text) WHERE id = $1`, [row.id]);
      await ensureManagerLink(deps, client, account, null);
    }).catch((err) => opts.log?.error({ at: "google_ads.link_retry_failed", accountId: row.id, err }));
  }
  return stats;
}

export function startGoogleAdsWorker(deps: Deps, opts: { intervalMs?: number; log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {}): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.GOOGLE_ADS_POLL_MS ?? 60_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const stats = await runGoogleAdsTick(deps, { log: opts.log });
      if (stats.jobs || stats.synced || stats.links) opts.log?.info({ at: "google_ads.tick", ...stats });
    } catch (err) {
      opts.log?.error({ at: "google_ads.tick_failed", err });
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { void tick(); }, Math.min(intervalMs, 5_000));
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
