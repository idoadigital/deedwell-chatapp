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
