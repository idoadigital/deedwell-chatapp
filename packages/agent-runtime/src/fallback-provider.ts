import type { ModelProvider, ModelRequest, ModelResponse } from "./index.js";

/**
 * A provider that hands a request to a second provider when the first one
 * cannot serve at all — exhausted credit, a bad key, a model that no longer
 * exists. Genuine model failures (bad output, timeouts under load) are not
 * retried elsewhere: those are the first provider's to fix, and the caller's
 * own retry loop handles them.
 */
const UNSERVICEABLE = /insufficient_quota|no credits|credit balance|invalid_api_key|incorrect api key|No OpenAI API key|model_not_found|does not exist|\(401\)|\(402\)|\(403\)|\(404\)/i;

export class FallbackProvider implements ModelProvider {
  readonly name: string;
  private unserviceableUntil = 0;

  constructor(private readonly primary: ModelProvider, private readonly secondary: ModelProvider) {
    this.name = `${primary.name}→${secondary.name}`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Once the primary has proven unserviceable, skip it for a while rather
    // than paying a failed round-trip on every page of a build.
    if (Date.now() < this.unserviceableUntil) return this.secondary.complete(request);
    try {
      return await this.primary.complete(request);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (!UNSERVICEABLE.test(message)) throw err;
      this.unserviceableUntil = Date.now() + 10 * 60_000;
      console.log(JSON.stringify({
        at: "model_provider_fallback", from: this.primary.name, to: this.secondary.name,
        reason: message.slice(0, 200), schema: request.outputSchemaRef,
      }));
      return this.secondary.complete(request);
    }
  }
}
