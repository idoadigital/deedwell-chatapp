import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

/**
 * Platform-wide analytics — revenue, token usage, and signups are all
 * directly computable from tables that already exist (billing_transactions,
 * usage_ledger, organizations.created_at); no new tracking needed. Site
 * traffic is deliberately NOT here — zero tracking infrastructure exists
 * anywhere in the codebase for that, confirmed by research; it would be a
 * separate instrumentation project, not a query against existing data.
 */
export function registerAdminAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/analytics/overview", async (req) => {
    ctx.requirePlatformAdmin(req);
    const [revenue, usage, counts, signups] = await Promise.all([
      ctx.deps.adminPool.query(
        `SELECT
           coalesce(sum(amount_cents) FILTER (WHERE completed_at >= date_trunc('month', now())), 0) AS this_month_cents,
           coalesce(sum(amount_cents), 0) AS all_time_cents
         FROM billing_transactions WHERE status = 'completed'`
      ),
      ctx.deps.adminPool.query(
        `SELECT
           coalesce(sum(quantity) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS this_month_tokens,
           coalesce(sum(quantity), 0) AS all_time_tokens
         FROM usage_ledger WHERE kind = 'model_tokens'`
      ),
      ctx.deps.adminPool.query(
        `SELECT (SELECT count(*)::int FROM organizations) AS org_count, (SELECT count(*)::int FROM users) AS user_count`
      ),
      ctx.deps.adminPool.query(
        `SELECT date_trunc('day', created_at) AS day, count(*)::int AS count
         FROM organizations WHERE created_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`
      ),
    ]);
    return {
      revenue: { thisMonthCents: Number(revenue.rows[0].this_month_cents), allTimeCents: Number(revenue.rows[0].all_time_cents) },
      tokenUsage: { thisMonth: Number(usage.rows[0].this_month_tokens), allTime: Number(usage.rows[0].all_time_tokens) },
      orgCount: counts.rows[0].org_count,
      userCount: counts.rows[0].user_count,
      signupsByDay: signups.rows.map((r) => ({ day: r.day, count: r.count })),
    };
  });

  /* Operational health.
   *
   * The overview above answers "how is the business doing". This answers "is
   * anything broken or waiting on us", which is what an admin opens the page
   * for. Every figure is a query against tables that already exist — nothing
   * here needs new instrumentation, and nothing is estimated. Site traffic is
   * still absent for the reason given at the top of this file. */
  app.get("/v1/admin/analytics/health", async (req) => {
    ctx.requirePlatformAdmin(req);
    const pool = ctx.deps.adminPool;
    const [runs, failures, approvals, support, sites, deletion, topOrgs, active, content] =
      await Promise.all([
        pool.query(
          `SELECT status, count(*)::int AS n FROM workflow_runs GROUP BY status`
        ),
        pool.query(
          `SELECT r.id, r.definition, r.last_error, r.updated_at, o.name AS org_name, p.name AS project_name
           FROM workflow_runs r
           JOIN organizations o ON o.id = r.tenant_id
           LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.status = 'failed' ORDER BY r.updated_at DESC LIMIT 6`
        ),
        pool.query(
          `SELECT count(*)::int AS pending,
                  coalesce(max(extract(epoch FROM now() - created_at)) / 3600, 0) AS oldest_hours
           FROM approvals WHERE status = 'pending'`
        ),
        // A thread is waiting on us when its newest message came from the org.
        pool.query(
          `SELECT count(*)::int AS waiting,
                  coalesce(max(extract(epoch FROM now() - last_at)) / 3600, 0) AS oldest_hours
           FROM (
             SELECT m.thread_id, max(m.created_at) AS last_at,
                    (array_agg(m.author_kind ORDER BY m.created_at DESC))[1] AS last_kind
             FROM support_messages m GROUP BY m.thread_id
           ) t WHERE t.last_kind <> 'platform_admin'`
        ),
        pool.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE external_build_url IS NOT NULL OR active_release_id IS NOT NULL)::int AS live
           FROM sites`
        ),
        pool.query(
          `SELECT count(*)::int AS pending FROM data_deletion_requests WHERE status <> 'completed'`
        ),
        pool.query(
          `SELECT o.name AS org_name, sum(u.quantity)::bigint AS tokens
           FROM usage_ledger u JOIN organizations o ON o.id = u.tenant_id
           WHERE u.kind = 'model_tokens' AND u.created_at >= date_trunc('month', now())
           GROUP BY o.name ORDER BY tokens DESC LIMIT 5`
        ),
        pool.query(
          `SELECT count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS d1,
                  count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS d7
           FROM sessions WHERE revoked_at IS NULL`
        ),
        pool.query(
          `SELECT status, count(*)::int AS n FROM content_projects GROUP BY status`
        ),
      ]);

    const byStatus = (rows: Array<{ status: string; n: number }>) =>
      Object.fromEntries(rows.map((r) => [r.status, r.n]));

    return {
      runs: byStatus(runs.rows as never),
      recentFailures: failures.rows,
      approvals: {
        pending: approvals.rows[0].pending,
        oldestHours: Math.round(Number(approvals.rows[0].oldest_hours)),
      },
      support: {
        waiting: support.rows[0].waiting,
        oldestHours: Math.round(Number(support.rows[0].oldest_hours)),
      },
      sites: { total: sites.rows[0].total, live: sites.rows[0].live },
      deletionRequests: deletion.rows[0].pending,
      topOrgsByTokens: topOrgs.rows.map((r) => ({ orgName: r.org_name, tokens: Number(r.tokens) })),
      activeUsers: { last24h: active.rows[0].d1, last7d: active.rows[0].d7 },
      content: byStatus(content.rows as never),
    };
  });

  app.get("/v1/admin/analytics/transactions", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT t.id, t.tenant_id AS org_id, o.name AS org_name, t.package_id, t.token_amount,
              t.amount_cents, t.currency, t.status, t.created_at, t.completed_at
       FROM billing_transactions t JOIN organizations o ON o.id = t.tenant_id
       ORDER BY t.created_at DESC LIMIT 500`
    );
    return { transactions: rows };
  });

  app.get("/v1/admin/organizations", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT o.id, o.name, o.slug, o.created_at,
              (SELECT count(*)::int FROM organization_memberships m WHERE m.tenant_id = o.id) AS member_count,
              (SELECT token_balance FROM billing_accounts b WHERE b.tenant_id = o.id) AS token_balance
       FROM organizations o ORDER BY o.created_at DESC LIMIT 500`
    );
    return { organizations: rows };
  });
}
