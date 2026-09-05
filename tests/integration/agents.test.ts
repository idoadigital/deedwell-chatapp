import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

describe("AI teammate profiles", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "profiles@example.org"));
    orgId = await createOrg(env.app, token, "profiles-org");
  });
  afterAll(async () => { await env.close(); });

  it("lists the roster with bios, skills and activity counts", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/agents`, { token });
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(13);
    const maya = res.body.agents.find((a: { agentKey: string }) => a.agentKey === "core.executive_assistant");
    expect(maya.name).toBe("Maya");
    expect(maya.bio.length).toBeGreaterThan(40);
    expect(maya.skills.length).toBeGreaterThan(0);
    expect(maya.activity).toEqual({ messages: 0, events: 0, artifacts: 0, last: null });
  });

  it("builds a work history from what the teammate actually did", async () => {
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const dm = channels.body.channels.find((c: { kind: string; agent_key: string }) => c.kind === "dm" && c.agent_key === "core.executive_assistant");
    expect(dm).toBeTruthy();
    const posted = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${dm.id}/messages`, { token, body: { body: "Hi Maya, what should we work on first?" } });
    expect(posted.status).toBe(201);

    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/agents/core.executive_assistant`, { token });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe("Maya");
    expect(res.body.dmChannelId).toBe(dm.id);
    expect(res.body.stats.messages).toBeGreaterThan(0);
    expect(res.body.timeline.length).toBeGreaterThan(0);
    expect(res.body.timeline[0]).toMatchObject({ kind: "message", channelId: dm.id });
    expect(res.body.timeline[0].title).toContain("#");
  });

  it("404s for a key that is not a teammate", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/agents/not.a.teammate`, { token });
    expect(res.status).toBe(404);
  });
});
