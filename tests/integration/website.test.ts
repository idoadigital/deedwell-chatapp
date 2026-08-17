import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSiteRouter } from "../../apps/site-router/src/router.js";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/**
 * Phase 4: website builder end-to-end — intake → brief → generated pages →
 * built release with checks → preview via Site Router → publish approval →
 * live → conversational update → diffable releases → rollback → forms.
 */

let env: TestEnv;
let router: FastifyInstance;

beforeAll(async () => {
  env = await createTestEnv();
  router = buildSiteRouter({
    adminPool: env.deps.adminPool,
    storage: env.deps.storage,
    baseDomain: "deedwell.test",
  });
  await router.ready();
});
afterAll(async () => {
  await router.close();
  await env.close();
});

async function setupOrg(slug: string) {
  const { userId, token } = await registerUser(env.app, `${slug}@example.org`);
  const orgId = await createOrg(env.app, token, slug);
  await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
    token,
    body: {
      facts: [
        { key: "legal_name", value: "Riverbend Youth Alliance" },
        { key: "mission", value: "Mentoring and after-school programs for youth" },
        { key: "programs", value: "Mentoring; Tutoring; Summer camp" },
        { key: "beneficiaries", value: "Youth ages 10-18" },
        { key: "service_area", value: "Riverbend County" },
        { key: "headquarters", value: "12 Main St, Riverbend" },
      ],
    },
  });
  const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
    token, body: { name: "Our Website", type: "website" },
  });
  return { userId, token, orgId, projectId: project.body.projectId };
}

