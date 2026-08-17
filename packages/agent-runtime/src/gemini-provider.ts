import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type { ModelProvider, ModelRequest, ModelResponse } from "./index.js";
import { SCHEMA_HINTS } from "./openai-provider.js";

/**
 * Gemini on Vertex AI behind the ModelProvider seam (ADR-0003) — the whole
 * product runs on one cloud: the grant platform already uses Gemini, and this
 * adapter moves the local engine (intent routing, website team, drafting)
 * onto the same GCP project and billing.
 *
 * Auth mirrors the platform client: a service-account key when
 * GOOGLE_APPLICATION_CREDENTIALS is set (production outside GCP), else the
 * metadata server on GCP, else the gcloud CLI in development. Vertex needs an
 * OAuth ACCESS token (cloud-platform scope), not an ID token.
 *
 * Config: GCP_PROJECT (or the key file's project_id), VERTEX_REGION
 * (default us-central1), GEMINI_MODEL (default gemini-2.5-flash).
 */

const TOKEN_REFRESH_MS = 20 * 60 * 1000;

class AccessTokenSource {
  private token = "";
  private fetchedAt = 0;

  async get(): Promise<string> {
    if (this.token && Date.now() - this.fetchedAt < TOKEN_REFRESH_MS) return this.token;
    this.token = await this.mint();
    this.fetchedAt = Date.now();
    return this.token;
  }

  invalidate(): void {
    this.token = "";
    this.fetchedAt = 0;
  }

  private async mint(): Promise<string> {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (keyPath) return await this.mintFromKeyFile(keyPath);
    try {
      const res = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
      );
      if (res.ok) {
        const json = (await res.json()) as { access_token?: string };
        if (json.access_token) return json.access_token;
      }
    } catch {
      // Not on GCP — fall through to the CLI (development).
    }
    return await new Promise<string>((resolve, reject) => {
      execFile("gcloud", ["auth", "print-access-token"], { timeout: 15_000 }, (err, stdout) => {
        if (err) reject(new Error(`No GCP credentials for Vertex (metadata unreachable, gcloud failed: ${err.message.slice(0, 120)})`));
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
    const unsigned = `${enc({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${enc({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
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
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Vertex access-token exchange failed (${res.status}): ${json.error_description ?? "no access_token"}`);
    }
    return json.access_token;
  }
}

function projectFromKeyFile(): string | null {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) return null;
  try {
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as { project_id?: string };
    return key.project_id ?? null;
  } catch {
    return null;
  }
}

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  private readonly tokens = new AccessTokenSource();
  private readonly project: string;
  private readonly region: string;
  private readonly model: string;

  constructor(opts: { project?: string; region?: string; model?: string } = {}) {
    const project = opts.project ?? process.env.GCP_PROJECT ?? projectFromKeyFile();
    if (!project) {
      throw new Error("GeminiProvider requires GCP_PROJECT (or a service-account key with project_id)");
    }
    this.project = project;
    this.region = opts.region ?? process.env.VERTEX_REGION ?? "us-central1";
    this.model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  }

  async complete(request: ModelRequest, retried = false, rateLimitAttempt = 0): Promise<ModelResponse> {
    const requestId = Math.random().toString(36).slice(2, 10);
    const started = Date.now();
    const user = [
      `TASK: ${request.task}`,
      ``,
      `Respond with ONLY a single JSON object conforming to the "${request.outputSchemaRef}" output contract described in your instructions. No prose, no markdown fences.`,
      ``,
      ...request.dataBlocks.map(
        (b) => `<<<DOCUMENT label="${b.label}">>>\n${b.content}\n<<<END DOCUMENT>>>`
      ),
    ].join("\n");

    const token = await this.tokens.get();
    const res = await fetch(
      `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.region}/publishers/google/models/${this.model}:generateContent`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system + "\n\n" + SCHEMA_HINTS[request.outputSchemaRef] }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
          },
        }),
        signal: AbortSignal.timeout(90_000),
      }
    );
    if (res.status === 401 && !retried) {
      this.tokens.invalidate();
      return await this.complete(request, true, rateLimitAttempt);
    }
    // Vertex's per-minute quota is easy to hit under normal concurrent load
    // (research worker + local chat engine sharing the same project/model) —
    // this is expected, transient pressure, not a real failure. Back off and
    // retry rather than surfacing it as a hard error on the first burst.
    const RATE_LIMIT_MAX_RETRIES = 4;
    if ((res.status === 429 || res.status === 503) && rateLimitAttempt < RATE_LIMIT_MAX_RETRIES) {
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(1000 * 2 ** rateLimitAttempt, 20_000) + Math.floor(Math.random() * 500);
      console.log(JSON.stringify({
        at: "model_request_backoff", requestId, provider: "gemini", model: this.model,
        status: res.status, attempt: rateLimitAttempt + 1, backoffMs,
      }));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return await this.complete(request, retried, rateLimitAttempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Vertex Gemini request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    const text = (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const tokens = payload.usageMetadata?.totalTokenCount ?? Math.ceil(text.length / 4);
    console.log(JSON.stringify({
      at: "model_request", requestId, provider: "gemini", model: this.model,
      schema: request.outputSchemaRef, ms: Date.now() - started, tokens, ok: true,
    }));
    return { text, tokensEstimated: tokens };
  }
}

