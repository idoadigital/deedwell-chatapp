/**
 * A small REST client for the Google Ads API. Deliberately dependency-free
 * (the official client library brings gRPC and a very large proto bundle);
 * every call is one authenticated HTTP request against
 * https://googleads.googleapis.com/<version>/customers/<id>/...
 *
 * What it handles so callers do not have to: the three required headers,
 * searchStream chunk merging, search pagination, retries with backoff for
 * rate limits and transient errors, Google's structured error payloads, and
 * `validateOnly` dry runs for mutations.
 *
 * It never decides *which* customer to act on — the caller resolves that
 * from the organization's own account row.
 */

export interface GoogleAdsCredentials {
  accessToken: string;
  developerToken: string;
  /** The manager (MCC) customer id when acting through a manager link. */
  loginCustomerId?: string | null;
  apiVersion?: string;
}

export interface GoogleAdsClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  /** Backoff for attempt n (0-based). Tests pass () => 0. */
  backoffMs?: (attempt: number) => number;
  log?: { warn(o: unknown, m?: string): void; info?(o: unknown, m?: string): void };
}

export type GoogleAdsErrorCode =
  | "unauthenticated" | "permission_denied" | "rate_limited" | "unavailable"
  | "invalid_argument" | "not_found" | "developer_token" | "unknown";

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GoogleAdsErrorCode,
    readonly details: unknown = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

export const DEFAULT_API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v25";
const BASE_URL = "https://googleads.googleapis.com";

export const normalizeCustomerId = (value: string): string => String(value ?? "").replace(/\D/g, "");
export const formatCustomerId = (value: string): string => {
  const d = normalizeCustomerId(value);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
};

export interface MutateResult { resourceName: string }

export type MutateResource =
  | "campaignBudgets" | "campaigns" | "adGroups" | "adGroupAds" | "adGroupCriteria"
  | "campaignCriteria" | "customerClientLinks" | "customerManagerLinks";

interface RawGoogleError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ errors?: Array<{ errorCode?: Record<string, string>; message?: string; trigger?: unknown; location?: unknown }> }>;
  };
}

