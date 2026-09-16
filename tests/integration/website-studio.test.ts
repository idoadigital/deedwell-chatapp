import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildSiteRouter } from "../../apps/site-router/src/router.js";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/**
 * The website studio, end to end on the mock model with a real headless
 * browser: generate → automatic QA → the AI editor makes a verified,
 * surgical change → undo → version history → publish → blog/events served
 * dynamically → custom domain instructions.
 */

let env: TestEnv;
let router: FastifyInstance;

beforeAll(async () => {
  env = await createTestEnv();
  router = buildSiteRouter({ adminPool: env.deps.adminPool, storage: env.deps.storage, baseDomain: "deedwell.test" });
  await router.ready();
}, 120_000);
afterAll(async () => { await router.close(); await env.close(); });

const drain = () => env.deps.engine.drain("test-worker", 200);

async function buildSite() {
  const { userId, token } = await registerUser(env.app, "studio@example.org");
  const orgId = await createOrg(env.app, token, "studio-org");
  await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts: [
    { key: "legal_name", value: "Generosity Global" }, { key: "mission", value: "Clean water for every village in East Africa" },
    { key: "programs", value: "Wells; Sanitation; Education" }, { key: "beneficiaries", value: "Rural families" },
    { key: "service_area", value: "Kenya and Uganda" }, { key: "headquarters", value: "Nairobi" }, { key: "contact_email", value: "hello@generosityglobal.org" },
  ] } });
  const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, { token, body: { name: "Our Website", type: "website" } });
  const site = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${project.body.projectId}/website`, { token, body: { siteName: "Generosity Global", slug: "generosity-global", donateUrl: "https://donate.example/gg" } });
  expect(site.status).toBe(201);
  await drain();
  const runId = site.body.runId as string;
  await api(env.app, "POST", `/v1/orgs/${orgId}/runs/${runId}/provide-info`, { token, body: { facts: [{ key: "site_intake_skipped", value: true }] } });
  await drain();
  const run = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${runId}`, { token });
  const brief = run.body.approvals.find((a: any) => a.kind === "website_brief");
  await api(env.app, "POST", `/v1/orgs/${orgId}/approvals/${brief.id}`, { token, body: { decision: "approved" } });
  await drain();
  return { userId, token, orgId, siteId: site.body.siteId as string, runId };
}

