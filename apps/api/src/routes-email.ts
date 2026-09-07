import type { FastifyInstance } from "fastify";
import { escapeHtml, verifyUnsubscribeToken, emailConfig } from "@deedwell/email";
import { HttpError, type AppContext } from "./app.js";

/**
 * Email preferences. Activity mail (work updates, digests, co-worker
 * follow-ups) can be switched off per person; account, billing and security
 * mail cannot. The unsubscribe link in every activity email lands on the
 * GET route below without a session — the HMAC in the link is the credential.
 */
export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.get("/v1/email/unsubscribe", async (req, reply) => {
    const { u, t, resubscribe } = req.query as { u?: string; t?: string; resubscribe?: string };
    const cfg = emailConfig();
    const valid = typeof u === "string" && typeof t === "string" && /^[0-9a-f-]{36}$/i.test(u) && verifyUnsubscribeToken(u, t, cfg.unsubscribeSecret);
    if (!valid) return reply.status(400).type("text/html").send(page("This link isn't valid", "The unsubscribe link is incomplete or was altered. Open Settings → Notifications in your dashboard to change email preferences instead.", cfg.appOrigin, null));
    const optOut = resubscribe !== "1";
    await deps.adminPool.query("UPDATE users SET email_activity_opt_out = $2 WHERE id = $1", [u, optOut]);
    const undo = `${cfg.coworkersOrigin}/v1/email/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}${optOut ? "&resubscribe=1" : ""}`;
    return reply.type("text/html").send(optOut
      ? page("You're unsubscribed", "You won't get activity emails from your Deedwell co-workers any more. Account, billing and security emails still arrive. Changed your mind?", cfg.appOrigin, { label: "Resubscribe", url: undo })
      : page("Welcome back", "Activity emails from your co-workers are back on.", cfg.appOrigin, { label: "Open the dashboard", url: `${cfg.appOrigin}/dashboard` }));
  });

  // One-click unsubscribe (RFC 8058): mail clients POST here from the header.
  app.post("/v1/email/unsubscribe", async (req, reply) => {
    const { u, t } = req.query as { u?: string; t?: string };
    const cfg = emailConfig();
    if (typeof u !== "string" || typeof t !== "string" || !verifyUnsubscribeToken(u, t, cfg.unsubscribeSecret)) return reply.status(400).send({ error: "invalid" });
    await deps.adminPool.query("UPDATE users SET email_activity_opt_out = true WHERE id = $1", [u]);
    return { ok: true };
  });

  app.get("/v1/me/email-preferences", async (req) => {
    if (!req.userId) throw new HttpError(401, "Authentication required");
    const { rows } = await deps.appPool.query("SELECT email_activity_opt_out FROM users WHERE id = $1", [req.userId]);
    return { activityEmails: !rows[0]?.email_activity_opt_out };
  });

  app.patch("/v1/me/email-preferences", async (req) => {
    if (!req.userId) throw new HttpError(401, "Authentication required");
    const { activityEmails } = req.body as { activityEmails?: unknown };
    if (typeof activityEmails !== "boolean") throw new HttpError(400, "activityEmails must be true or false");
    await deps.appPool.query("UPDATE users SET email_activity_opt_out = $2 WHERE id = $1", [req.userId, !activityEmails]);
    return { activityEmails };
  });

  /** Recent mail for the workspace — what went out, what's pending, what
   *  failed and why. Admins use it to answer "did the receipt send?". */
  app.get("/v1/orgs/:orgId/email/outbox", async (req) => {
    ctx.requireRole(req, "admin");
    const rows = await ctx.inOrg(req, async (client) =>
      (await client.query(
        `SELECT id, to_email, kind, category, status, attempt_count, last_error, created_at, sent_at
           FROM email_outbox WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.orgId]
      )).rows
    );
    return { emails: rows };
  });

  app.get("/v1/admin/email/outbox", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { status, limit } = req.query as { status?: string; limit?: string };
    const { rows } = await deps.adminPool.query(
      `SELECT e.id, e.tenant_id, o.name AS org_name, e.to_email, e.kind, e.category, e.status, e.attempt_count, e.last_error, e.provider_message_id, e.created_at, e.sent_at
         FROM email_outbox e LEFT JOIN organizations o ON o.id = e.tenant_id
        WHERE ($1::text IS NULL OR e.status = $1) ORDER BY e.created_at DESC LIMIT $2`,
      [status ?? null, Math.min(Number(limit ?? 100), 500)]
    );
    return { emails: rows };
  });
}

function page(title: string, body: string, origin: string, cta: { label: string; url: string } | null): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — Deedwell</title>
<style>body{margin:0;background:#faf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101d25}main{max-width:520px;margin:64px auto;padding:0 20px}img{width:150px;display:block;margin-bottom:24px}.card{background:#fff;border:1px solid #dfe3de;border-radius:14px;padding:32px}h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;margin:0 0 12px}p{line-height:1.55;margin:0 0 20px}a.btn{display:inline-block;background:#94b0d2;color:#1a1a1a;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px}footer{margin-top:24px;font-size:12px;color:#53616b}</style></head>
<body><main><a href="${escapeHtml(origin)}"><img src="${escapeHtml(origin)}/assets/logo-black.png" alt="Deedwell"></a><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${cta ? `<a class="btn" href="${escapeHtml(cta.url)}">${escapeHtml(cta.label)}</a>` : ""}</div><footer>Deedwell · Atlanta, Georgia · hello@deedwell.org</footer></main></body></html>`;
}