export class GoogleAdsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly version: string;

  constructor(private readonly creds: GoogleAdsCredentials, private readonly opts: GoogleAdsClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(1_000 * 2 ** attempt, 20_000) + Math.floor(Math.random() * 250));
    this.version = creds.apiVersion ?? DEFAULT_API_VERSION;
  }

  get apiVersion(): string { return this.version; }

  // ---- reads ---------------------------------------------------------------

  /** `customers:listAccessibleCustomers` — the accounts the token's Google
   *  user can see directly (not through a manager). Returns bare ids. */
  async listAccessibleCustomers(): Promise<string[]> {
    const body = await this.request<{ resourceNames?: string[] }>("GET", `customers:listAccessibleCustomers`);
    return (body.resourceNames ?? []).map((r) => normalizeCustomerId(r.replace(/^customers\//, "")));
  }

  /** `googleAds:searchStream` — every row for a GAQL query, chunks merged. */
  async searchStream<T = Record<string, any>>(customerId: string, query: string): Promise<T[]> {
    const cid = normalizeCustomerId(customerId);
    const chunks = await this.request<Array<{ results?: T[] }> | { results?: T[] }>(
      "POST", `customers/${cid}/googleAds:searchStream`, { query },
    );
    const list = Array.isArray(chunks) ? chunks : [chunks];
    return list.flatMap((c) => c.results ?? []);
  }

  /** `googleAds:search` with pagination — for large result sets where the
   *  caller wants a bounded page size. */
  async search<T = Record<string, any>>(customerId: string, query: string, opts: { pageSize?: number; maxRows?: number } = {}): Promise<T[]> {
    const cid = normalizeCustomerId(customerId);
    const out: T[] = [];
    let pageToken: string | undefined;
    const pageSize = opts.pageSize ?? 1_000;
    const maxRows = opts.maxRows ?? 50_000;
    do {
      const body = await this.request<{ results?: T[]; nextPageToken?: string }>(
        "POST", `customers/${cid}/googleAds:search`, { query, pageSize, ...(pageToken ? { pageToken } : {}) },
      );
      out.push(...(body.results ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken && out.length < maxRows);
    return out;
  }

  // ---- writes --------------------------------------------------------------

  /** Per-resource mutate, e.g. `campaigns:mutate`. `validateOnly` asks Google
   *  to check the operations without applying them. */
  async mutate(
    customerId: string,
    resource: MutateResource,
    operations: Array<Record<string, unknown>>,
    opts: { validateOnly?: boolean; partialFailure?: boolean } = {},
  ): Promise<MutateResult[]> {
    if (!operations.length) return [];
    const cid = normalizeCustomerId(customerId);
    const body = await this.request<{ results?: Array<{ resourceName?: string }> }>(
      "POST", `customers/${cid}/${resource}:mutate`,
      { operations, validateOnly: opts.validateOnly ?? false, partialFailure: opts.partialFailure ?? false },
    );
    return (body.results ?? []).map((r) => ({ resourceName: r.resourceName ?? "" }));
  }

  /** `googleAds:mutate` — several resource types in one atomic request, with
   *  temporary ids (`customers/<cid>/campaigns/-1`) resolving across
   *  operations. Used for the publish so a half-created campaign can never
   *  be left behind. */
  async mutateAll(
    customerId: string,
    mutateOperations: Array<Record<string, unknown>>,
    opts: { validateOnly?: boolean } = {},
  ): Promise<Array<Record<string, any>>> {
    if (!mutateOperations.length) return [];
    const cid = normalizeCustomerId(customerId);
    const body = await this.request<{ mutateOperationResponses?: Array<Record<string, any>> }>(
      "POST", `customers/${cid}/googleAds:mutate`,
      { mutateOperations, validateOnly: opts.validateOnly ?? false, partialFailure: false },
    );
    return body.mutateOperationResponses ?? [];
  }

  // ---- account facts -------------------------------------------------------

  async describeCustomer(customerId: string): Promise<CustomerInfo | null> {
    const rows = await this.searchStream<{ customer: Record<string, any> }>(customerId,
      `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone,
              customer.manager, customer.test_account, customer.status
         FROM customer LIMIT 1`);
    const c = rows[0]?.customer;
    if (!c) return null;
    return {
      customerId: normalizeCustomerId(String(c.id ?? customerId)),
      descriptiveName: c.descriptiveName ?? null,
      currencyCode: c.currencyCode ?? null,
      timeZone: c.timeZone ?? null,
      manager: Boolean(c.manager),
      testAccount: Boolean(c.testAccount),
      status: c.status ?? null,
    };
  }

  /** The manager links a customer account has (seen from the customer). */
  async managerLinks(customerId: string): Promise<ManagerLink[]> {
    const rows = await this.searchStream<{ customerManagerLink: Record<string, any> }>(customerId,
      `SELECT customer_manager_link.resource_name, customer_manager_link.manager_customer,
              customer_manager_link.manager_link_id, customer_manager_link.status
         FROM customer_manager_link`);
    return rows.map((r) => ({
      resourceName: r.customerManagerLink.resourceName,
      managerCustomerId: normalizeCustomerId(String(r.customerManagerLink.managerCustomer ?? "").replace(/^customers\//, "")),
      linkId: String(r.customerManagerLink.managerLinkId ?? ""),
      status: String(r.customerManagerLink.status ?? "UNKNOWN"),
    }));
  }

  /** The client links a manager account has (seen from the manager). */
  async clientLinks(managerCustomerId: string, clientCustomerId?: string): Promise<ClientLink[]> {
    const where = clientCustomerId ? ` WHERE customer_client_link.client_customer = 'customers/${normalizeCustomerId(clientCustomerId)}'` : "";
    const rows = await this.searchStream<{ customerClientLink: Record<string, any> }>(managerCustomerId,
      `SELECT customer_client_link.resource_name, customer_client_link.client_customer,
              customer_client_link.manager_link_id, customer_client_link.status
         FROM customer_client_link${where}`);
    return rows.map((r) => ({
      resourceName: r.customerClientLink.resourceName,
      clientCustomerId: normalizeCustomerId(String(r.customerClientLink.clientCustomer ?? "").replace(/^customers\//, "")),
      linkId: String(r.customerClientLink.managerLinkId ?? ""),
      status: String(r.customerClientLink.status ?? "UNKNOWN"),
    }));
  }

  /** From the manager: invite a customer account to be managed. */
  async inviteClient(managerCustomerId: string, clientCustomerId: string): Promise<string> {
    const results = await this.mutate(managerCustomerId, "customerClientLinks", [{
      create: { clientCustomer: `customers/${normalizeCustomerId(clientCustomerId)}`, status: "PENDING" },
    }]);
    return results[0]?.resourceName ?? "";
  }

  /** From the customer: accept the pending manager link. */
  async acceptManagerLink(clientCustomerId: string, linkResourceName: string): Promise<string> {
    const results = await this.mutate(clientCustomerId, "customerManagerLinks", [{
      update: { resourceName: linkResourceName, status: "ACTIVE" }, updateMask: "status",
    }]);
    return results[0]?.resourceName ?? linkResourceName;
  }

  // ---- transport -----------------------------------------------------------

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/${this.version}/${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.creds.accessToken}`,
      "developer-token": this.creds.developerToken,
      accept: "application/json",
    };
    if (this.creds.loginCustomerId) headers["login-customer-id"] = normalizeCustomerId(this.creds.loginCustomerId);
    if (body !== undefined) headers["content-type"] = "application/json";

    let lastError: GoogleAdsApiError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastError = new GoogleAdsApiError(`Google Ads request failed: ${(err as Error).message}`, 0, "unavailable", null, true);
        await this.wait(attempt);
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const error = await toApiError(res);
      lastError = error;
      if (!error.retryable || attempt === this.maxRetries) throw error;
      this.opts.log?.warn({ at: "google_ads.retry", status: error.status, code: error.code, attempt, path }, error.message);
      const retryAfter = Number(res.headers.get("retry-after"));
      await this.wait(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined);
    }
    throw lastError ?? new GoogleAdsApiError("Google Ads request failed", 0, "unknown");
  }

  private async wait(attempt: number, override?: number): Promise<void> {
    const ms = override ?? this.backoffMs(attempt);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }
}

export interface CustomerInfo {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  testAccount: boolean;
  status: string | null;
}

export interface ManagerLink { resourceName: string; managerCustomerId: string; linkId: string; status: string }
export interface ClientLink { resourceName: string; clientCustomerId: string; linkId: string; status: string }

async function toApiError(res: Response): Promise<GoogleAdsApiError> {
  let payload: RawGoogleError | null = null;
  let text = "";
  try { text = await res.text(); payload = JSON.parse(text) as RawGoogleError; } catch { /* not JSON */ }
  const err = payload?.error;
  const inner = err?.details?.flatMap((d) => d.errors ?? []) ?? [];
  const first = inner[0];
  const codeKey = first?.errorCode ? Object.keys(first.errorCode)[0] : undefined;
  const codeValue = codeKey && first?.errorCode ? first.errorCode[codeKey] : undefined;
  const message = first?.message ?? err?.message ?? (text ? text.slice(0, 300) : `HTTP ${res.status}`);

  let code: GoogleAdsErrorCode = "unknown";
  let retryable = false;
  if (res.status === 401 || err?.status === "UNAUTHENTICATED" || codeKey === "authenticationError") code = "unauthenticated";
  else if (res.status === 403 || err?.status === "PERMISSION_DENIED" || codeKey === "authorizationError") {
    code = codeValue && /DEVELOPER_TOKEN/.test(codeValue) ? "developer_token" : "permission_denied";
  } else if (res.status === 429 || err?.status === "RESOURCE_EXHAUSTED" || codeKey === "quotaError") { code = "rate_limited"; retryable = true; }
  else if (res.status >= 500 || err?.status === "UNAVAILABLE" || err?.status === "INTERNAL" || codeKey === "internalError") { code = "unavailable"; retryable = true; }
  else if (res.status === 404 || err?.status === "NOT_FOUND") code = "not_found";
  else if (res.status === 400) code = "invalid_argument";
  return new GoogleAdsApiError(message, res.status, code, { status: err?.status, errors: inner.slice(0, 10) }, retryable);
}
