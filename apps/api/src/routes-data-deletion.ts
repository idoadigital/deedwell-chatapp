import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@deedwell/database";
import {
  newConfirmationCode, parseSignedRequest, readPlatformCredentials, SignedRequestError,
} from "@deedwell/connectors";
import type { AppContext } from "./app.js";

const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
const statusUrlFor = (code: string) => `${API_ORIGIN}/v1/connectors/data-deletion?code=${encodeURIComponent(code)}`;

/**
 * Meta Data Deletion Callback. Required for App Review: when someone removes
 * Deedwell from their Facebook settings, Meta POSTs a signed request here and
 * expects `{ url, confirmation_code }` back, with that url serving a
 * human-readable status page.
 *
 * Unauthenticated by necessity — Meta's servers have no session. The HMAC
 * signature against our own app secret is what authenticates it, which is why
 * a request that fails verification is refused rather than "handled anyway".
 */
export function registerDataDeletionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.post("/v1/connectors/meta/data-deletion", async (req, reply) => {
    const body = (req.body ?? {}) as { signed_request?: string };
    const signedRequest = body.signed_request;
    if (!signedRequest) return reply.status(400).send({ error: "Missing signed_request" });

    const credentials = await readPlatformCredentials(deps.appPool, "meta");
    if (!credentials) {
      // Cannot verify without the app secret, so cannot safely act.
      req.log.error({ at: "data_deletion.unconfigured" }, "deletion callback with no Meta credentials configured");
      return reply.status(503).send({ error: "Not configured" });
    }

    let userId: string;
    try {
      userId = parseSignedRequest(signedRequest, credentials.clientSecret).user_id!;
    } catch (err) {
      // Never echo the signed request or the reason in detail — an attacker
      // probing signatures learns nothing from a flat refusal.
      req.log.warn({ at: "data_deletion.rejected", reason: err instanceof SignedRequestError ? err.message : "invalid" });
      return reply.status(400).send({ error: "Invalid signed request" });
    }

    const confirmationCode = newConfirmationCode();
    const id = uuidv7();
    await deps.appPool.query(
      `INSERT INTO data_deletion_requests (id, provider, provider_user_id, confirmation_code)
       VALUES ($1,'meta',$2,$3)`,
      [id, userId, confirmationCode]
    );

    // Do the work now — it is small and bounded — but never let a failure stop
    // the acknowledgement: Meta requires the confirmation, and a failed
    // deletion is something we resolve and show on the status page.
    try {
      const removed = await deleteMetaUserData(deps.appPool, userId);
      await deps.appPool.query(
        `UPDATE data_deletion_requests
            SET status = $2, detail = $3, connections_removed = $4, posts_cancelled = $5, completed_at = now()
          WHERE id = $1`,
        [id, removed.connections === 0 ? "nothing_to_delete" : "completed",
         removed.summary, removed.connections, removed.posts]
      );
      req.log.info({ at: "data_deletion.completed", confirmationCode, connections: removed.connections });
    } catch (err) {
      await deps.appPool.query(
        `UPDATE data_deletion_requests SET status = 'failed', detail = $2 WHERE id = $1`,
        [id, String((err as Error).message ?? err).slice(0, 300)]
      ).catch(() => {});
      req.log.error({ at: "data_deletion.failed", confirmationCode, err: String((err as Error).message ?? err) });
    }

    return reply.send({ url: statusUrlFor(confirmationCode), confirmation_code: confirmationCode });
  });

  /** The human-readable status page Meta requires the callback's url to serve. */
  app.get("/v1/connectors/data-deletion", async (req, reply) => {
    const { code } = req.query as { code?: string };
    const { rows } = code
      ? await deps.appPool.query(
        `SELECT confirmation_code, status, detail, connections_removed, posts_cancelled, created_at, completed_at
           FROM data_deletion_requests WHERE confirmation_code = $1`, [code])
      : { rows: [] };
    return reply.type("text/html; charset=utf-8").send(statusPage(rows[0], code));
  });
}

/**
 * Everything Deedwell holds that derives from this Meta user's authorization:
 * the connections they authorized, the tokens sealed against them, and any
 * scheduled post that would publish through those connections.
 *
 * Deliberately NOT deleted: the designs the nonprofit generated in Content
 * Studio. Those are the organization's own content, not the individual's Meta
 * data, and destroying a charity's work because one staff member unlinked
 * their Facebook account would be wrong.
 */
