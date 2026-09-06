import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { audit, uuidv7 } from "@deedwell/database";
import { decryptSecret, encryptSecret } from "@deedwell/auth";
import {
  GoogleProvider, getProvider, listProviders, readPlatformCredentials,
  type ConnectionView, type OAuthTokens,
} from "@deedwell/connectors";
import { HttpError, type AppContext } from "./app.js";

const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://deedwell.org";
const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
const STATE_TTL_MS = 10 * 60 * 1000;

const redirectUriFor = (provider: string) => `${API_ORIGIN}/v1/connectors/${provider}/callback`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** The only shape that ever reaches the browser. Token columns are not
 *  selected, let alone mapped — a leak would have to be written deliberately. */
function toView(row: Record<string, any>): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    connectorType: row.connector_type,
    accountName: row.provider_account_name,
    accountHandle: row.provider_account_handle,
    accountAvatarUrl: row.provider_account_avatar_url,
    status: row.status,
    statusDetail: row.status_detail,
    scopes: row.scopes ?? [],
    connectedAt: row.created_at,
    metadata: sanitizeMetadata(row.metadata ?? {}),
  };
}

/** Page access tokens live in metadata; they must never be serialised out. */
function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/token|secret|password/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function seal(tokens: OAuthTokens) {
  const access = encryptSecret(Buffer.from(tokens.accessToken, "utf8"));
  const refresh = tokens.refreshToken ? encryptSecret(Buffer.from(tokens.refreshToken, "utf8")) : null;
  return { access, refresh };
}

function unseal(row: Record<string, any>): OAuthTokens {
  return {
    accessToken: decryptSecret({
      ciphertext: row.encrypted_access_token, iv: row.access_iv, tag: row.access_tag, keyVersion: row.key_version,
    }).toString("utf8"),
    refreshToken: row.encrypted_refresh_token
      ? decryptSecret({
        ciphertext: row.encrypted_refresh_token, iv: row.refresh_iv, tag: row.refresh_tag, keyVersion: row.key_version,
      }).toString("utf8")
      : null,
    expiresAt: row.token_expires_at,
    scopes: row.scopes ?? [],
  };
}

