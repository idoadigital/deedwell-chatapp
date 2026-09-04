import { describe, expect, it } from "vitest";
import { FallbackImageGenerator, type ImageGenerator } from "./images.js";

const gen = (model: string, fn: () => Promise<Buffer>): ImageGenerator => ({ model, async generate() { return { bytes: await fn(), mime: "image/png" }; } });

describe("FallbackImageGenerator", () => {
  it("uses the secondary when the primary has no credit, then sticks with it", async () => {
    let calls = 0;
    const g = new FallbackImageGenerator(
      gen("openai", async () => { calls += 1; throw new Error("Image generation failed (429): You have no credits remaining."); }),
      gen("vertex", async () => Buffer.from("v"))
    );
    expect((await g.generate("p", "1024x1024")).bytes.toString()).toBe("v");
    expect((await g.generate("p", "1024x1024")).bytes.toString()).toBe("v");
    expect(calls).toBe(1);
  });
  it("does not hide other failures", async () => {
    const g = new FallbackImageGenerator(gen("openai", async () => { throw new Error("content policy violation"); }), gen("vertex", async () => Buffer.from("v")));
    await expect(g.generate("p", "1024x1024")).rejects.toThrow("policy");
  });
});
