import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

async function waitSettled(env: TestEnv, orgId: string, token: string, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/content/${id}`, { token });
    if (r.body.contentProject.status !== "generating") return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("campaign never settled");
}

describe("Content Studio → captions and scheduling", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "sched@example.org"));
    orgId = await createOrg(env.app, token, "sched-org");
  });
  afterAll(async () => { await env.close(); });

  it("every generated design comes with a social caption", async () => {
    const created = await api(env.app, "POST", `/v1/orgs/${orgId}/content`, {
      token, body: { kind: "social", prompt: "Back-to-school supply drive" },
    });
    expect(created.status).toBe(202);
    const settled = await waitSettled(env, orgId, token, created.body.contentProject.id);
    expect(settled.contentProject.status).toBe("ready");
    for (const asset of settled.assets) {
      expect(typeof asset.post_text).toBe("string");
      expect(asset.post_text.length).toBeGreaterThan(20);
      expect(asset.post_text).toMatch(/#\w+/);
    }
  });

  it("ranks best times for a platform in the viewer's timezone and explains each", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/content/best-times?platform=instagram_account&timezone=Europe/London&days=10&count=5`, { token });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Europe/London");
    expect(res.body.slots).toHaveLength(5);
    expect(res.body.suggested.at).toBe(res.body.slots[0].at);
    expect(res.body.slots[0].reason).toMatch(/Instagram|lunch|evening|morning/i);
    const bogus = await api(env.app, "GET", `/v1/orgs/${orgId}/content/best-times?timezone=Not/AZone`, { token });
    expect(bogus.body.timezone).toBe("UTC");
  });

  it("refuses to move or cancel a post that does not exist", async () => {
    const moved = await api(env.app, "PATCH", `/v1/orgs/${orgId}/content/posts/01a00000-0000-7000-8000-000000000000`, {
      token, body: { scheduledAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(moved.status).toBe(409);
    const gone = await api(env.app, "DELETE", `/v1/orgs/${orgId}/content/posts/01a00000-0000-7000-8000-000000000000`, { token });
    expect(gone.status).toBe(409);
    const past = await api(env.app, "PATCH", `/v1/orgs/${orgId}/content/posts/01a00000-0000-7000-8000-000000000000`, {
      token, body: { scheduledAt: "2020-01-01T00:00:00Z" },
    });
    expect(past.status).toBe(400);
  });
});
