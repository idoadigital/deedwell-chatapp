import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { renderSite } from "../../packages/website-domain/src/renderer.js";
import { generateCampaign } from "../../packages/content-domain/src/pipeline.js";
import { MockImageGenerator } from "../../packages/content-domain/src/images.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("Brand Style logo", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "brand@example.org"));
    orgId = await createOrg(env.app, token, "brand-org");
  });
  afterAll(async () => { await env.close(); });

  it("records an uploaded raster as the logo, reads it back, and clears it", async () => {
    const empty = await api(env.app, "GET", `/v1/orgs/${orgId}/brand/logo`, { token });
    expect(empty.body.logo).toBeNull();
    const up = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "logo.png", mime: "image/png", contentBase64: PNG } });
    expect(up.status).toBe(201);
    const fileId = up.body.fileId ?? up.body.id;
    const set = await api(env.app, "PUT", `/v1/orgs/${orgId}/brand/logo`, { token, body: { fileId } });
    expect(set.status).toBe(200);
    expect(set.body.logo).toMatchObject({ fileId, filename: "logo.png", mime: "image/png" });
    const got = await api(env.app, "GET", `/v1/orgs/${orgId}/brand/logo`, { token });
    expect(got.body.logo.fileId).toBe(fileId);
    // It is an ordinary org fact, so every generator's context sees it.
    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    expect(facts.body.facts.some((f: { fact_key?: string; key?: string; value: string }) => (f.fact_key ?? f.key) === "brand_logo_file_id" && f.value === fileId)).toBe(true);
    const cleared = await api(env.app, "DELETE", `/v1/orgs/${orgId}/brand/logo`, { token });
    expect(cleared.status).toBe(200);
    const after = await api(env.app, "GET", `/v1/orgs/${orgId}/brand/logo`, { token });
    expect(after.body.logo).toBeNull();
  });

  it("refuses a non-image as the logo", async () => {
    const up = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "notes.txt", mime: "text/plain", contentBase64: Buffer.from("hi").toString("base64") } });
    const fileId = up.body.fileId ?? up.body.id;
    const set = await api(env.app, "PUT", `/v1/orgs/${orgId}/brand/logo`, { token, body: { fileId } });
    expect(set.status).toBe(400);
  });

  it("puts the logo in the website header and footer when there is one", () => {
    const pages = [{ slug: "index", title: "Home", seoDescription: "x", blocks: [{ type: "hero", heading: "Hello", body: "World" }] }] as never;
    const theme = { palette: "forest", headingFont: "serif" } as never;
    const withLogo = renderSite({ siteName: "River Trust", slug: "river", pages, theme, logoPath: "/images/logo.png" });
    const home = withLogo.find((f) => f.path.endsWith("index.html"))!.content;
    expect(home).toContain('<a class="brand" href="/"><img class="brand__logo" src="/images/logo.png" alt="River Trust"></a>');
    expect(home).toContain('<div class="foot-brand"><img class="brand__logo"');
    const without = renderSite({ siteName: "River Trust", slug: "river", pages, theme });
    expect(without.find((f) => f.path.endsWith("index.html"))!.content).toContain('<a class="brand" href="/">River Trust</a>');
  });

  it("hands the logo to the image model for every design and briefs around it", async () => {
    const seen: Array<{ prompt: string; logo: boolean }> = [];
    const images = { model: "spy", generate: async (prompt: string, size: string, opts?: { logo?: unknown }) => { seen.push({ prompt, logo: Boolean(opts?.logo) }); return new MockImageGenerator().generate(); } };
    const tasks: string[] = [];
    const model = { complete: async (req: { task: string }) => { tasks.push(req.task); return { text: JSON.stringify({ audience: "a", message: "m", tone: "t", palette: "p", designs: [1, 2, 3, 4].map((i) => ({ caption: `c${i}`, prompt: `p${i}`, postText: "post #x" })) }), tokensEstimated: 1 }; } };
    const result = await generateCampaign({ model: model as never, images: images as never, kind: "social", prompt: "drive", org: { name: "River Trust" }, logo: { bytes: Buffer.from(PNG, "base64"), mime: "image/png" } });
    expect(result.designs).toHaveLength(4);
    expect(seen.every((s) => s.logo)).toBe(true);
    expect(tasks[0]).toMatch(/real logo will be placed/);
  });
});
