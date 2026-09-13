/**
 * The connection state machine:
 *
 *   not_connected → oauth_connected (adwords scope granted on the Google
 *   connector) → account_selected (the customer chose one of the accounts
 *   their Google user can see) → manager_link_pending (Deedwell's manager
 *   account invited it) → connected (link accepted, or no manager configured
 *   and the customer's own token is usable) → authorization_expired /
 *   error / disconnected.
 *
 * "connected" is only reported once a real read against the account has
 * succeeded with the credential that will be used from then on.
 */
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { GoogleAdsApiError, normalizeCustomerId, type CustomerInfo } from "@deedwell/google-ads-domain";
import { uuidv7 } from "@deedwell/database";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { ADWORDS_SCOPE, GoogleAdsAccessError, accessFor, customerClient, loadSettingsOrThrow, managerClient } from "./access.js";
import { readGoogleAdsSettings } from "./settings.js";
import { accountView, emitOrgEvent, loadAccount, logActivity, setAccountStatus, type AccountRow } from "./store.js";

export interface AccountCandidate {
  customerId: string;
  customerIdFormatted: string;
  name: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isManager: boolean;
  isTestAccount: boolean;
  alreadyLinked: boolean;
}

const MAX_CANDIDATES = 25;

/** The Google Ads accounts the connected Google user can see directly. */
export async function discoverAccounts(deps: Deps, client: PoolClient, tenantId: string, actorUserId: string | null): Promise<AccountCandidate[]> {
  const settings = await loadSettingsOrThrow(deps);
  const own = await customerClient(deps, client, tenantId, { actorUserId, settings });
  const ids = (await own.listAccessibleCustomers()).slice(0, MAX_CANDIDATES);
  const { rows: linked } = await client.query(`SELECT customer_id FROM google_ads_accounts WHERE status <> 'disconnected'`);
  const linkedIds = new Set(linked.map((r) => r.customer_id));
  const out: AccountCandidate[] = [];
  for (const id of ids) {
    let info: CustomerInfo | null = null;
    try {
      const scoped = await customerClient(deps, client, tenantId, { actorUserId, settings, loginCustomerId: id });
      info = await scoped.describeCustomer(id);
    } catch (err) {
      if (!(err instanceof GoogleAdsApiError)) throw err;
      // An account the user can list but not read (cancelled, or a
      // developer-token access level that does not cover it) still shows,
      // so the picker is honest about what Google returned.
    }
    out.push({
      customerId: id, customerIdFormatted: formatId(id), name: info?.descriptiveName ?? null,
      currencyCode: info?.currencyCode ?? null, timeZone: info?.timeZone ?? null,
      isManager: info?.manager ?? false, isTestAccount: info?.testAccount ?? false, alreadyLinked: linkedIds.has(id),
    });
  }
  return out;
}

