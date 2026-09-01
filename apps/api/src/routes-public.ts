import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app.js";

/** Funding Passport facts that are safe to hand to the platform API — the
 *  ones a website build actually draws on. Mirrors WEBSITE_ESSENTIAL_FACTS
 *  in @deedwell/website-domain, plus ein. */
const PUBLIC_ORG_FACT_KEYS = ["mission", "ein", "programs", "beneficiaries", "service_area", "headquarters"];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Read-only, platform-wide developer API: this is the data feed for the
 *  external application whose job is to run an AI agent that builds
 *  nonprofit websites — it needs to see every nonprofit's site, not just
 *  one. A single API key (provisioned by a Deedwell platform admin — see
 *  routes-admin.ts) covers the whole platform, so these routes read
 *  through ctx.deps.adminPool directly rather than a tenant-scoped
 *  connection: there is no single tenant to scope to. */
export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/public/websites", async (req) => {
    ctx.requireApiScope(req, "websites:read");
    const { limit: limitRaw, cursor } = req.query as { limit?: string; cursor?: string };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(limitRaw) || DEFAULT_LIMIT));
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT s.id, s.slug, s.name, s.status, s.project_id, s.tenant_id AS org_id,
              o.name AS org_name, s.created_at, s.updated_at
       FROM sites s JOIN organizations o ON o.id = s.tenant_id
       WHERE ($1::timestamptz IS NULL OR s.created_at < $1)
       ORDER BY s.created_at DESC
       LIMIT $2`,
      [cursor ?? null, limit]
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;
    return { websites: rows, nextCursor };
  });

  app.get("/v1/public/websites/:siteId", async (req) => {
    ctx.requireApiScope(req, "websites:read");
    const { siteId } = req.params as { siteId: string };
    const site = await ctx.deps.adminPool.query(
      `SELECT s.id, s.slug, s.name, s.status, s.theme, s.tenant_id AS org_id,
              o.name AS org_name, s.created_at, s.updated_at
       FROM sites s JOIN organizations o ON o.id = s.tenant_id
       WHERE s.id = $1`,
      [siteId]
    );
    if (!site.rows[0]) return { website: null };
    const siteRow = site.rows[0];
    const [pages, intake, facts] = await Promise.all([
      ctx.deps.adminPool.query(
        "SELECT slug, title, order_idx, blocks, seo FROM site_pages WHERE site_id = $1 ORDER BY order_idx",
        [siteId]
      ),
      ctx.deps.adminPool.query(
        "SELECT question_key, value FROM site_intake_answers WHERE site_id = $1",
        [siteId]
      ),
      ctx.deps.adminPool.query(
        "SELECT fact_key, value, status FROM org_facts WHERE tenant_id = $1 AND fact_key = ANY($2)",
        [siteRow.org_id, PUBLIC_ORG_FACT_KEYS]
      ),
    ]);
    return {
      website: {
        id: siteRow.id,
        slug: siteRow.slug,
        name: siteRow.name,
        status: siteRow.status,
        theme: siteRow.theme,
        orgId: siteRow.org_id,
        orgName: siteRow.org_name,
        pages: pages.rows,
        intake: Object.fromEntries(intake.rows.map((r) => [r.question_key, r.value])),
        organization: Object.fromEntries(facts.rows.map((r) => [r.fact_key, { value: r.value, status: r.status }])),
        createdAt: siteRow.created_at,
        updatedAt: siteRow.updated_at,
      },
    };
  });

  app.get("/v1/public/websites/:siteId/submissions", async (req) => {
    ctx.requireApiScope(req, "websites:read");
    const { siteId } = req.params as { siteId: string };
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT id, form_key, payload, created_at FROM form_submissions
       WHERE site_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [siteId]
    );
    return { submissions: rows };
  });
}