export function registerConnectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  /** Catalogue + this tenant's connections. The catalogue is the registry, so
   *  a new provider appears here with no change to this route. */
  app.get("/v1/orgs/:orgId/connectors", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT * FROM connector_connections WHERE status <> 'disconnected' ORDER BY created_at`
      )
    );
    return {
      catalogue: (await listProviders(deps.appPool)).map((p) => ({
        provider: p.provider,
        label: p.label,
        available: p.isConfigured(),
      })),
      connections: rows.map(toView),
    };
  });

  /** Mints a single-use state and hands back the provider's authorize URL.
   *  The browser opens it in a popup; no secret ever goes to the client. */
  app.post("/v1/orgs/:orgId/connectors/:provider/authorize", async (req) => {
    ctx.requireRole(req, "admin");
    const { provider: name } = req.params as { provider: string };
    const provider = await getProvider(deps.appPool, name);
    if (!provider) throw new HttpError(404, "Unknown connector");
    if (!provider.isConfigured()) {
      // A platform misconfiguration is not the tenant's problem — say so
      // plainly and leave the detail for the administrator's logs.
      req.log.error({ at: "connector.platform_unconfigured", provider: name },
        "tenant tried to connect a provider with no platform credentials");
      throw new HttpError(503, `${provider.label} connections are temporarily unavailable.`);
    }
    // Optional feature scopes (Google Drive, Calendar…) are asked for only
    // when a feature needs them; the base connection stays minimal.
    const { features = [] } = ((req.body ?? {}) as { features?: string[] });
    const extraScopes = name === "google"
      ? (Array.isArray(features) ? features : []).flatMap((f) => GoogleProvider.OPTIONAL_SCOPES[String(f)] ?? [])
      : [];
    const state = randomBytes(32).toString("base64url");
    await ctx.inOrg(req, (client) =>
      client.query(
        `INSERT INTO connector_oauth_states (id, tenant_id, provider, state_hash, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), req.orgId, name, hash(state), req.userId, new Date(Date.now() + STATE_TTL_MS)]
      )
    );
    return { authorizeUrl: provider.authorizeUrl({ state, redirectUri: redirectUriFor(name), extraScopes }) };
  });

  /** Provider redirect lands here. Everything sensitive happens in this
   *  handler; the popup only ever sees an HTML page telling it to close. */
  app.get("/v1/connectors/:provider/callback", async (req, reply) => {
    const { provider: name } = req.params as { provider: string };
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const provider = await getProvider(deps.appPool, name);
    if (error) return reply.type("text/html").send(closePopup({ ok: false, message: error }));
    if (!provider || !code || !state) {
      return reply.type("text/html").send(closePopup({ ok: false, message: "Authorization was incomplete." }));
    }
    try {
      // The state row is the ONLY thing that establishes which tenant this
      // authorization belongs to — never a query parameter the caller controls.
      const claimed = await deps.appPool.query(
        `UPDATE connector_oauth_states SET consumed_at = now()
         WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING tenant_id, created_by`,
        [hash(state), name]
      );
      const stateRow = claimed.rows[0];
      if (!stateRow) throw new Error("This authorization link has already been used or has expired.");

      const tokens = await provider.exchangeCode({ code, redirectUri: redirectUriFor(name) });
      const accounts = await provider.listAccounts(tokens);
      if (!accounts.length) throw new Error("No manageable accounts were returned.");

      // A single account needs no selection step; several become a choice in
      // the app, staged against the tenant with the tokens already sealed.
      const pending = uuidv7();
      const { access, refresh } = seal(tokens);
      await withTenant(deps, stateRow.tenant_id, stateRow.created_by, async (client) => {
        await client.query(
          `INSERT INTO connector_connections
             (id, tenant_id, provider, connector_type, provider_account_id, provider_account_name,
              provider_account_handle, provider_account_avatar_url, encrypted_access_token, access_iv,
              access_tag, encrypted_refresh_token, refresh_iv, refresh_tag, key_version, token_expires_at,
              scopes, status, metadata, connected_by_user_id)
           VALUES ($1,$2,$3,'pending_selection',$4,NULL,NULL,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,'needs_attention',$14,$15)`,
          [pending, stateRow.tenant_id, name, `pending:${pending}`,
           access.ciphertext, access.iv, access.tag,
           refresh?.ciphertext ?? null, refresh?.iv ?? null, refresh?.tag ?? null,
           access.keyVersion, tokens.expiresAt ?? null, tokens.scopes,
           JSON.stringify({ candidates: accounts }), stateRow.created_by]
        );
        await audit(client, {
          tenantId: stateRow.tenant_id, actorUser: stateRow.created_by, action: "connector.authorized",
          entityType: "connector_connections", entityId: pending, metadata: { provider: name },
        });
      });
      return reply.type("text/html").send(closePopup({ ok: true, provider: name, pending }));
    } catch (err) {
      req.log.error({ err, provider: name }, "connector callback failed");
      return reply.type("text/html").send(closePopup({ ok: false, message: (err as Error).message }));
    }
  });

  /** Turns a pending authorization into the accounts the user actually chose. */
  app.post("/v1/orgs/:orgId/connectors/:provider/select", async (req) => {
    ctx.requireRole(req, "admin");
    const { provider: name } = req.params as { provider: string };
    const { pendingId, accountIds } = req.body as { pendingId?: string; accountIds?: string[] };
    if (!pendingId || !accountIds?.length) throw new HttpError(400, "Choose at least one account to connect.");

    return ctx.inOrg(req, async (client) => {
      const pending = await client.query(
        `SELECT * FROM connector_connections WHERE id = $1 AND provider = $2 AND connector_type = 'pending_selection'`,
        [pendingId, name]
      );
      const row = pending.rows[0];
      if (!row) throw new HttpError(404, "That authorization is no longer available — reconnect to try again.");
      const candidates = (row.metadata?.candidates ?? []) as Array<Record<string, any>>;
      const chosen = candidates.filter((c) => accountIds.includes(c.providerAccountId));
      if (!chosen.length) throw new HttpError(400, "Those accounts were not part of this authorization.");

      const created: ConnectionView[] = [];
      for (const account of chosen) {
        // Replace any existing live connection to the same account.
        await client.query(
          `UPDATE connector_connections SET status = 'disconnected', disconnected_at = now()
           WHERE provider = $1 AND connector_type = $2 AND provider_account_id = $3 AND status <> 'disconnected'`,
          [name, account.connectorType, account.providerAccountId]
        );
        const id = uuidv7();
        const { rows } = await client.query(
          `INSERT INTO connector_connections
             (id, tenant_id, provider, connector_type, provider_account_id, provider_account_name,
              provider_account_handle, provider_account_avatar_url, encrypted_access_token, access_iv,
              access_tag, encrypted_refresh_token, refresh_iv, refresh_tag, key_version, token_expires_at,
              scopes, status, metadata, connected_by_user_id)
           SELECT $1, tenant_id, provider, $2, $3, $4, $5, $6, encrypted_access_token, access_iv,
                  access_tag, encrypted_refresh_token, refresh_iv, refresh_tag, key_version, token_expires_at,
                  scopes, 'connected', $7, connected_by_user_id
             FROM connector_connections WHERE id = $8
           RETURNING *`,
          [id, account.connectorType, account.providerAccountId, account.name ?? null,
           account.handle ?? null, account.avatarUrl ?? null,
           JSON.stringify(account.metadata ?? {}), pendingId]
        );
        created.push(toView(rows[0]));
      }
      await client.query(
        `UPDATE connector_connections SET status = 'disconnected', disconnected_at = now(), metadata = '{}'
         WHERE id = $1`,
        [pendingId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "connector.connected",
        entityType: "connector_connections", metadata: { provider: name, accounts: accountIds.length },
      });
      return { connections: created };
    });
  });

  app.delete("/v1/orgs/:orgId/connectors/:id", async (req) => {
    ctx.requireRole(req, "admin");
    const { id } = req.params as { id: string };
    await ctx.inOrg(req, async (client) => {
      // The WHERE clause is tenant-scoped by RLS; an id from another workspace
      // simply matches nothing.
      const { rows } = await client.query(
        `UPDATE connector_connections SET status = 'disconnected', disconnected_at = now()
         WHERE id = $1 AND status <> 'disconnected' RETURNING provider`,
        [id]
      );
      if (!rows[0]) throw new HttpError(404, "Connection not found");
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "connector.disconnected",
        entityType: "connector_connections", entityId: id, metadata: { provider: rows[0].provider },
      });
    });
    return { ok: true };
  });

  /** Liveness probe used by the card's status and by the publishing worker. */
  app.post("/v1/orgs/:orgId/connectors/:id/validate", async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    return ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT * FROM connector_connections WHERE id = $1", [id]);
      const row = rows[0];
      if (!row) throw new HttpError(404, "Connection not found");
      const provider = await getProvider(deps.appPool, row.provider);
      if (!provider) throw new HttpError(400, "Unknown connector");
      const result = await provider.validate(unseal(row));
      const status = result.ok ? "connected" : "needs_attention";
      await client.query(
        `UPDATE connector_connections SET status = $2, status_detail = $3 WHERE id = $1`,
        [id, status, result.ok ? null : (result.detail ?? "Reconnect required").slice(0, 300)]
      );
      return { status, detail: result.detail ?? null };
    });
  });
}

/** The callback runs outside a request's org context, so the tenant from the
 *  state row has to be established explicitly. */
async function withTenant(
  deps: AppContext["deps"], tenantId: string, userId: string,
  fn: (client: PoolClient) => Promise<void>
): Promise<void> {
  const { withContext } = await import("@deedwell/database");
  await withContext(deps.appPool, { tenantId, userId }, fn);
}

/** The popup's whole job is to hand the result back and close. postMessage is
 *  origin-pinned so another tab cannot forge a "connected" result. */
function closePopup(payload: Record<string, unknown>): string {
  return `<!doctype html><meta charset="utf-8"><title>Deedwell</title>
<body style="font:15px system-ui;background:#1c1e23;color:#eceae4;display:grid;place-items:center;height:100vh;margin:0">
<p>${payload.ok ? "Connected — you can close this window." : "Could not connect."}</p>
<script>
  try { window.opener && window.opener.postMessage(${JSON.stringify({ source: "deedwell-connector", ...payload })}, ${JSON.stringify(APP_ORIGIN)}) } catch (e) {}
  setTimeout(function () { window.close() }, 400)
</script></body>`;
}
