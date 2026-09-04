import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { loadSiteGenerationSettings, pickReferenceTemplate } from "@deedwell/website-domain";

// A 1x1 transparent PNG — enough to be a real image without being a fixture file.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("Platform Admin → Site Generation Settings", () => {
  let env: TestEnv;
  let admin: { userId: string; token: string };
  let member: { userId: string; token: string };

  beforeAll(async () => {
    env = await createTestEnv();
    admin = await registerUser(env.app, "site-admin@example.org");
    member = await registerUser(env.app, "site-member@example.org");
    await env.adminPool.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [admin.userId]);
  });
  afterAll(async () => { await env.close(); });

  it("is closed to anyone who is not a platform admin", async () => {
    const res = await api(env.app, "GET", "/v1/admin/site-generation", { token: member.token });
    expect(res.status).toBe(403);
    const put = await api(env.app, "PUT", "/v1/admin/site-generation/settings", {
      token: member.token, body: { requiredSections: [], guidance: "" },
    });
    expect(put.status).toBe(403);
  });

  it("starts empty and round-trips the settings", async () => {
    const before = await api(env.app, "GET", "/v1/admin/site-generation", { token: admin.token });
    expect(before.status).toBe(200);
    expect(before.body.settings).toEqual({ requiredSections: [], guidance: "" });
    expect(before.body.templates).toEqual([]);

    const saved = await api(env.app, "PUT", "/v1/admin/site-generation/settings", {
      token: admin.token,
      body: {
        requiredSections: [
          { key: "privacy-policy", title: "Privacy Policy", description: "Required by most funders." },
          { key: "financials", title: "Financials" },
        ],
        guidance: "Funders read the About page first.",
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.requiredSections[1]).toEqual({ key: "financials", title: "Financials", description: "" });

    const after = await api(env.app, "GET", "/v1/admin/site-generation", { token: admin.token });
    expect(after.body.settings.guidance).toBe("Funders read the About page first.");
    // What the website builder itself will read.
    const seen = await loadSiteGenerationSettings(env.deps.appPool);
    expect(seen.requiredSections.map((s) => s.key)).toEqual(["privacy-policy", "financials"]);
  });

  it("rejects malformed settings", async () => {
    const dup = await api(env.app, "PUT", "/v1/admin/site-generation/settings", {
      token: admin.token,
      body: { requiredSections: [{ key: "a", title: "A" }, { key: "a", title: "Again" }], guidance: "" },
    });
    expect(dup.status).toBe(400);
    const badKey = await api(env.app, "PUT", "/v1/admin/site-generation/settings", {
      token: admin.token,
      body: { requiredSections: [{ key: "Not A Slug", title: "A" }], guidance: "" },
    });
    expect(badKey.status).toBe(400);
  });

  it("stores a reference template, serves its bytes, and archives it", async () => {
    const created = await api(env.app, "POST", "/v1/admin/site-generation/templates", {
      token: admin.token,
      body: { filename: "landing.png", mime: "image/png", contentBase64: PNG_BASE64, title: "Warm landing", description: "Photo hero." },
    });
    expect(created.status).toBe(201);
    const id = created.body.template.id as string;
    expect(created.body.template).toMatchObject({ title: "Warm landing", status: "active", mime: "image/png" });

    const content = await env.app.inject({
      method: "GET", url: `/v1/admin/site-generation/templates/${id}/content`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(content.rawPayload.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

    // The generator draws from the active library.
    const picked = await pickReferenceTemplate(env.deps.appPool, env.deps.storage, () => 0);
    expect(picked?.id).toBe(id);
    expect(picked?.bytes.length).toBe(Buffer.from(PNG_BASE64, "base64").length);

    const archived = await api(env.app, "PATCH", `/v1/admin/site-generation/templates/${id}`, {
      token: admin.token, body: { status: "archived" },
    });
    expect(archived.status).toBe(200);
    expect(archived.body.template.status).toBe("archived");
    expect(await pickReferenceTemplate(env.deps.appPool, env.deps.storage)).toBeNull();

    const list = await api(env.app, "GET", "/v1/admin/site-generation", { token: admin.token });
    expect(list.body.templates.map((t: { id: string }) => t.id)).toContain(id);
  });

  it("refuses non-image uploads", async () => {
    const res = await api(env.app, "POST", "/v1/admin/site-generation/templates", {
      token: admin.token,
      body: { filename: "notes.pdf", mime: "application/pdf", contentBase64: PNG_BASE64, title: "Nope" },
    });
    expect(res.status).toBe(400);
  });

  it("shapes a generated site: required sections reach the brief and a reference design is chosen", async () => {
    // The library was emptied by the archive above; put one design back so
    // there is exactly one thing the builder can pick.
    const created = await api(env.app, "POST", "/v1/admin/site-generation/templates", {
      token: admin.token,
      body: { filename: "home.png", mime: "image/png", contentBase64: PNG_BASE64, title: "Editorial home", description: "Serif headings." },
    });
    const templateId = created.body.template.id as string;

    const orgId = await createOrg(env.app, admin.token, "sitegen-org");
    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
      token: admin.token,
      body: { facts: [
        { key: "legal_name", value: "Riverbend Youth Alliance" },
        { key: "mission", value: "Mentoring and after-school programs for youth" },
        { key: "programs", value: "Mentoring; Tutoring" },
        { key: "beneficiaries", value: "Youth ages 10-18" },
        { key: "service_area", value: "Riverbend County" },
        { key: "headquarters", value: "12 Main St, Riverbend" },
      ] },
    });
    const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
      token: admin.token, body: { name: "Our Website", type: "website" },
    });
    const site = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${project.body.projectId}/website`, {
      token: admin.token, body: { siteName: "Riverbend", slug: "riverbend-sitegen" },
    });
    expect(site.status).toBe(201);
    const runId = site.body.runId as string;

    // Discovery asks its optional direction questions first; skip them the
    // way the chat UI does, then let the run reach the brief.
    await env.deps.engine.drain("test-worker");
    await api(env.app, "POST", `/v1/orgs/${orgId}/runs/${runId}/provide-info`, {
      token: admin.token, body: { facts: [{ key: "site_intake_skipped", value: true }] },
    });
    await env.deps.engine.drain("test-worker");

    const run = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${runId}`, { token: admin.token });
    const brief = run.body.approvals.find((a: any) => a.kind === "website_brief");
    expect(brief, "the build should pause at a website brief").toBeTruthy();
    const slugs = brief.payload.sitemap.map((p: any) => p.slug);
    expect(slugs).toContain("privacy-policy");
    expect(slugs).toContain("financials");
    expect(brief.payload.referenceTemplate).toEqual({ id: templateId, title: "Editorial home" });

    const { rows } = await env.adminPool.query(
      "SELECT reference_template_id FROM sites WHERE tenant_id = $1", [orgId]
    );
    expect(rows[0]?.reference_template_id).toBe(templateId);
  });
});