async function deleteMetaUserData(
  pool: AppContext["deps"]["appPool"], providerUserId: string
): Promise<{ connections: number; posts: number; summary: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Runs as the app role without a tenant context: a deletion request spans
    // whichever workspaces this person connected, so it cannot be scoped to one.
    const { rows: connections } = await client.query(
      `SELECT id FROM connector_connections
        WHERE provider = 'meta' AND provider_user_id = $1 AND status <> 'disconnected'
        FOR UPDATE`,
      [providerUserId]
    );
    const ids = connections.map((c) => c.id);
    let posts = 0;
    if (ids.length) {
      const cancelled = await client.query(
        `UPDATE scheduled_posts SET status = 'failed', last_error = 'The connected account was removed at the account holder''s request.'
          WHERE connector_id = ANY($1::uuid[]) AND status IN ('draft', 'scheduled', 'publishing')`,
        [ids]
      );
      posts = cancelled.rowCount ?? 0;
      await client.query(
        `UPDATE connector_connections
            SET status = 'disconnected', disconnected_at = now(),
                encrypted_access_token = '\\x'::bytea, access_iv = '\\x'::bytea, access_tag = '\\x'::bytea,
                encrypted_refresh_token = NULL, refresh_iv = NULL, refresh_tag = NULL,
                provider_account_name = NULL, provider_account_handle = NULL,
                provider_account_avatar_url = NULL, metadata = '{}', status_detail = 'Removed at the account holder''s request.'
          WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }
    await client.query("COMMIT");
    return {
      connections: ids.length,
      posts,
      summary: ids.length === 0
        ? "No Facebook or Instagram connection was found for this account, so there was nothing to delete."
        : `Removed ${ids.length} connected account${ids.length === 1 ? "" : "s"} and the stored access credentials, and cancelled ${posts} pending post${posts === 1 ? "" : "s"}.`,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function statusPage(row: Record<string, any> | undefined, code?: string): string {
  const body = !row
    ? `<h1>Request not found</h1>
       <p>We could not find a deletion request with the code ${code ? `<code>${escape(code)}</code>` : "you provided"}.
       Check the code and try again, or email <a href="mailto:privacy@deedwell.org">privacy@deedwell.org</a> and a person will help.</p>`
    : `<h1>Your data has been ${row.status === "failed" ? "reviewed" : "removed"}</h1>
       <p class="code">Confirmation code <strong>${escape(row.confirmation_code)}</strong></p>
       <p>${escape(row.detail ?? "")}</p>
       <dl>
         <div><dt>Requested</dt><dd>${new Date(row.created_at).toUTCString()}</dd></div>
         ${row.completed_at ? `<div><dt>Completed</dt><dd>${new Date(row.completed_at).toUTCString()}</dd></div>` : ""}
         <div><dt>Status</dt><dd>${escape(String(row.status).replace(/_/g, " "))}</dd></div>
       </dl>
       ${row.status === "failed"
        ? `<p class="warn">Something went wrong completing this automatically and a person has been alerted.
           Email <a href="mailto:privacy@deedwell.org">privacy@deedwell.org</a> quoting the code above and we will finish it by hand.</p>`
        : `<p>Content your organization created in Deedwell is kept, because it belongs to the organization
           rather than to your Facebook account. To remove that too, ask an administrator of your Deedwell
           workspace, or email <a href="mailto:privacy@deedwell.org">privacy@deedwell.org</a>.</p>`}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data deletion — Deedwell</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:32px;
         background:#0e1005; color:#efe7d2;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif }
  main { width:min(560px,100%); padding:36px; border:1px solid rgba(239,231,210,.1);
         border-radius:18px; background:rgba(255,255,255,.02) }
  h1 { margin:0 0 14px; font-family:Georgia,serif; font-weight:400; font-size:1.9rem; letter-spacing:-.015em }
  p { color:rgba(239,231,210,.74) } a { color:#dae470 }
  .code { color:rgba(239,231,210,.6); font-size:.92rem }
  code, strong { color:#dae470 }
  dl { display:grid; gap:10px; margin:24px 0 0; padding-top:20px; border-top:1px solid rgba(239,231,210,.1) }
  dl > div { display:flex; justify-content:space-between; gap:18px }
  dt { color:rgba(239,231,210,.58); font-size:.88rem } dd { margin:0; font-size:.9rem }
  .warn { color:#e9c07a }
</style></head><body><main>${body}</main></body></html>`;
}
