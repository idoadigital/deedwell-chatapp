import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMissionProfile, missionProfileBlock, withContext } from "@deedwell/database";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Every agent reads the Mission Profile — the organization's facts, brand
 *  style, Knowledge Base notes and document titles — through one loader. */
describe("Mission Profile for agents", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "profile@example.org"));
    orgId = await createOrg(env.app, token, "profile-org");
  });
  afterAll(async () => { await env.close(); });

  const load = () => withContext(env.deps.appPool, { tenantId: orgId, userId }, (client) => loadMissionProfile(client, env.deps.storage, orgId, { fresh: true }));

  it("says plainly what is not known yet", async () => {
    const block = missionProfileBlock(await load());
    expect(block).toContain("ORGANIZATION: Org profile-org");
    expect(block).toContain("(No organization details saved yet.)");
    expect(block).toContain("(No brand style saved yet.)");
    expect(block).toContain("(No notes yet.)");
    expect(block).toContain("(No documents yet.)");
  });

  it("carries facts, brand style, note contents and document titles — and the logo pointer stays hidden", async () => {
    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts: [
      { key: "legal_name", value: "Rwanda Tech Sisters" }, { key: "mission", value: "We help young women in Rwanda build technology careers." },
      { key: "ein", value: "12-3456789" }, { key: "brand_voice", value: "Warm, direct, hopeful." }, { key: "brand_primary_color", value: "#0d5527" },
    ] } });
    const note = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "Programs.txt", mime: "text/plain", contentBase64: Buffer.from("Our flagship programme is a 12-week coding bootcamp in Kigali.").toString("base64") } });
    expect(note.status).toBe(201);
    const doc = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "Annual Report 2025.pdf", mime: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 fake").toString("base64") } });
    expect(doc.status).toBe(201);
    const logo = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, { token, body: { filename: "logo.png", mime: "image/png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } });
    await api(env.app, "PUT", `/v1/orgs/${orgId}/brand/logo`, { token, body: { fileId: logo.body.fileId } });

    const profile = await load();
    expect(profile.hasLogo).toBe(true);
    expect(profile.notes).toEqual([expect.objectContaining({ title: "Programs", text: expect.stringContaining("coding bootcamp") })]);
    expect(profile.documents.map((d) => d.filename)).toEqual(["Annual Report 2025.pdf"]);
    expect(profile.facts.some((f) => f.key === "brand_logo_file_id")).toBe(false);

    const block = missionProfileBlock(profile);
    expect(block).toContain("Organization name: Rwanda Tech Sisters");
    expect(block).toContain("Mission statement: We help young women");
    expect(block).toContain("EIN: 12-3456789");
    expect(block).toContain("Brand voice: Warm, direct, hopeful.");
    expect(block).toContain("Primary colour: #0d5527");
    expect(block).toContain("Logo: on file");
    expect(block).toContain("— Programs: Our flagship programme is a 12-week coding bootcamp in Kigali.");
    expect(block).toContain("Annual Report 2025.pdf");
    expect(block).not.toContain(logo.body.fileId);
  });

  it("a chat turn still works with the profile attached, and a saved fact is visible on the next turn without waiting for the cache", async () => {
    const chan = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const general = chan.body.channels.find((c: { key: string }) => c.key === "general").id;
    const reply = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${general}/messages`, { token, body: { body: "What is our EIN?" } });
    expect(reply.status).toBe(201);
    expect(reply.body.messages.some((m: { author_kind: string }) => m.author_kind === "agent")).toBe(true);
    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts: [{ key: "hq_location", value: "Kigali, Rwanda" }] } });
    const cached = await withContext(env.deps.appPool, { tenantId: orgId, userId }, (client) => loadMissionProfile(client, env.deps.storage, orgId));
    expect(cached.facts.some((f) => f.key === "hq_location")).toBe(true);
  });
});
