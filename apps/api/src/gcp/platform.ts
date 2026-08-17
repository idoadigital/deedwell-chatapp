import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

/**
 * Client for the external Deedwell grant platform (GCP Cloud Run + Cloud SQL).
 *
 * The platform is the workflow/business engine for grant work: research and
 * verification, application workspaces, funder requirements, the Evidence
 * Library, strategy, drafting/revisions, budget, deterministic compliance, and
 * DOCX/PDF deliverables. This client only *reaches* that engine — no grant
 * logic is duplicated here (backend rule of the integration spec).
 *
 * Enabled by GCP_GRANTS_API_URL; unset means honestly off (createGcpGrantPlatform
 * returns null and every caller falls back to existing local behaviour).
 * Auth: Cloud Run IAM ID tokens — from a service-account key file when
 * GOOGLE_APPLICATION_CREDENTIALS is set (production outside GCP), else the
 * metadata server when running on GCP, else the gcloud CLI in development.
 * The token, like every backend id, never reaches the browser.
 */

export interface GcpTurnIntent {
  capability: string;
  label: string;
  backend: string;
  task_type: string | null;
  routing_method: string;
  confidence?: number;
  rationale?: string;
}

export interface GcpTurnResult {
  conversation_id: string;
  message: string;
  intent: GcpTurnIntent;
  outcome: string;
  /** The platform returns started-task ids as strings; older/test doubles may use objects. */
  tasks: Array<string | { task_id: string; task_type: string; status: string }>;
  application_id: string | null;
  data: Record<string, unknown> | null;
  latency_ms: number;
  error: { code: string; message: string } | null;
}

export interface GcpIds { organizationId: string; userId: string }

