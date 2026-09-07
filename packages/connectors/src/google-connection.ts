/**
 * Centralized Google connection service — the one place that hands out a
 * usable Google access token. Every Google feature (Drive today, Gmail,
 * Calendar, Sheets and the Ad Grants identity next) goes through
 * `require()`:
 *
 *   - finds the workspace's live Google account connection,
 *   - checks the scopes the feature needs against what was granted,
 *   - refreshes the access token when it is about to expire and persists it,
 *   - on a refresh failure flips the connection to expired/needs_attention,
 *     tells the workspace admins, and reports it as such,
 *   - writes an audit row for every authentication event.
 *
 * Every query runs on the caller's tenant-scoped client (RLS), and the
 * WHERE clause carries the tenant id anyway so the same code is safe on the
 * admin pool from a worker. Tokens are sealed with the platform's AES-GCM
 * envelope and never leave this module in the clear except as the return
 * value of `require()`.
 */
import type { Pool, PoolClient } from "pg";
import { audit, withContext } from "@deedwell/database";
import { encryptSecret } from "@deedwell/auth";
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { unseal } from "./health.js";
import { getProvider } from "./registry.js";
import { GOOGLE_SERVICES, missingScopes, normalizeScopes, serviceStatuses, type GoogleServiceStatus } from "./google-services.js";
import type { ConnectionView, ConnectorProvider, OAuthTokens } from "./types.js";

type Queryable = Pick<PoolClient, "query">;

export type GoogleConnectionErrorCode = "not_connected" | "missing_scopes" | "expired" | "unavailable";

export class GoogleConnectionError extends Error {
  constructor(readonly code: GoogleConnectionErrorCode, message: string, readonly missing: string[] = []) {
    super(message);
    this.name = "GoogleConnectionError";
  }
}

export interface GoogleConnectionSummary extends ConnectionView {
  /** Normalized granted scopes. */
  grantedScopes: string[];
  services: GoogleServiceStatus[];
}

export interface GoogleAccess {
  accessToken: string;
  connectionId: string;
  accountHandle: string | null;
  scopes: string[];
}

const REFRESH_AHEAD_MS = 60_000;

export class GoogleConnectionService {
  constructor(private readonly pool: Pool, private readonly log?: { warn(o: unknown, m?: string): void; info(o: unknown, m?: string): void }) {}

  /** The workspace's live Google account connection, newest first. */
  async find(client: Queryable, tenantId: string): Promise<Record<string, any> | null> {
    const { rows } = await client.query(
      `SELECT * FROM connector_connections
        WHERE tenant_id = $1 AND provider = 'google' AND connector_type = 'google_account' AND status <> 'disconnected'
        ORDER BY (status = 'connected') DESC, created_at DESC LIMIT 1`,
      [tenantId]
    );
    return (rows[0] as Record<string, any>) ?? null;
  }

  /** What the dashboard shows: the account plus every Google service and
   *  whether its scopes are granted. Never includes token material. */
  async describe(client: Queryable, tenantId: string): Promise<GoogleConnectionSummary | null> {
    const row = await this.find(client, tenantId);
    if (!row) return null;
    return summarize(row);
  }

  /** Scopes a feature still needs on top of what the workspace granted. An
   *  empty array means the feature can run right now. */
  async missingFor(client: Queryable, tenantId: string, scopes: string[]): Promise<{ connection: Record<string, any> | null; missing: string[] }> {
    const row = await this.find(client, tenantId);
    return { connection: row, missing: missingScopes(row?.scopes ?? [], scopes) };
  }

  /**
   * A live access token covering `scopes`. Throws GoogleConnectionError with a
   * code the caller maps to its own UX (Drive: 409 + "Connect Google Drive").
   */
  async require(client: Queryable, tenantId: string, args: { scopes: string[]; actorUserId?: string | null; feature?: string }): Promise<GoogleAccess> {
    const row = await this.find(client, tenantId);
    if (!row || row.status === "disconnected") throw new GoogleConnectionError("not_connected", "Connect a Google account first.");
    const missing = missingScopes(row.scopes ?? [], args.scopes);
    if (missing.length) {
      // Recorded in its own transaction: the caller's is about to roll back
      // on the throw, and a refused access must still leave a trace.
      await this.aside(tenantId, args.actorUserId ?? null, (c) => audit(c, {
        tenantId, actorUser: args.actorUserId ?? null, action: "google.access_denied",
        entityType: "connector_connections", entityId: row.id, metadata: { feature: args.feature ?? null, missing },
      }));
      throw new GoogleConnectionError("missing_scopes", "This Google connection has not been granted the permissions this feature needs.", missing);
    }
    if (row.status !== "connected") {
      throw new GoogleConnectionError("expired", row.status_detail ?? "The Google connection needs to be reconnected.");
    }
    const provider = await getProvider(this.pool, "google");
    if (!provider?.refresh) throw new GoogleConnectionError("unavailable", "Google connections are temporarily unavailable.");

    let tokens = unseal(row);
    const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : 0;
    if (expiresAt && expiresAt < Date.now() + REFRESH_AHEAD_MS) {
      tokens = await this.refresh(client, tenantId, row, provider, tokens, args.actorUserId ?? null);
    }
    return { accessToken: tokens.accessToken, connectionId: row.id, accountHandle: row.provider_account_handle ?? null, scopes: normalizeScopes(row.scopes ?? []) };
  }