describe("website studio", () => {
  let s: Awaited<ReturnType<typeof buildSite>>;

  it("generates the site and runs automatic QA before the publish gate", async () => {
    s = await buildSite();
    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${s.runId}`, { token: s.token });
    expect(run.body.run.status).toBe("waiting_approval");
    expect(run.body.approvals.some((a: any) => a.kind === "publish_site" && a.status === "pending")).toBe(true);
    const studio = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/studio`, { token: s.token });
    expect(studio.status).toBe(200);
    expect(studio.body.jobs.qa, "post-generation QA recorded a job").toBeTruthy();
    expect(["complete", "failed"]).toContain(studio.body.jobs.qa.status);
    expect(studio.body.jobs.qa.steps.length).toBeGreaterThan(3);
    expect(studio.body.jobs.qa.steps.every((st: any) => ["done", "failed", "skipped"].includes(st.status))).toBe(true);
    expect(["passed", "review", "failed"]).toContain(studio.body.site.qa_status);
    const qa = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/qa`, { token: s.token });
    expect(qa.body.latest.result.outcome.checks).toBeGreaterThan(10);
    expect(qa.body.latest.result.outcome.browser, "QA used a real browser").toBe(true);
  }, 240_000);

  it("the editor inspects, changes the mobile hero heading surgically, verifies it and updates the preview", async () => {
    const before = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token });
    const versionsBefore = before.body.versions.length;
    const sent = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/editor/messages`, { token: s.token, body: {
      body: "The hero heading is too large on mobile and there's too much space before the Donate button.",
      context: { page: "home", viewport: "mobile" },
    } });
    expect(sent.status).toBe(202);
    await drain();
    const job = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/jobs/${sent.body.jobId}`, { token: s.token });
    expect(job.body.job.status, JSON.stringify(job.body.job.steps)).toBe("complete");
    const keys = job.body.job.steps.map((x: any) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["inspect", "plan", "measure", "apply", "build", "verify:390", "verify:1440", "preview"]));
    expect(job.body.job.steps.filter((x: any) => x.status === "done").length).toBeGreaterThanOrEqual(7);
    const plan = job.body.job.result.plan;
    expect(plan.operations.some((o: any) => o.kind === "style" && o.viewport === "mobile" && o.declarations["font-size"])).toBe(true);
    expect(job.body.job.result.verified.some((v: string) => /fontSize .* at 390px/.test(v))).toBe(true);
    expect(job.body.job.result.verified.some((v: string) => /fontSize .* at 1440px/.test(v)), "desktop unchanged was verified").toBe(true);
    expect(job.body.job.result.problems).toEqual([]);

    const messages = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/editor/messages`, { token: s.token });
    const reply = messages.body.messages.at(-1);
    expect(reply.role).toBe("assistant");
    expect(reply.body).toMatch(/Done/);
    expect(messages.body.undoable).toBeTruthy();

    // The preview is a new version that carries the override.
    const after = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token });
    expect(after.body.versions.length).toBe(versionsBefore + 1);
    expect(after.body.versions[0].kind).toBe("edit");
    const page = await router.inject({ method: "GET", url: "/preview/generosity-global/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<style id="site-overrides">');
    expect(page.body).toMatch(/@media \(max-width: 639px\)\{[^}]*font-size/);

    // A follow-up refers to the same heading and only tightens it further.
    const again = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/editor/messages`, { token: s.token, body: { body: "That's better, but make the heading slightly smaller.", context: { page: "home", viewport: "mobile" } } });
    await drain();
    const job2 = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/jobs/${again.body.jobId}`, { token: s.token });
    expect(job2.body.job.status).toBe("complete");
    expect(job2.body.job.result.plan.operations).toHaveLength(1);
  }, 240_000);

  it("undo restores the previous version without destroying history; restore and publish work", async () => {
    const before = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token });
    const undo = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/undo`, { token: s.token });
    expect(undo.status).toBe(200);
    const after = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token });
    expect(after.body.versions.length).toBe(before.body.versions.length + 1);
    expect(after.body.versions[0].kind).toBe("restore");
    expect(after.body.versions[0].is_preview).toBe(true);
    const restored = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions/${before.body.versions[0].id}/restore`, { token: s.token });
    expect(restored.status).toBe(200);
    const published = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/publish`, { token: s.token });
    expect(published.status).toBe(200);
    const live = await router.inject({ method: "GET", url: "/generosity-global/" });
    expect(live.statusCode).toBe(200);
    // The build that was parked at its publish gate resumes and finishes.
    await drain();
    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${s.runId}`, { token: s.token });
    expect(run.body.approvals.find((a: any) => a.kind === "publish_site").status).toBe("approved");
    expect(run.body.run.status).toBe("completed");
    const site = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}`, { token: s.token });
    expect(site.body.site.active_release_id).toBe(site.body.site.preview_release_id);
  }, 60_000);

  it("blog and events are served dynamically without a rebuild, and donations/domains are managed", async () => {
    const versions = (await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token })).body.versions.length;
    // A featured image is uploaded once and served by the site itself.
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc00000030101009f9c11ff0000000049454e44ae426082", "hex").toString("base64");
    const media = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/media`, { token: s.token, body: { filename: "well.png", mime: "image/png", contentBase64: png } });
    expect(media.status).toBe(201);
    expect(media.body.key).toMatch(/\.png$/);
    const fake = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/media`, { token: s.token, body: { filename: "well.jpg", mime: "image/jpeg", contentBase64: png } });
    expect(fake.status, "content sniffed, not trusted").toBe(400);
    const post = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/posts`, { token: s.token, body: { title: "New wells in Turkana", excerpt: "Three villages now have clean water.", content: "## Progress\n\nWe finished **three** wells.\n\n- Lodwar\n- Kakuma", status: "published", author: "Grace", featuredImageKey: media.body.key } });
    expect(post.status).toBe(201);
    const served = await router.inject({ method: "GET", url: `/generosity-global/media/${media.body.key}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect((await router.inject({ method: "GET", url: "/generosity-global/media/nope.png" })).statusCode).toBe(404);
    const event = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/events`, { token: s.token, body: { title: "Water for Africa Dinner", description: "Join us for an evening of impact.", startsAt: new Date(Date.now() + 86400000 * 30).toISOString(), location: "Nairobi", registrationUrl: "https://tickets.example/dinner", status: "published" } });
    expect(event.status).toBe(201);
    expect((await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/versions`, { token: s.token })).body.versions.length, "no rebuild").toBe(versions);
    const list = await router.inject({ method: "GET", url: "/generosity-global/blog/" });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("New wells in Turkana");
    expect(list.body).toContain(`/media/${media.body.key}`);
    const detail = await router.inject({ method: "GET", url: "/generosity-global/blog/new-wells-in-turkana/" });
    expect(detail.body).toContain("<strong>three</strong>");
    expect(detail.body).toContain("<li>Lodwar</li>");
    const events = await router.inject({ method: "GET", url: "/generosity-global/events/" });
    expect(events.body).toContain("Water for Africa Dinner");
    const home = await router.inject({ method: "GET", url: "/generosity-global/" });
    expect(home.body).toMatch(/href="\/generosity-global\/blog\/"/);
    expect(home.body).toMatch(/href="\/generosity-global\/events\/"/);
    expect((await router.inject({ method: "GET", url: "/generosity-global/blog/nope/" })).statusCode).toBe(404);

    const donations = await api(env.app, "PUT", `/v1/orgs/${s.orgId}/sites/${s.siteId}/donations`, { token: s.token, body: { donateUrl: "https://donate.example/gg", presets: [25, 50, 100], monthly: true } });
    expect(donations.status).toBe(200);
    const insecure = await api(env.app, "PUT", `/v1/orgs/${s.orgId}/sites/${s.siteId}/donations`, { token: s.token, body: { donateUrl: "http://donate.example/gg" } });
    expect(insecure.status).toBe(400);

    const domain = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/domains`, { token: s.token, body: { domain: "https://www.generosityglobal.org/" } });
    expect(domain.status).toBe(201);
    expect(domain.body.domain.domain).toBe("www.generosityglobal.org");
    expect(domain.body.domain.instructions.map((i: any) => i.type)).toEqual(["TXT", "CNAME"]);
    expect(domain.body.domain.instructions[1].value).toBe("ghs.googlehosted.com");
    const verify = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/domains/${domain.body.domain.id}/verify`, { token: s.token });
    expect(["pending_dns", "verifying"]).toContain(verify.body.domain.status);
  }, 60_000);

  it("Run QA on demand records real findings with evidence and a scoped request narrows the checks", async () => {
    const started = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${s.siteId}/qa`, { token: s.token, body: { instruction: "Check the footer on mobile." } });
    expect(started.status).toBe(202);
    await drain();
    const qa = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/qa`, { token: s.token });
    expect(qa.body.latest.id).toBe(started.body.jobId);
    expect(qa.body.latest.status).toBe("complete");
    expect(qa.body.latest.result.outcome.browser).toBe(true);
    expect(qa.body.latest.result.scope.viewports).toEqual([390, 360]);
    expect(qa.body.latest.result.scope.categories).toContain("footer");
    for (const f of qa.body.findings) expect(["detected", "repairing", "fixed", "verified", "needs_review"]).toContain(f.status);
  }, 240_000);

  it("keeps another organization out of the site's studio, jobs, content and domains", async () => {
    const other = await registerUser(env.app, "outsider@example.org");
    const otherOrg = await createOrg(env.app, other.token, "other-org");
    const qa = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${s.siteId}/qa`, { token: s.token });
    const paths = [
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/studio`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/editor/messages`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/jobs/${qa.body.latest.id}`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/qa`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/posts`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/domains`],
      ["GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/versions`],
    ] as const;
    for (const [method, url] of paths) {
      const res = await api(env.app, method, url, { token: other.token });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const edit = await api(env.app, "POST", `/v1/orgs/${otherOrg}/sites/${s.siteId}/editor/messages`, { token: other.token, body: { body: "Make the heading red" } });
    expect(edit.status).toBe(404);
    // The owner's own org on someone else's org id is refused too.
    const cross = await api(env.app, "GET", `/v1/orgs/${otherOrg}/sites/${s.siteId}/studio`, { token: s.token });
    expect([403, 404]).toContain(cross.status);
  }, 30_000);
});
