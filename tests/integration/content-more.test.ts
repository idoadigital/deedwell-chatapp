import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Generation is detached from the request, so the client polls. */
async function waitSettled(env: TestEnv, orgId: string, token: string, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/content/${id}`, { token });
    if (r.body.contentProject.status !== "generating") return r.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("campaign never settled");
}

describe("Content Studio → generate more", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "content@example.org"));
    orgId = await createOrg(env.app, token, "content-org");
  });
  afterAll(async () => { await env.close(); });

  it("appends a further round of designs after the existing ones", async () => {
    const created = await api(env.app, "POST", `/v1/orgs/${orgId}/content`, {
      token, body: { kind: "social", prompt: "Promote our upcoming gala" },
    });
    expect(created.status).toBe(202);
    const id = created.body.contentProject.id as string;

    const first = await waitSettled(env, orgId, token, id);
    expect(first.contentProject.status).toBe("ready");
    const firstCount = first.assets.length as number;
    expect(firstCount).toBeGreaterThan(0);

    const more = await api(env.app, "POST", `/v1/orgs/${orgId}/content/${id}/more`, { token });
    expect(more.status).toBe(202);
    expect(more.body.contentProject.status).toBe("generating");

    const second = await waitSettled(env, orgId, token, id);
    expect(second.contentProject.status).toBe("ready");
    expect(second.contentProject.error).toBeNull();
    expect(second.assets.length).toBeGreaterThan(firstCount);

    // The originals are untouched and the new ones sort after them.
    const firstIds = first.assets.map((a: { id: string }) => a.id);
    expect(second.assets.slice(0, firstCount).map((a: { id: string }) => a.id)).toEqual(firstIds);
    const positions = second.assets.map((a: { position: number }) => a.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    // The stored strategy now explains every design, old and new.
    expect(second.contentProject.strategy.designs).toHaveLength(second.assets.length);
  });

  it("refuses a campaign that does not exist", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/content/01a00000-0000-7000-8000-000000000000/more`, { token });
    expect(res.status).toBe(404);
  });
});