  private async refresh(client: Queryable, tenantId: string, row: Record<string, any>, provider: ConnectorProvider, tokens: OAuthTokens, actorUserId: string | null): Promise<OAuthTokens> {
    try {
      const fresh = await provider.refresh!(tokens);
      const access = encryptSecret(Buffer.from(fresh.accessToken, "utf8"));
      await client.query(
        `UPDATE connector_connections
            SET encrypted_access_token = $3, access_iv = $4, access_tag = $5, key_version = $6, token_expires_at = $7
          WHERE id = $1 AND tenant_id = $2`,
        [row.id, tenantId, access.ciphertext, access.iv, access.tag, access.keyVersion, fresh.expiresAt ?? null]
      );
      await audit(client as PoolClient, {
        tenantId, actorUser: actorUserId, action: "google.token_refreshed",
        entityType: "connector_connections", entityId: row.id, metadata: { expiresAt: fresh.expiresAt ?? null },
      });
      return fresh;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const expired = /invalid_grant|expired|revoked/i.test(message);
      const status = expired ? "expired" : "needs_attention";
      const detail = expired ? "The Google connection expired and needs to be reconnected." : "Google could not refresh this connection. Reconnect to keep using it.";
      // Own transaction (see access_denied above): the status flip, the audit
      // row and the admin email must outlive the caller's rollback.
      await this.aside(tenantId, actorUserId, async (c) => {
        await c.query(
          `UPDATE connector_connections SET status = $3, status_detail = $4 WHERE id = $1 AND tenant_id = $2`,
          [row.id, tenantId, status, detail]
        );
        await audit(c, {
          tenantId, actorUser: actorUserId, action: "google.refresh_failed",
          entityType: "connector_connections", entityId: row.id, metadata: { status, error: message.slice(0, 300) },
        });
        await emailOrgAdmins(c, tenantId, "connector_attention", {
          orgName: await orgNameOf(c, tenantId), provider: "Google", accountName: row.provider_account_handle ?? row.provider_account_name ?? null, detail,
        }, { dedupe: `connector_attention:${row.id}:${new Date().toISOString().slice(0, 10)}` });
      });
      this.log?.warn({ at: "google.refresh_failed", tenantId, connectionId: row.id, err: message });
      throw new GoogleConnectionError("expired", detail);
    }
  }

  /** Runs bookkeeping in a transaction of its own, tenant-scoped, so it
   *  survives the caller's transaction being rolled back by the error we
   *  are about to throw. Never throws itself. */
  private async aside(tenantId: string, actorUserId: string | null, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
    try { await withContext(this.pool, { tenantId, userId: actorUserId }, fn); }
    catch (err) { this.log?.warn({ at: "google.bookkeeping_failed", tenantId, err: String(err) }); }
  }

  /** A feature saw Google refuse the token (401/403) outside a refresh: flag
   *  the connection so the dashboard says reconnect, tell the admins, audit. */
  async markNeedsAttention(client: Queryable, tenantId: string, connectionId: string, detail: string, actorUserId: string | null): Promise<void> {
    const { rows } = await client.query(
      `UPDATE connector_connections SET status = 'needs_attention', status_detail = $3 WHERE id = $1 AND tenant_id = $2
       RETURNING provider_account_handle, provider_account_name`,
      [connectionId, tenantId, detail.slice(0, 300)]
    );
    await audit(client as PoolClient, {
      tenantId, actorUser: actorUserId, action: "google.needs_attention",
      entityType: "connector_connections", entityId: connectionId, metadata: { detail },
    });
    if (rows[0]) {
      await emailOrgAdmins(client, tenantId, "connector_attention", {
        orgName: await orgNameOf(client, tenantId), provider: "Google Drive", accountName: rows[0].provider_account_handle ?? rows[0].provider_account_name ?? null, detail,
      }, { dedupe: `connector_attention:${connectionId}:${new Date().toISOString().slice(0, 10)}` }).catch(() => undefined);
    }
  }

  /** Records the scopes a completed (incremental) authorization added. */
  async recordGrant(client: Queryable, tenantId: string, args: { connectionId: string; previousScopes: string[]; scopes: string[]; actorUserId: string | null }): Promise<string[]> {
    const added = missingScopes(args.previousScopes, args.scopes);
    await audit(client as PoolClient, {
      tenantId, actorUser: args.actorUserId, action: added.length ? "google.scopes_granted" : "google.reauthorized",
      entityType: "connector_connections", entityId: args.connectionId,
      metadata: { added, granted: normalizeScopes(args.scopes), services: serviceStatuses(args.scopes).filter((s) => s.granted).map((s) => s.key) },
    });
    return added;
  }

  /** Best-effort revocation at Google, then the local disconnect the caller
   *  performs. Never throws: a dead token cannot be revoked and that is fine. */
  async revokeAtProvider(client: Queryable, tenantId: string, row: Record<string, any>, actorUserId: string | null): Promise<void> {
    try {
      const provider = await getProvider(this.pool, "google");
      if (provider?.revoke) await provider.revoke(unseal(row));
      await audit(client as PoolClient, {
        tenantId, actorUser: actorUserId, action: "google.revoked",
        entityType: "connector_connections", entityId: row.id, metadata: {},
      });
    } catch (err) {
      this.log?.warn({ at: "google.revoke_failed", connectionId: row.id, err: String(err) });
    }
  }
}

export function summarize(row: Record<string, any>): GoogleConnectionSummary {
  const grantedScopes = normalizeScopes(row.scopes ?? []);
  return {
    id: row.id,
    provider: row.provider,
    connectorType: row.connector_type,
    accountName: row.provider_account_name ?? null,
    accountHandle: row.provider_account_handle ?? null,
    accountAvatarUrl: row.provider_account_avatar_url ?? null,
    status: row.status,
    statusDetail: row.status_detail ?? null,
    scopes: grantedScopes,
    connectedAt: row.created_at,
    metadata: {},
    grantedScopes,
    services: serviceStatuses(grantedScopes),
  };
}

export { GOOGLE_SERVICES };
