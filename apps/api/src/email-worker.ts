import type { Deps } from "./bootstrap.js";
import { emailConfig, emailOrgAdmins, emailUser, sweepEmailOutbox } from "@deedwell/email";

/**
 * Email delivery and the two mails no single request can emit.
 *
 * - Every EMAIL_SWEEP_MS: drain the outbox (see @deedwell/email/outbox).
 * - Every EMAIL_LOW_BALANCE_MS (1h): warn workspaces whose token balance
 *   dropped under LOW_BALANCE_TOKENS — the same line the dashboard's
 *   "Running low" cue uses — at most once a week each.
 * - Every EMAIL_DIGEST_MS (30m): people who have been away for a while and
 *   have unread co-worker messages get one digest, at most every 12 hours.
 *
 * Everything runs on the admin pool (cross-tenant), claims nothing exclusively
 * beyond what the outbox's SKIP LOCKED does, and is safe on several instances
 * because every send is deduped by key. EMAIL_WORKER=off disables it.
 */
const LOW_BALANCE_TOKENS = Number(process.env.EMAIL_LOW_BALANCE_TOKENS ?? 250_000);
const DIGEST_AWAY_MINUTES = Number(process.env.EMAIL_DIGEST_AWAY_MINUTES ?? 30);
const DIGEST_EVERY_HOURS = 12;

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

export function startEmailWorker(deps: Deps, opts: { log?: Log; sweepMs?: number; lowBalanceMs?: number; digestMs?: number } = {}): () => void {
  const sweepMs = opts.sweepMs ?? Number(process.env.EMAIL_SWEEP_MS ?? 10_000);
  const lowBalanceMs = opts.lowBalanceMs ?? Number(process.env.EMAIL_LOW_BALANCE_MS ?? 3600_000);
  const digestMs = opts.digestMs ?? Number(process.env.EMAIL_DIGEST_MS ?? 1800_000);
  const log = opts.log;
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const loop = (name: string, ms: number, fn: () => Promise<unknown>, first = Math.min(ms, 5_000)) => {
    let busy = false;
    const tick = async () => {
      if (stopped) return;
      if (!busy) {
        busy = true;
        try { await fn(); } catch (err) { log?.error({ at: `email.${name}_failed`, err: String(err) }); } finally { busy = false; }
      }
      if (!stopped) timers.push(setTimeout(() => { void tick(); }, ms));
    };
    timers.push(setTimeout(() => { void tick(); }, first));
  };

  loop("sweep", sweepMs, async () => {
    const r = await sweepEmailOutbox(deps.adminPool, { log });
    if (r.sent || r.failed || r.retried) log?.info({ at: "email.sweep", ...r });
  }, 2_000);
  loop("low_balance", lowBalanceMs, () => sweepLowBalances(deps));
  loop("digest", digestMs, () => sweepUnreadDigests(deps));

  return () => { stopped = true; for (const t of timers) clearTimeout(t); };
}

/** Configured billing only: unconfigured or exempt workspaces never hear
 *  about tokens. Dedupe bucket = ISO week, so one nudge per week per org. */
export async function sweepLowBalances(deps: Deps, threshold = LOW_BALANCE_TOKENS): Promise<number> {
  const configured = await deps.adminPool.query("SELECT 1 FROM platform_stripe_config LIMIT 1").then((r) => (r.rowCount ?? 0) > 0).catch(() => false);
  if (!configured && !process.env.STRIPE_SECRET_KEY) return 0;
  const { rows } = await deps.adminPool.query(
    `SELECT o.id, o.name, b.token_balance::bigint AS balance
       FROM billing_accounts b JOIN organizations o ON o.id = b.tenant_id
      WHERE o.billing_exempt = false AND b.token_balance > 0 AND b.token_balance < $1`,
    [threshold]
  );
  const week = isoWeek(new Date());
  let n = 0;
  for (const org of rows as Array<{ id: string; name: string; balance: string }>) {
    n += await emailOrgAdmins(deps.adminPool, org.id, "low_balance", { orgName: org.name, tokenBalance: Number(org.balance) },
      { dedupe: `low_balance:${org.id}:${week}` });
  }
  return n;
}

/** Unread agent messages for members who have been away ≥ DIGEST_AWAY_MINUTES,
 *  counting only messages that arrived after they were last active (so a
 *  backlog they already chose to ignore isn't re-sent every 12 hours). */
export async function sweepUnreadDigests(deps: Deps): Promise<number> {
  const { rows } = await deps.adminPool.query(
    `WITH away AS (
       SELECT m.tenant_id, m.user_id, m.last_active_at, u.email, u.display_name, o.name AS org_name
         FROM organization_memberships m
         JOIN users u ON u.id = m.user_id
         JOIN organizations o ON o.id = m.tenant_id
        WHERE u.suspended_at IS NULL AND u.email_activity_opt_out = false
          AND m.last_active_at IS NOT NULL
          AND m.last_active_at < now() - make_interval(mins => $1)
          AND m.last_active_at > now() - interval '30 days'
          AND COALESCE((m.proactive_prefs->>'notifications')::boolean, true)
     )
     SELECT a.tenant_id, a.user_id, a.email, a.display_name, a.org_name, c.name AS channel_name, count(*)::int AS unread
       FROM away a
       JOIN channels c ON c.tenant_id = a.tenant_id
       JOIN messages msg ON msg.channel_id = c.id AND msg.tenant_id = a.tenant_id
       LEFT JOIN channel_reads r ON r.tenant_id = a.tenant_id AND r.user_id = a.user_id AND r.channel_id = c.id
      WHERE msg.author_kind = 'agent' AND msg.deleted_at IS NULL
        AND msg.created_at > a.last_active_at
        AND msg.created_at > COALESCE(r.last_read_at, a.last_active_at)
        AND msg.created_at < now() - make_interval(mins => $1)
      GROUP BY a.tenant_id, a.user_id, a.email, a.display_name, a.org_name, c.name
      ORDER BY a.tenant_id, a.user_id`,
    [DIGEST_AWAY_MINUTES]
  );
  const byUser = new Map<string, { tenantId: string; userId: string; orgName: string; displayName: string; channels: { name: string; count: number }[] }>();
  for (const r of rows as Array<{ tenant_id: string; user_id: string; display_name: string; org_name: string; channel_name: string; unread: number }>) {
    const key = `${r.tenant_id}:${r.user_id}`;
    const entry = byUser.get(key) ?? { tenantId: r.tenant_id, userId: r.user_id, orgName: r.org_name, displayName: r.display_name, channels: [] };
    entry.channels.push({ name: r.channel_name, count: r.unread });
    byUser.set(key, entry);
  }
  const bucket = Math.floor(Date.now() / (DIGEST_EVERY_HOURS * 3600_000));
  let n = 0;
  for (const e of byUser.values()) {
    const total = e.channels.reduce((s, c) => s + c.count, 0);
    const id = await emailUser(deps.adminPool, e.userId, "unread_digest", { orgName: e.orgName, displayName: e.displayName, total, channels: e.channels.sort((a, b) => b.count - a.count) },
      { tenantId: e.tenantId, dedupe: `unread_digest:${e.tenantId}:${e.userId}:${bucket}` });
    if (id) n++;
  }
  return n;
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const emailWorkerConfigured = () => Boolean(emailConfig().apiKey);
