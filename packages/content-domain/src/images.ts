/**
 * OpenAI image generation, behind a seam so the rest of the domain never
 * imports a vendor SDK (ADR-0003, same rule the ModelProvider follows).
 *
 * Model: gpt-image-2 — OpenAI's current image model, overridable via
 * CONTENT_IMAGE_MODEL for when it is superseded. The Images API returns
 * base64 in data[].b64_json; there is no URL to fetch afterwards, so the
 * bytes go straight to our own storage.
 */
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
export function createImageGenerator(
  opts: { apiKey?: string | null; kind?: string } = {}
): ImageGenerator {
  const kind = opts.kind ?? process.env.MODEL_PROVIDER ?? "mock";
  if (kind === "mock") return new MockImageGenerator();
  return new OpenAiImageGenerator({ apiKey: opts.apiKey ?? undefined });
}
