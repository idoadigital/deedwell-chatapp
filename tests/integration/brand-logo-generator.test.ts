import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { decodePng } from "../../apps/api/src/png.js";
import { edgeTransparency } from "../../apps/api/src/logo-generator.js";

/** The generator end to end in mock mode: request → brief → concepts →
 *  five rendered candidates → one chosen → it IS the Brand Style logo. */
describe("Brand Style logo generator", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "logo@example.org"));
    orgId = await createOrg(env.app, token, "logo-org");
  });
  afterAll(async () => { await env.close(); });

  it("needs an organization name before it writes a brief", async () => {
    const r = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/brief`, { token, body: { request: "Something modern and warm for our literacy programme." } });
    expect(r.status).toBe(409);
  });

  it("writes a brief from the request and the Mission Profile, plans distinct concepts, renders transparent candidates, and makes the chosen one the logo", async () => {
    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts: [
      { key: "legal_name", value: "Rwanda Tech Sisters" },
      { key: "mission", value: "We help young women in Rwanda build technology skills and careers." },
      { key: "brand_primary_color", value: "#0d5527" },
      { key: "brand_accent_color", value: "#dae470" },
    ] } });

    const briefRes = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/brief`, { token, body: { request: "Modern, empowering, trustworthy but not corporate. I'd like a wordmark." } });
    expect(briefRes.status).toBe(200);
    const brief = briefRes.body.brief;
    expect(brief.organizationName).toBe("Rwanda Tech Sisters");
    expect(brief.colors.mode).toBe("existing");
    expect(brief.colors.palette[0]).toBe("#0d5527");
    expect(brief.logoType).toBe("wordmark");

    const plan = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/concepts`, { token, body: { brief } });
    expect(plan.status).toBe(200);
    expect(plan.body.concepts).toHaveLength(5);
    // The user chose a wordmark: every concept is one, whatever the planner said.
    expect(plan.body.concepts.every((c: { logoType: string }) => c.logoType === "wordmark")).toBe(true);
    expect(new Set(plan.body.concepts.map((c: { approach: string }) => c.approach)).size).toBe(5);
    const { generationId } = plan.body;

    const candidates = await Promise.all(plan.body.concepts.map((concept: { id: string }) =>
      api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/render`, { token, body: { generationId, conceptId: concept.id, brief, concept: stripId(concept) } })));
    for (const c of candidates) { expect(c.status).toBe(200); expect(c.body.candidate.size).toBeGreaterThan(0); }

    const first = plan.body.concepts[0];
    const img = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/brand/logo/candidates/${generationId}/${first.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    const decoded = decodePng(Buffer.from(img.rawPayload));
    expect(edgeTransparency(decoded)).toBeGreaterThan(0.6);

    // Candidates are not documents.
    const before = await api(env.app, "GET", `/v1/orgs/${orgId}/knowledge`, { token });
    expect(before.body.files).toHaveLength(0);

    const chosen = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/select`, { token, body: { generationId, conceptId: first.id, brief, concept: stripId(first), prompt: candidates[0].body.candidate.prompt } });
    expect(chosen.status).toBe(200);
    expect(chosen.body.logo).toMatchObject({ filename: "rwanda-tech-sisters-logo.png", mime: "image/png" });

    // Exactly what an upload produces: the same GET, the same fact, one file.
    const logo = await api(env.app, "GET", `/v1/orgs/${orgId}/brand/logo`, { token });
    expect(logo.body.logo.fileId).toBe(chosen.body.logo.fileId);
    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    const byKey = Object.fromEntries(facts.body.facts.map((f: { fact_key?: string; key?: string; value: string }) => [f.fact_key ?? f.key, f.value]));
    expect(byKey.brand_logo_file_id).toBe(chosen.body.logo.fileId);
    const meta = JSON.parse(byKey.brand_logo_meta);
    expect(meta.logo_source).toBe("generated");
    expect(meta.logo_type).toBe("wordmark");
    expect(meta.logo_generation_id).toBe(generationId);
    expect(meta.selected_logo_asset).toBe(chosen.body.logo.fileId);
    const after = await api(env.app, "GET", `/v1/orgs/${orgId}/knowledge`, { token });
    expect(after.body.files).toHaveLength(1);
    const content = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/files/${chosen.body.logo.fileId}/content`, headers: { authorization: `Bearer ${token}` } });
    expect(edgeTransparency(decodePng(Buffer.from(content.rawPayload)))).toBeGreaterThan(0.6);
  });

  it("rejects a candidate that was never rendered", async () => {
    const r = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/select`, { token, body: {
      generationId: "00000000-0000-0000-0000-000000000000", conceptId: "c9-nope",
      brief: sampleBrief(), concept: { title: "x", approach: "y", logoType: "wordmark", direction: "z" },
    } });
    expect(r.status).toBe(404);
  });

  it("says so when voice transcription is not configured", async () => {
    const r = await api(env.app, "POST", `/v1/orgs/${orgId}/brand/logo/transcribe`, { token, body: { audioBase64: Buffer.alloc(4000, 1).toString("base64"), mime: "audio/webm" } });
    expect([502, 503]).toContain(r.status);
  });
});

function stripId<T extends { id?: string }>(c: T): Omit<T, "id"> { const { id: _id, ...rest } = c; return rest; }
function sampleBrief() {
  return {
    organizationName: "Rwanda Tech Sisters", tagline: null, description: "A nonprofit.", objectives: ["trust"], audience: "Everyone",
    personality: ["Modern"], logoType: "wordmark", visualStyle: ["Minimal"], colors: { mode: "custom", palette: ["#000000"], notes: null },
    symbolism: [], avoid: [], designerNotes: "Keep it simple.",
  };
}