export interface GcpGrantPlatform {
  readonly name: string;
  provision(input: { externalOrgRef: string; organizationName: string; userEmail: string; userDisplayName?: string | null }): Promise<GcpIds>;
  createConversation(ids: GcpIds, applicationId?: string | null): Promise<string>;
  turn(conversationId: string, ids: GcpIds, message: string): Promise<GcpTurnResult>;
  activity(conversationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  conversationState(conversationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  applicationOverview(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  requirements(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  informationRequests(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  answerInformationRequest(applicationId: string, requestId: string, ids: GcpIds, answerText: string): Promise<Record<string, unknown>>;
  strategy(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  sections(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  budget(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  compliance(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  deliverables(applicationId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  documents(ids: GcpIds): Promise<Record<string, unknown>>;
  evidence(ids: GcpIds, opts?: { documentId?: string; limit?: number }): Promise<Record<string, unknown>>;
  uploadDocument(ids: GcpIds, filename: string, mime: string, bytes: Buffer): Promise<Record<string, unknown>>;
  getDocument(documentId: string, ids: GcpIds): Promise<Record<string, unknown>>;
  downloadDeliverable(deliverableId: string, ids: GcpIds): Promise<{ bytes: Buffer; contentType: string; filename: string | null }>;
}

// ---------------------------------------------------------------------------
// ID tokens: metadata server on GCP, gcloud CLI in development. Cached and
// refreshed well before expiry (Cloud Run tokens live ~1h).
// ---------------------------------------------------------------------------
const TOKEN_REFRESH_MS = 20 * 60 * 1000;

class IdTokenSource {
  private token = "";
  private fetchedAt = 0;
  constructor(private readonly audience: string) {}

  async get(): Promise<string> {
    if (this.token && Date.now() - this.fetchedAt < TOKEN_REFRESH_MS) return this.token;
    this.token = await this.mint();
    this.fetchedAt = Date.now();
    return this.token;
  }

  /** The upstream rejected the token (it can be near end-of-life when minted). */
  invalidate(): void {
    this.token = "";
    this.fetchedAt = 0;
  }

  private async mint(): Promise<string> {
    // Service-account key file (production host outside GCP): self-sign a JWT
    // and exchange it for an ID token scoped to this audience. Same flow the
    // Google auth libraries use — done with node:crypto to avoid a dependency.
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (keyPath) return await this.mintFromKeyFile(keyPath);
    try {
      const res = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(this.audience)}`,
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
      );
      if (res.ok) return (await res.text()).trim();
    } catch {
      // Not on GCP — fall through to the CLI (development).
    }
    return await new Promise<string>((resolve, reject) => {
      execFile("gcloud", ["auth", "print-identity-token"], { timeout: 15_000 }, (err, stdout) => {
        if (err) reject(new Error(`No GCP identity available (metadata server unreachable, gcloud failed: ${err.message.slice(0, 120)})`));
        else resolve(stdout.trim());
      });
    });
  }

  private async mintFromKeyFile(keyPath: string): Promise<string> {
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as {
      client_email?: string; private_key?: string; private_key_id?: string; token_uri?: string;
    };
    if (!key.client_email || !key.private_key) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not a service-account key (missing client_email/private_key)");
    }
    const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // kid lets Google pick the right public key when the account has several
    // registered (e.g. an uploaded key alongside a Google-generated one).
    const unsigned = `${enc({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${enc({
      iss: key.client_email,
      sub: key.client_email,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
      target_audience: this.audience,
    })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string };
    if (!res.ok || !json.id_token) {
      throw new Error(`ID-token exchange failed (${res.status}): ${json.error_description ?? "no id_token in response"}`);
    }
    return json.id_token;
  }
}

// ---------------------------------------------------------------------------
export class HttpGcpGrantPlatform implements GcpGrantPlatform {
  readonly name = "gcp";
  private readonly tokens: IdTokenSource;

  constructor(private readonly baseUrl: string) {
    this.tokens = new IdTokenSource(baseUrl);
  }

  private async call<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts?: { raw?: boolean; timeoutMs?: number },
    retried = false
  ): Promise<T> {
    const token = await this.tokens.get();
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
    });
    console.log(JSON.stringify({
      at: "gcp_platform", method, path: path.split("?")[0], status: res.status, ms: Date.now() - started,
    }));
    // A cached identity token can be rejected before our refresh window ends
    // (it may already be near end-of-life when minted) — remint once.
    if (res.status === 401 && !retried) {
      this.tokens.invalidate();
      return await this.call(method, path, body, opts, true);
    }
    if (opts?.raw) return res as unknown as T;
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Grant platform returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = (json.error as { message?: string } | undefined)?.message ?? text.slice(0, 200);
      throw new Error(`Grant platform ${method} ${path.split("?")[0]} failed (${res.status}): ${err}`);
    }
    return json as T;
  }

  private q(ids: GcpIds, extra: Record<string, string | number | undefined> = {}): string {
    const p = new URLSearchParams({ organization_id: ids.organizationId, user_id: ids.userId });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
    return p.toString();
  }

  async provision(input: { externalOrgRef: string; organizationName: string; userEmail: string; userDisplayName?: string | null }): Promise<GcpIds> {
    const out = await this.call<{ organization_id: string; user_id: string }>("POST", "/v1/provision", {
      external_org_ref: input.externalOrgRef,
      organization_name: input.organizationName,
      user_email: input.userEmail,
      user_display_name: input.userDisplayName ?? undefined,
    });
    return { organizationId: out.organization_id, userId: out.user_id };
  }

  async createConversation(ids: GcpIds, applicationId?: string | null): Promise<string> {
    const out = await this.call<{ conversation_id: string }>("POST", "/v1/conversations", {
      organization_id: ids.organizationId, user_id: ids.userId,
      ...(applicationId ? { application_id: applicationId } : {}),
    });
    return out.conversation_id;
  }

  async turn(conversationId: string, ids: GcpIds, message: string): Promise<GcpTurnResult> {
    return await this.call<GcpTurnResult>("POST", `/v1/conversations/${conversationId}/turn`, {
      organization_id: ids.organizationId, user_id: ids.userId, message,
    }, { timeoutMs: 90_000 });
  }

  async activity(conversationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/conversations/${conversationId}/activity?${this.q(ids)}`);
  }
  async conversationState(conversationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/conversations/${conversationId}/state?${this.q(ids)}`);
  }
  async applicationOverview(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}?${this.q(ids)}`);
  }
  async requirements(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/requirements?${this.q(ids)}`);
  }
  async informationRequests(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/information-requests?${this.q(ids)}`);
  }
  async answerInformationRequest(applicationId: string, requestId: string, ids: GcpIds, answerText: string) {
    return await this.call("POST", `/v1/applications/${applicationId}/information-requests/${requestId}/answer`, {
      organization_id: ids.organizationId, user_id: ids.userId,
      answer_text: answerText, accept_as_text: true,
    });
  }
  async strategy(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/strategy?${this.q(ids)}`);
  }
  async sections(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/sections?${this.q(ids)}`);
  }
  async budget(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/budget?${this.q(ids)}`);
  }
  async compliance(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/compliance?${this.q(ids)}`);
  }
  async deliverables(applicationId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/applications/${applicationId}/deliverables?${this.q(ids)}`);
  }
  async documents(ids: GcpIds) {
    return await this.call("GET", `/v1/documents?${this.q(ids)}`);
  }
  async evidence(ids: GcpIds, opts?: { documentId?: string; limit?: number }) {
    return await this.call("GET", `/v1/evidence?${this.q(ids, { document_id: opts?.documentId, limit: opts?.limit ?? 200 })}`);
  }

  async uploadDocument(ids: GcpIds, filename: string, mime: string, bytes: Buffer): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const res = await fetch(
        `${this.baseUrl}/v1/documents?${this.q(ids, { filename })}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": mime || "application/octet-stream" },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(120_000),
        }
      );
      if (res.status === 401 && attempt === 0) { this.tokens.invalidate(); continue; }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json.error as { message?: string } | undefined)?.message ?? `status ${res.status}`;
        throw new Error(`Grant platform upload failed: ${err}`);
      }
      return json;
    }
  }

  async getDocument(documentId: string, ids: GcpIds) {
    return await this.call("GET", `/v1/documents/${documentId}?${this.q(ids)}`);
  }

  async downloadDeliverable(deliverableId: string, ids: GcpIds) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const res = await fetch(
        `${this.baseUrl}/v1/deliverables/${deliverableId}/download?${this.q(ids)}`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) }
      );
      if (res.status === 401 && attempt === 0) { this.tokens.invalidate(); continue; }
      if (!res.ok) throw new Error(`Deliverable download failed (${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const cd = res.headers.get("content-disposition") ?? "";
      const filename = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? null;
      return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream", filename };
    }
  }
}

/** Off unless GCP_GRANTS_API_URL is set — no mock pretending to be a platform. */
export function createGcpGrantPlatform(): GcpGrantPlatform | null {
  const url = process.env.GCP_GRANTS_API_URL;
  if (!url) return null;
  return new HttpGcpGrantPlatform(url.replace(/\/$/, ""));
}