async function pendingApproval(orgId: string, token: string, runId: string) {
  const run = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${runId}`, { token });
  return { run, approval: run.body.approvals.find((a: any) => a.status === "pending") };
}

const routerGet = (url: string) => router.inject({ method: "GET", url });

describe("website build → preview → publish", () => {
  let s: Awaited<ReturnType<typeof setupOrg>>;
  let siteId: string;
  let runId: string;

  it("builds a previewable release and pauses at the publish gate", async () => {
    s = await setupOrg("riverbend");
    const created = await api(env.app, "POST",
      `/v1/orgs/${s.orgId}/projects/${s.projectId}/website`,
      { token: s.token, body: { siteName: "Riverbend Youth Alliance", slug: "riverbend", donateUrl: "https://donate.example/riverbend" } });
    expect(created.status).toBe(201);
    siteId = created.body.siteId;
    runId = created.body.runId;
    await env.deps.engine.drain("test-worker");

    // Stage 2: the brief must be approved before anything is built.
    const brief = await pendingApproval(s.orgId, s.token, runId);
    expect(brief.approval.kind).toBe("website_brief");
    const preBuild = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    expect(preBuild.body.releases).toHaveLength(0); // nothing built yet
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${brief.approval.id}`, {
      token: s.token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");

    const { run, approval } = await pendingApproval(s.orgId, s.token, runId);
    expect(run.body.run.status).toBe("waiting_approval");
    expect(approval.kind).toBe("publish_site");
    expect(approval.payload.previewPath).toBe("/preview/riverbend/");

    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    expect(detail.body.site.status).toBe("preview");
    expect(detail.body.pages.length).toBeGreaterThanOrEqual(4);
    expect(detail.body.releases).toHaveLength(1);
    const checks = detail.body.releases[0].checks;
    expect(checks.length).toBeGreaterThan(5);
    expect(checks.filter((c: any) => !c.pass)).toEqual([]);
  });

  it("serves the preview through the Site Router with strict security headers", async () => {
    const res = await routerGet("/preview/riverbend/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Riverbend Youth Alliance");
    expect(res.body).toContain("Mentoring and after-school programs");
    expect(res.body).not.toContain("<script");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    // Framing allowed ONLY for the app origins (artifact-panel preview),
    // still refused for everyone else.
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.headers["content-security-policy"]).not.toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBeUndefined();

    expect((await routerGet("/preview/riverbend/about/")).statusCode).toBe(200);
    expect((await routerGet("/preview/riverbend/sitemap.xml")).statusCode).toBe(200);
    // Not published yet: the live address must not exist (either form).
    expect((await routerGet("/live/riverbend/")).statusCode).toBe(404);
    expect((await routerGet("/riverbend/")).statusCode).toBe(404);
  });

  it("host-based routing resolves preview and live subdomains", async () => {
    const res = await router.inject({
      method: "GET", url: "/", headers: { host: "riverbend.preview.deedwell.test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Riverbend Youth Alliance");
    const unknown = await router.inject({
      method: "GET", url: "/", headers: { host: "nope.preview.deedwell.test" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain("Site not found");
  });

  it("publishes only after human approval", async () => {
    const { approval } = await pendingApproval(s.orgId, s.token, runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${approval.id}`, {
      token: s.token, body: { decision: "approved", note: "Ship it." },
    });
    await env.deps.engine.drain("test-worker");

    const live = await routerGet("/live/riverbend/");
    expect(live.statusCode).toBe(200);
    expect(live.body).toContain("Riverbend Youth Alliance");

    // Bare root form — the production address (sites.deedwell.org/<slug>/).
    const bare = await routerGet("/riverbend/");
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain("Riverbend Youth Alliance");
    expect((await routerGet("/riverbend/about/")).statusCode).toBe(200);
    // Missing trailing slash redirects so relative links resolve in-site.
    const redirect = await routerGet("/riverbend");
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/riverbend/");
    // Reserved segments and unknown slugs still 404 cleanly.
    expect((await routerGet("/forms/")).statusCode).toBe(404);
    expect((await routerGet("/no-such-site/")).statusCode).toBe(404);

    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    expect(detail.body.site.status).toBe("published");
    expect(detail.body.releases[0].status).toBe("published");
  });

  it("conversational update: preview changes while live stays, then publish v2", async () => {
    const update = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${siteId}/update`, {
      token: s.token, body: { instruction: 'Change the tagline to "Hope grows in Riverbend"' },
    });
    expect(update.status).toBe(201);
    await env.deps.engine.drain("test-worker");

    // Preview has the new tagline; live still serves v1.
    expect((await routerGet("/preview/riverbend/")).body).toContain("Hope grows in Riverbend");
    expect((await routerGet("/live/riverbend/")).body).not.toContain("Hope grows in Riverbend");

    const { approval } = await pendingApproval(s.orgId, s.token, update.body.runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${approval.id}`, {
      token: s.token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");
    expect((await routerGet("/live/riverbend/")).body).toContain("Hope grows in Riverbend");

    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    expect(detail.body.releases).toHaveLength(2);
    expect(detail.body.releases.find((r: any) => r.version === 1).status).toBe("superseded");
    expect(detail.body.releases.find((r: any) => r.version === 2).status).toBe("published");
  });

  it("an untranslatable request completes honestly instead of faking success", async () => {
    const update = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${siteId}/update`, {
      token: s.token, body: { instruction: "Make the vibes more synergistic" },
    });
    await env.deps.engine.drain("test-worker");
    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${update.body.runId}`, { token: s.token });
    expect(run.body.run.status).toBe("completed");
    expect(run.body.run.applied).toBe(false);
    expect(run.body.run.reason).toContain("mock provider");
    // No new release was built.
    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    expect(detail.body.releases).toHaveLength(2);
  });

  it("rolls back to a previous release", async () => {
    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}`, { token: s.token });
    const v1 = detail.body.releases.find((r: any) => r.version === 1);
    const res = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${siteId}/rollback`, {
      token: s.token, body: { releaseId: v1.id },
    });
    expect(res.status).toBe(200);
    const live = await routerGet("/live/riverbend/");
    expect(live.body).not.toContain("Hope grows in Riverbend");
    expect(live.body).toContain("Mentoring and after-school programs");
  });

  it("accepts form submissions, drops honeypot hits, and lists them tenant-scoped", async () => {
    const post = await router.inject({
      method: "POST",
      url: "/forms/riverbend/contact",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Dana&email=dana%40example.org&message=How+can+I+help%3F",
    });
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe("/thanks/");

    const bot = await router.inject({
      method: "POST",
      url: "/forms/riverbend/contact",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Bot&email=bot%40spam.example&message=spam&website=http%3A%2F%2Fspam",
    });
    expect(bot.statusCode).toBe(303); // bots get no signal

    const list = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}/submissions`, {
      token: s.token,
    });
    expect(list.body.submissions).toHaveLength(1);
    expect(list.body.submissions[0].payload.name).toBe("Dana");

    // Another tenant cannot see them.
    const outsider = await registerUser(env.app, "outsider-web@example.org");
    const other = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${siteId}/submissions`, {
      token: outsider.token,
    });
    expect(other.status).toBe(404);
  });

  it("slug collisions and reserved slugs are rejected", async () => {
    const other = await setupOrg("other-web-org");
    const taken = await api(env.app, "POST",
      `/v1/orgs/${other.orgId}/projects/${other.projectId}/website`,
      { token: other.token, body: { siteName: "Clash", slug: "riverbend" } });
    expect(taken.status).toBe(409);
    const reserved = await api(env.app, "POST",
      `/v1/orgs/${other.orgId}/projects/${other.projectId}/website`,
      { token: other.token, body: { siteName: "Nope", slug: "admin" } });
    expect(reserved.status).toBe(409);
  });
});

describe("website discovery gate", () => {
  it("asks discovery questions instead of building when facts are missing", async () => {
    const { token } = await registerUser(env.app, "bare-org@example.org");
    const orgId = await createOrg(env.app, token, "bare-web-org");
    const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
      token, body: { name: "Site", type: "website" },
    });
    const created = await api(env.app, "POST",
      `/v1/orgs/${orgId}/projects/${project.body.projectId}/website`,
      { token, body: { siteName: "Bare Org", slug: "bare-org" } });
    await env.deps.engine.drain("test-worker");
    const run = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${created.body.runId}`, { token });
    expect(run.body.run.status).toBe("waiting_for_info");
    expect(run.body.run.waiting.payload).toContain("mission");
    // Nothing was generated or built before discovery completed.
    const site = await api(env.app, "GET", `/v1/orgs/${orgId}/sites/${created.body.siteId}`, { token });
    expect(site.body.pages).toHaveLength(0);
    expect(site.body.releases).toHaveLength(0);
  });

  it("serves the site's own 404 page with a real 404 status", async () => {
    const res = await routerGet("/preview/riverbend/no-such-page/");
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Page not found");
    expect(res.body).toContain("Riverbend");
  });
});

describe("website security", () => {
  it("hostile org facts cannot inject markup into the rendered site", async () => {
    const { token, orgId, projectId } = await setupOrg("xss-org");
    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
      token,
      body: { facts: [{ key: "mission", value: `<script>document.cookie</script><img src=x onerror=alert(1)>` }] },
    });
    const created = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/website`, {
      token, body: { siteName: "XSS Test", slug: "xss-test" },
    });
    expect(created.status).toBe(201);
    await env.deps.engine.drain("test-worker");
    const runX = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${created.body.runId}`, { token });
    const briefX = runX.body.approvals.find((a: any) => a.status === "pending");
    await api(env.app, "POST", `/v1/orgs/${orgId}/approvals/${briefX.id}`, {
      token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");

    const res = await routerGet("/preview/xss-test/");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>document.cookie");
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("&lt;script&gt;");
  });
});
