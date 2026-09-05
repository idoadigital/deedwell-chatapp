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

/** A brand mark to carry into the picture. Only raster formats the site
 *  sanitizer also accepts, so one file serves designs and the website. */
export interface LogoReference { bytes: Buffer; mime: string }
export interface GenerateOptions { logo?: LogoReference | null }

export interface ImageGenerator {
  readonly model: string;
  generate(prompt: string, size: string, opts?: GenerateOptions): Promise<GeneratedImage>;
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

  async generate(prompt: string, size: string, opts: GenerateOptions = {}): Promise<GeneratedImage> {
    const timeout = AbortSignal.timeout(Number(process.env.CONTENT_IMAGE_TIMEOUT_MS ?? 180_000));
    // With a logo, the edits endpoint takes it as an input image and the
    // prompt places it; without one, plain generation.
    const res = opts.logo
      ? await (async () => {
          const form = new FormData();
          form.append("model", this.model);
          form.append("prompt", `${prompt}\n\n${LOGO_INSTRUCTION}`);
          form.append("n", "1");
          form.append("size", size);
          form.append("quality", this.quality);
          form.append("output_format", OUTPUT_FORMAT);
          form.append("image[]", new Blob([new Uint8Array(opts.logo!.bytes)], { type: opts.logo!.mime }), `logo.${extOf(opts.logo!.mime)}`);
          return fetch(`${this.baseUrl}/images/edits`, {
            method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: timeout,
          });
        })()
      : await fetch(`${this.baseUrl}/images/generations`, {
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
      signal: timeout,
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
 * Gemini's image model on Vertex AI (gemini-2.5-flash-image), the same
 * project and credentials the Gemini text provider uses. The fallback when
 * the OpenAI image account cannot serve, and a full generator in its own
 * right. (Imagen model ids are not enabled for this project; this one is.)
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
    this.model = opts.model ?? process.env.VERTEX_IMAGE_MODEL ?? "gemini-2.5-flash-image";
  }

  async generate(prompt: string, size: string, opts: GenerateOptions = {}, attempt = 0): Promise<GeneratedImage> {
    // The model takes an aspect ratio, not pixels.
    const [w, h] = size.split("x").map(Number);
    const aspectRatio = !w || !h || w === h ? "1:1" : w > h ? (w / h > 1.6 ? "16:9" : "3:2") : (h / w > 1.6 ? "9:16" : "2:3");
    const token = await this.tokens.get();
    const res = await fetch(
      `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.region}/publishers/google/models/${this.model}:generateContent`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: opts.logo
              ? [
                  { inlineData: { mimeType: opts.logo.mime, data: opts.logo.bytes.toString("base64") } },
                  { text: `${prompt}\n\n${LOGO_INSTRUCTION}` },
                ]
              : [{ text: prompt }],
          }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      // Per-minute image quota is small; wait it out rather than fail the image.
      await new Promise((r) => setTimeout(r, Math.min(8_000 * 2 ** attempt, 60_000) + Math.floor(Math.random() * 2000)));
      return this.generate(prompt, size, opts, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Vertex image request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("Vertex image model returned no image (possibly filtered)");
    return { bytes: Buffer.from(part.inlineData.data, "base64"), mime: part.inlineData.mimeType ?? "image/png" };
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
  async generate(prompt: string, size: string, opts: GenerateOptions = {}): Promise<GeneratedImage> {
    if (Date.now() < this.unserviceableUntil) return this.secondary.generate(prompt, size, opts);
    try {
      return await this.primary.generate(prompt, size, opts);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (!UNSERVICEABLE.test(message)) throw err;
      this.unserviceableUntil = Date.now() + 10 * 60_000;
      console.log(JSON.stringify({ at: "image_provider_fallback", from: this.primary.model, to: this.secondary.model, reason: message.slice(0, 160) }));
      return this.secondary.generate(prompt, size, opts);
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

/** What every image model is told when a logo comes along. */
export const LOGO_INSTRUCTION =
  "The attached image is the organization's real logo. Place it in the design exactly as it is — same shapes, colours and proportions, not redrawn, not restyled, not cropped — small and legible in one corner or in a natural brand position, with clear space around it, so the piece reads as this organization's own.";

export function extOf(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}
