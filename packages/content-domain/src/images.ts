/**
 * OpenAI image generation, behind a seam so the rest of the domain never
 * imports a vendor SDK (ADR-0003, same rule the ModelProvider follows).
 *
 * Model: gpt-image-2 — OpenAI's current image model, overridable via
 * CONTENT_IMAGE_MODEL for when it is superseded. The Images API returns
 * base64 in data[].b64_json; there is no URL to fetch afterwards, so the
 * bytes go straight to our own storage.
 */
import { AccessTokenSource } from "@deedwell/agent-runtime";

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
}

export interface ImageGenerator {
  readonly model: string;
  generate(prompt: string, size: string): Promise<GeneratedImage>;
}

const OUTPUT_FORMAT = "png";

export class OpenAiImageGenerator implements ImageGenerator {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly quality: string;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string; quality?: string } = {}) {
    // The key is passed in, not read from the environment: it is managed from
    // Platform Admin and can be rotated without a redeploy.
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("No OpenAI API key configured — add one in Platform Admin → Developer.");
    }
    this.apiKey = key;
    this.model = opts.model ?? process.env.CONTENT_IMAGE_MODEL ?? "gpt-image-2";
    this.baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.quality = opts.quality ?? process.env.CONTENT_IMAGE_QUALITY ?? "high";
  }

  async generate(prompt: string, size: string): Promise<GeneratedImage> {
    const res = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        prompt,
        n: 1,
        size,
        quality: this.quality,
        output_format: OUTPUT_FORMAT,
      }),
      // A single high-quality generation is slow; this is generous on purpose.
      signal: AbortSignal.timeout(Number(process.env.CONTENT_IMAGE_TIMEOUT_MS ?? 180_000)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Image generation failed (${res.status}): ${detail.slice(0, 400)}`);
    }
    const payload = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image generation returned no image data");
    return { bytes: Buffer.from(b64, "base64"), mime: `image/${OUTPUT_FORMAT}` };
  }
}

/** Deterministic 1x1 PNG, for tests and for MODEL_PROVIDER=mock runs so the
 *  whole pipeline stays exercisable without spending money. */
export class MockImageGenerator implements ImageGenerator {
  readonly model = "mock";
  async generate(): Promise<GeneratedImage> {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return { bytes: Buffer.from(png, "base64"), mime: "image/png" };
  }
}

/** `apiKey` comes from the admin key store. Without one, and outside mock
 *  mode, this throws rather than silently producing nothing. */
/**
 * Google Imagen on Vertex AI, the same project and credentials the Gemini
 * text provider uses. The fallback when the OpenAI image account cannot
 * serve, and a full generator in its own right.
 */
export class VertexImageGenerator implements ImageGenerator {
  readonly model: string;
  private readonly tokens = new AccessTokenSource();
  private readonly project: string;
  private readonly region: string;

  constructor(opts: { project?: string; region?: string; model?: string } = {}) {
    const project = opts.project ?? process.env.GCP_PROJECT;
    if (!project) throw new Error("VertexImageGenerator requires GCP_PROJECT");
    this.project = project;
    this.region = opts.region ?? process.env.VERTEX_REGION ?? "us-central1";
    this.model = opts.model ?? process.env.VERTEX_IMAGE_MODEL ?? "imagen-3.0-generate-002";
  }

  async generate(prompt: string, size: string): Promise<GeneratedImage> {
    // Imagen takes an aspect ratio, not pixels; landscape → 4:3, portrait → 3:4.
    const [w, h] = size.split("x").map(Number);
    const aspectRatio = !w || !h || w === h ? "1:1" : w > h ? (w / h > 1.6 ? "16:9" : "4:3") : (h / w > 1.6 ? "9:16" : "3:4");
    const token = await this.tokens.get();
    const res = await fetch(
      `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.region}/publishers/google/models/${this.model}:predict`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio, personGeneration: "allow_adult", safetySetting: "block_medium_and_above", addWatermark: false, outputOptions: { mimeType: "image/png" } },
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Vertex Imagen request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
    const p = json.predictions?.[0];
    if (!p?.bytesBase64Encoded) throw new Error("Vertex Imagen returned no image (possibly filtered)");
    return { bytes: Buffer.from(p.bytesBase64Encoded, "base64"), mime: p.mimeType ?? "image/png" };
  }
}

const UNSERVICEABLE = /insufficient_quota|no credits|credit balance|invalid_api_key|incorrect api key|No OpenAI API key|\(401\)|\(402\)|\(403\)|\(429\)/i;

/** Try the primary; when it cannot serve at all, use the secondary and
 *  keep using it for ten minutes rather than failing every image. */
export class FallbackImageGenerator implements ImageGenerator {
  readonly model: string;
  private unserviceableUntil = 0;
  constructor(private readonly primary: ImageGenerator, private readonly secondary: ImageGenerator) {
    this.model = `${primary.model}→${secondary.model}`;
  }
  async generate(prompt: string, size: string): Promise<GeneratedImage> {
    if (Date.now() < this.unserviceableUntil) return this.secondary.generate(prompt, size);
    try {
      return await this.primary.generate(prompt, size);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (!UNSERVICEABLE.test(message)) throw err;
      this.unserviceableUntil = Date.now() + 10 * 60_000;
      console.log(JSON.stringify({ at: "image_provider_fallback", from: this.primary.model, to: this.secondary.model, reason: message.slice(0, 160) }));
      return this.secondary.generate(prompt, size);
    }
  }
}

export function createImageGenerator(
  opts: { apiKey?: string | null; kind?: string } = {}
): ImageGenerator {
  const kind = opts.kind ?? process.env.MODEL_PROVIDER ?? "mock";
  if (kind === "mock") return new MockImageGenerator();
  const fallbackKind = process.env.IMAGE_FALLBACK_PROVIDER ?? (process.env.GCP_PROJECT ? "vertex" : "none");
  if (kind === "vertex") return new VertexImageGenerator();
  const openai = new OpenAiImageGenerator({ apiKey: opts.apiKey ?? undefined });
  return fallbackKind === "vertex" ? new FallbackImageGenerator(openai, new VertexImageGenerator()) : openai;
}
