/**
 * Resolves *how* Deedwell talks to one organization's Google Ads account.
 *
 * Two credentials can open a customer account: the manager account (once the
 * customer has accepted the MCC link — stable, and what runs sync and
 * publishing day to day) and the customer's own Google consent token (used
 * to discover their accounts and accept the link, and as the fallback when
 * no manager is configured). The customer id always comes from the
 * organization's own account row, never from a request.
 */
import { GOOGLE_SCOPE, GoogleConnectionError } from "@deedwell/connectors";
import { GoogleAdsClient, normalizeCustomerId } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { managerAccessToken, readGoogleAdsSettings, type GoogleAdsSettings } from "./settings.js";

export const ADWORDS_SCOPE = GOOGLE_SCOPE.adwords;

export type AccessErrorCode = "not_configured" | "not_connected" | "missing_scopes" | "expired" | "manager_unavailable" | "unavailable";

export class GoogleAdsAccessError extends Error {
  constructor(readonly code: AccessErrorCode, message: string) {
    super(message);
    this.name = "GoogleAdsAccessError";
  }
}

export interface AdsAccess {
  client: GoogleAdsClient;
  via: "manager" | "customer";
  customerId: string;
}

import type { GoogleAdsClientOptions, GoogleAdsCredentials } from "@deedwell/google-ads-domain";

type ClientFactory = (creds: GoogleAdsCredentials, opts: GoogleAdsClientOptions) => GoogleAdsClient;
let factory: ClientFactory = (creds, opts) => new GoogleAdsClient(creds, opts);
let logger: GoogleAdsClientOptions["log"] | undefined;

/** Tests swap the factory for a fake; main.ts hands in the app logger. */
export function setGoogleAdsClientFactory(next: ClientFactory | null): void { factory = next ?? ((creds, opts) => new GoogleAdsClient(creds, opts)); }
export function setGoogleAdsLogger(log: GoogleAdsClientOptions["log"] | undefined): void { logger = log; }

const clientOptions = (_deps: Deps): GoogleAdsClientOptions => ({ log: logger });

export async function loadSettingsOrThrow(deps: Deps): Promise<GoogleAdsSettings> {
  const settings = await readGoogleAdsSettings(deps.appPool);
  if (!settings.developerToken) throw new GoogleAdsAccessError("not_configured", "Google Ads is not configured yet — a platform administrator needs to add the developer token.");
  return settings;
}

/** The customer's own consent token (the connector's google_account). */
export async function customerClient(
  deps: Deps, client: PoolClient, tenantId: string,
  opts: { loginCustomerId?: string | null; actorUserId?: string | null; settings?: GoogleAdsSettings } = {},
): Promise<GoogleAdsClient> {
  const settings = opts.settings ?? await loadSettingsOrThrow(deps);
  let accessToken: string;
  try {
    const access = await deps.googleConnections.require(client, tenantId, { scopes: [ADWORDS_SCOPE], actorUserId: opts.actorUserId ?? null, feature: "google_ads" });
    accessToken = access.accessToken;
  } catch (err) {
    if (err instanceof GoogleConnectionError) {
      if (err.code === "not_connected") throw new GoogleAdsAccessError("not_connected", "Connect your Google account first.");
      if (err.code === "missing_scopes") throw new GoogleAdsAccessError("missing_scopes", "Google Ads access has not been granted yet.");
      if (err.code === "expired") throw new GoogleAdsAccessError("expired", "The Google authorization expired — reconnect to continue.");
      throw new GoogleAdsAccessError("unavailable", err.message);
    }
    throw err;
  }
  return factory(
    { accessToken, developerToken: settings.developerToken!, loginCustomerId: opts.loginCustomerId ? normalizeCustomerId(opts.loginCustomerId) : null, apiVersion: settings.apiVersion },
    clientOptions(deps),
  );
}

/** The manager account, or null when it is not configured / unavailable. */
export async function managerClient(deps: Deps, settings?: GoogleAdsSettings): Promise<GoogleAdsClient | null> {
  const s = settings ?? await loadSettingsOrThrow(deps);
  if (!s.managerCustomerId || !s.managerRefreshToken) return null;
  const accessToken = await managerAccessToken(deps.appPool, s);
  if (!accessToken) return null;
  return factory(
    { accessToken, developerToken: s.developerToken!, loginCustomerId: s.managerCustomerId, apiVersion: s.apiVersion },
    clientOptions(deps),
  );
}

/** The right credential for an account row: manager when the link is live,
 *  otherwise the customer's own token. */
export async function accessFor(deps: Deps, client: PoolClient, account: Record<string, any>, actorUserId: string | null = null): Promise<AdsAccess> {
  const settings = await loadSettingsOrThrow(deps);
  const customerId = normalizeCustomerId(account.customer_id);
  if (account.manager_link_status === "active" && settings.managerCustomerId && account.manager_customer_id === settings.managerCustomerId) {
    const manager = await managerClient(deps, settings);
    if (manager) return { client: manager, via: "manager", customerId };
  }
  const own = await customerClient(deps, client, account.tenant_id, { loginCustomerId: customerId, actorUserId, settings });
  return { client: own, via: "customer", customerId };
}
