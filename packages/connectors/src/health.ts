import type { Pool } from "pg";
import { decryptSecret } from "@deedwell/auth";
import { withContext } from "@deedwell/database";
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { getProvider } from "./registry.js";
import type { ConnectorStatus, OAuthTokens } from "./types.js";

export interface HealthResult {
  status: ConnectorStatus;
  detail: string | null;
}

/** Classifies a provider failure into something a nonprofit can act on, and
 *  writes it to the connection so scheduled work stops retrying forever
 *  against a credential that will never work again. */
export class ConnectorHealthService {
  /** `actorId` is the user whose action triggered the check, or the connection
   *  owner when the worker runs it — withContext requires one either way. */
  constructor(private readonly pool: Pool) {}

  static classify(error: unknown): HealthResult {
    const message = String((error as Error)?.message ?? error);
    // Meta: 190 = invalid/expired token, 200/10 = missing permission.
    // Google: invalid_grant = revoked or expired refresh token.
    if (/expired|invalid_grant|code 190|OAuthException/i.test(message)) {
      return { status: "expired", detail: "The connection expired and needs to be reconnected." };
    }
    if (/permission|scope|insufficient|#200|#10/i.test(message)) {
      return { status: "needs_attention", detail: "Deedwell no longer has permission to publish to this account." };
    }
    if (/not found|deleted|does not exist/i.test(message)) {
      return { status: "needs_attention", detail: "That account is no longer reachable — it may have been removed." };
    }
    return { status: "needs_attention", detail: "The connection needs to be refreshed." };
  }

  /** Live probe against the provider. */
  async check(tenantId: string, connectionId: string, actorId: string): Promise<HealthResult> {
    const row: Record<string, any> | undefined = await withContext(this.pool, { tenantId, userId: actorId }, async (client) => {
      const { rows } = await client.query("SELECT * FROM connector_connections WHERE id = $1", [connectionId]);
      return rows[0];
    });
    if (!row) return { status: "disconnected", detail: "Connection not found." };

    const provider = await getProvider(this.pool, row.provider);
    if (!provider) return { status: "needs_attention", detail: "This connector is no longer supported." };
    if (!provider.isConfigured()) {
      // A platform misconfiguration is not the tenant's fault and must not be
      // reported to them as a broken connection.
      return { status: row.status, detail: "Temporarily unavailable — an administrator has been notified." };
    }

    const tokens = unseal(row);
    const result = await provider.validate(tokens).catch((err) => ({ ok: false, detail: String(err?.message ?? err) }));
    const health: HealthResult = result.ok
      ? { status: "connected", detail: null }
      : ConnectorHealthService.classify(result.detail);
    await this.record(tenantId, connectionId, health, actorId);
    return health;
  }

  async record(tenantId: string, connectionId: string, health: HealthResult, actorId: string): Promise<void> {
    await withContext(this.pool, { tenantId, userId: actorId }, async (client) => {
      const { rows } = await client.query(
        `UPDATE connector_connections SET status = $2, status_detail = $3 WHERE id = $1
         RETURNING provider, connector_type, provider_account_name`,
        [connectionId, health.status, health.detail?.slice(0, 300) ?? null]
      );
      // A dead connection silently breaks every scheduled post after it;
      // the admins hear once a day per connection until it's fixed.
      if (rows[0] && (health.status === "expired" || health.status === "needs_attention")) {
        await emailOrgAdmins(client, tenantId, "connector_attention", {
          orgName: await orgNameOf(client, tenantId),
          provider: providerLabel(rows[0].provider, rows[0].connector_type),
          accountName: rows[0].provider_account_name ?? null, detail: health.detail,
        }, { dedupe: `connector_attention:${connectionId}:${new Date().toISOString().slice(0, 10)}` }).catch(() => undefined);
      }
    });
  }
}

export function providerLabel(provider: string, connectorType?: string | null): string {
  const t = (connectorType ?? "").toLowerCase();
  if (t.includes("instagram")) return "Instagram";
  if (t.includes("facebook") || t.includes("page")) return "Facebook";
  if (t.includes("drive")) return "Google Drive";
  if (provider === "meta") return "Meta";
  if (provider === "google") return "Google";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function unseal(row: Record<string, any>): OAuthTokens {
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