const formatId = (id: string) => (id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

/** The customer chose an account. Verified against Google, never trusted
 *  from the request alone. */
export async function selectAccount(
  deps: Deps, client: PoolClient, tenantId: string, actorUserId: string, requestedCustomerId: string,
): Promise<AccountRow> {
  const customerId = normalizeCustomerId(requestedCustomerId);
  const settings = await loadSettingsOrThrow(deps);
  const own = await customerClient(deps, client, tenantId, { actorUserId, settings });
  const accessible = await own.listAccessibleCustomers();
  if (!accessible.includes(customerId)) throw new GoogleAdsAccessError("missing_scopes", "That Google Ads account is not accessible from the connected Google account.");
  const scoped = await customerClient(deps, client, tenantId, { actorUserId, settings, loginCustomerId: customerId });
  const info = await scoped.describeCustomer(customerId);
  if (info?.manager) throw new GoogleAdsAccessError("missing_scopes", "Choose the advertising account itself, not a manager account.");

  const { rows: elsewhere } = await client.query(
    `SELECT tenant_id FROM google_ads_accounts WHERE customer_id = $1 AND status <> 'disconnected' AND tenant_id <> $2`, [customerId, tenantId]);
  // RLS hides other tenants' rows, so this can only find our own; the unique
  // index is the real guard and surfaces as a 23505 below.
  void elsewhere;

  const previous = await loadAccount(client, tenantId);
  if (previous && previous.customer_id !== customerId) {
    await setAccountStatus(client, previous.id, "disconnected", "Replaced by another account", { disconnected_at: new Date() });
    await logActivity(client, { tenantId, accountId: previous.id, customerId: previous.customer_id, actorUserId, action: "account_replaced", previousState: previous.status, newState: "disconnected" });
  }
  const connection = await deps.googleConnections.find(client, tenantId);
  let row: AccountRow;
  if (previous && previous.customer_id === customerId) {
    await client.query(
      `UPDATE google_ads_accounts SET connection_id = $2, descriptive_name = $3, currency_code = $4, time_zone = $5, is_test_account = $6,
              status = 'account_selected', status_detail = NULL, connected_by_user_id = $7 WHERE id = $1`,
      [previous.id, connection?.id ?? null, info?.descriptiveName ?? null, info?.currencyCode ?? null, info?.timeZone ?? null, info?.testAccount ?? false, actorUserId]);
    row = (await loadAccount(client, tenantId))!;
  } else {
    const id = uuidv7();
    try {
      await client.query(
        `INSERT INTO google_ads_accounts (id, tenant_id, connection_id, customer_id, descriptive_name, currency_code, time_zone, is_test_account,
                                          status, connected_by_user_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'account_selected',$9,'{}')`,
        [id, tenantId, connection?.id ?? null, customerId, info?.descriptiveName ?? null, info?.currencyCode ?? null, info?.timeZone ?? null, info?.testAccount ?? false, actorUserId]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new GoogleAdsAccessError("missing_scopes", "That Google Ads account is already connected to another Deedwell organization.");
      throw err;
    }
    row = (await loadAccount(client, tenantId))!;
  }
  await logActivity(client, { tenantId, accountId: row.id, customerId, actorUserId, action: "account_selected", previousState: previous?.status ?? "oauth_connected", newState: "account_selected", summary: info?.descriptiveName ?? customerId });
  return ensureManagerLink(deps, client, row, actorUserId);
}

/** Establish (or re-check) the manager link and prove the account is
 *  readable with the credential that will be used from now on. */
export async function ensureManagerLink(deps: Deps, client: PoolClient, account: AccountRow, actorUserId: string | null): Promise<AccountRow> {
  const tenantId: string = account.tenant_id;
  const customerId = normalizeCustomerId(account.customer_id);
  const settings = await readGoogleAdsSettings(deps.appPool);
  const before = account.status;
  const finish = async (status: string, detail: string | null, link: string, extra: Record<string, unknown> = {}) => {
    await setAccountStatus(client, account.id, status, detail, { manager_link_status: link, manager_customer_id: settings.managerCustomerId, ...extra });
    if (status !== before) {
      await logActivity(client, { tenantId, accountId: account.id, customerId, actorUserId, actorKind: actorUserId ? "user" : "system", action: status === "connected" ? "connected" : "link_status", previousState: before, newState: status, summary: detail });
    }
    if (status === "connected" && before !== "connected") {
      emitOrgEvent(deps, tenantId, "google_ads:connected", { accountId: account.id });
      await emailOrgAdmins(client, tenantId, "google_ads_connected", { orgName: await orgNameOf(client, tenantId), accountName: account.descriptive_name ?? formatId(customerId), customerId: formatId(customerId) }, { dedupe: `google_ads_connected:${account.id}` }).catch(() => 0);
    }
    return (await loadAccount(client, tenantId))!;
  };

  const manager = settings.managerCustomerId ? await managerClient(deps, settings).catch(() => null) : null;
  if (!settings.managerCustomerId || !settings.managerRefreshToken) {
    // No manager account configured: the customer's own authorization is
    // the credential. Prove it works before calling this connected.
    try {
      const own = await customerClient(deps, client, tenantId, { actorUserId, settings, loginCustomerId: customerId });
      await own.describeCustomer(customerId);
      return finish("connected", "Managed with the organization's own Google authorization.", "none", { connected_at: account.connected_at ?? new Date() });
    } catch (err) {
      return finish(stateForError(err), messageFor(err), "none");
    }
  }

  // 1. From the customer's side: is our manager already linked?
  try {
    const own = await customerClient(deps, client, tenantId, { actorUserId, settings, loginCustomerId: customerId });
    const links = await own.managerLinks(customerId);
    const ours = links.find((l) => l.managerCustomerId === settings.managerCustomerId);
    if (ours?.status === "ACTIVE") {
      const via = await accessFor(deps, client, { ...account, manager_link_status: "active", manager_customer_id: settings.managerCustomerId }, actorUserId);
      await via.client.describeCustomer(customerId);
      return finish("connected", null, "active", { manager_link_resource: ours.resourceName, connected_at: account.connected_at ?? new Date() });
    }
    if (ours?.status === "PENDING") {
      await own.acceptManagerLink(customerId, ours.resourceName);
      await logActivity(client, { tenantId, accountId: account.id, customerId, actorUserId, actorKind: actorUserId ? "user" : "system", action: "manager_link_accepted", entityType: "customer_manager_link", entityId: ours.resourceName });
      return finish("connected", null, "active", { manager_link_resource: ours.resourceName, connected_at: account.connected_at ?? new Date() });
    }
    // 2. Not linked yet: invite from the manager, then accept as the customer.
    if (!manager) return finish("manager_link_pending", "Deedwell's manager account is not available right now; the link will be retried.", "pending");
    const existing = (await manager.clientLinks(settings.managerCustomerId, customerId)).find((l) => l.status === "PENDING" || l.status === "ACTIVE");
    if (!existing) {
      const resource = await manager.inviteClient(settings.managerCustomerId, customerId);
      await logActivity(client, { tenantId, accountId: account.id, customerId, actorUserId, actorKind: "system", action: "manager_link_invited", entityType: "customer_client_link", entityId: resource });
    }
    const after = (await own.managerLinks(customerId)).find((l) => l.managerCustomerId === settings.managerCustomerId);
    if (after?.status === "PENDING") {
      await own.acceptManagerLink(customerId, after.resourceName);
      await logActivity(client, { tenantId, accountId: account.id, customerId, actorUserId, actorKind: actorUserId ? "user" : "system", action: "manager_link_accepted", entityType: "customer_manager_link", entityId: after.resourceName });
      return finish("connected", null, "active", { manager_link_resource: after.resourceName, connected_at: account.connected_at ?? new Date() });
    }
    if (after?.status === "ACTIVE") return finish("connected", null, "active", { manager_link_resource: after.resourceName, connected_at: account.connected_at ?? new Date() });
    return finish("manager_link_pending", "Waiting for Google to register the manager link.", "pending");
  } catch (err) {
    return finish(stateForError(err), messageFor(err), account.manager_link_status ?? "unknown");
  }
}

function stateForError(err: unknown): string {
  if (err instanceof GoogleAdsAccessError) return err.code === "expired" || err.code === "missing_scopes" || err.code === "not_connected" ? "authorization_expired" : "error";
  if (err instanceof GoogleAdsApiError) {
    if (err.code === "unauthenticated") return "authorization_expired";
    if (err.code === "permission_denied" || err.code === "developer_token") return "error";
    return "manager_link_pending";
  }
  return "error";
}

function messageFor(err: unknown): string {
  if (err instanceof GoogleAdsApiError) {
    if (err.code === "developer_token") return "Deedwell's Google Ads developer token was rejected — a platform administrator needs to check it.";
    if (err.code === "permission_denied") return "Google refused access to this account. Check that the connected Google user can administer it.";
    if (err.code === "unauthenticated") return "The Google authorization expired — reconnect Google to continue.";
    if (err.code === "rate_limited") return "Google Ads is rate-limiting requests; the connection will be retried.";
    if (err.code === "unavailable") return "Google Ads is temporarily unavailable; the connection will be retried.";
    return err.message;
  }
  return (err as Error).message;
}

export async function disconnectAccount(deps: Deps, client: PoolClient, tenantId: string, actorUserId: string, reason = "Disconnected by the organization"): Promise<void> {
  const account = await loadAccount(client, tenantId);
  if (!account) return;
  await setAccountStatus(client, account.id, "disconnected", reason, { disconnected_at: new Date() });
  await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId, action: "disconnected", previousState: account.status, newState: "disconnected", summary: reason });
  emitOrgEvent(deps, tenantId, "google_ads:disconnected", { accountId: account.id });
}

/** Everything the Connectors card and the Google Ads page need to render. */
export async function connectionStatus(deps: Deps, client: PoolClient, tenantId: string) {
  const account = await loadAccount(client, tenantId);
  const google = await deps.googleConnections.missingFor(client, tenantId, [ADWORDS_SCOPE]);
  const googleConnected = Boolean(google.connection) && google.connection?.status === "connected";
  const scopeGranted = googleConnected && google.missing.length === 0;
  let state: string;
  if (account) state = account.status === "connected" && (!googleConnected && account.manager_link_status !== "active") ? "authorization_expired" : account.status;
  else if (scopeGranted) state = "oauth_connected";
  else state = "not_connected";
  const settings = await readGoogleAdsSettings(deps.appPool);
  return {
    state,
    account: accountView(account),
    google: { connected: googleConnected, scopeGranted, status: google.connection?.status ?? null },
    platformReady: Boolean(settings.developerToken),
    managerConfigured: Boolean(settings.managerCustomerId && settings.managerRefreshToken),
  };
}
