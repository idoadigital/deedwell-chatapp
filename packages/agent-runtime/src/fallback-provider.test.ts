import { describe, expect, it } from "vitest";
import { FallbackProvider } from "./fallback-provider.js";
import type { ModelProvider, ModelRequest } from "./index.js";

const req: ModelRequest = { system: "", task: "", dataBlocks: [], outputSchemaRef: "site_html", responseFormat: "html" };
const provider = (name: string, fn: () => Promise<string>): ModelProvider => ({
  name, async complete() { return { text: await fn(), tokensEstimated: 1 }; },
});

describe("FallbackProvider", () => {
  it("uses the primary when it works", async () => {
    const p = new FallbackProvider(provider("a", async () => "A"), provider("b", async () => "B"));
    expect((await p.complete(req)).text).toBe("A");
  });
  it("falls back on exhausted credit and then skips the primary for a while", async () => {
    let calls = 0;
    const p = new FallbackProvider(
      provider("a", async () => { calls += 1; throw new Error('OpenAI request failed (429): {"error":{"message":"You have no credits remaining"}}'); }),
      provider("b", async () => "B")
    );
    expect((await p.complete(req)).text).toBe("B");
    expect((await p.complete(req)).text).toBe("B");
    expect(calls).toBe(1);
  });
  it("does not hide ordinary failures", async () => {
    const p = new FallbackProvider(provider("a", async () => { throw new Error("Designed page is not a usable document"); }), provider("b", async () => "B"));
    await expect(p.complete(req)).rejects.toThrow("not a usable document");
  });
});
