import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

describe("message reactions", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let channelId: string;
  let messageId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "react@example.org"));
    orgId = await createOrg(env.app, token, "react-org");
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    channelId = channels.body.channels.find((c: { kind: string }) => c.kind !== "dm")?.id ?? channels.body.channels[0].id;
    const posted = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token, body: { body: "Great work everyone" } });
    expect(posted.status).toBe(201);
    messageId = posted.body.messages.find((m: { author_kind: string }) => m.author_kind === "user")?.id;
    expect(messageId).toBeTruthy();
  });
  afterAll(async () => { await env.close(); });

  it("toggles a reaction on and off and shows it on the message", async () => {
    const on = await api(env.app, "POST", `/v1/orgs/${orgId}/messages/${messageId}/reactions`, { token, body: { emoji: "🎉" } });
    expect(on.status).toBe(200);
    expect(on.body.reacted).toBe(true);
    expect(on.body.reactions).toEqual([{ emoji: "🎉", count: 1, reacted: true }]);

    const listed = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token });
    const mine = listed.body.messages.find((m: { id: string }) => m.id === messageId);
    expect(mine.reactions.some((r: { emoji: string; reacted: boolean }) => r.emoji === "🎉" && r.reacted)).toBe(true);

    const off = await api(env.app, "POST", `/v1/orgs/${orgId}/messages/${messageId}/reactions`, { token, body: { emoji: "🎉" } });
    expect(off.status).toBe(200);
    expect(off.body.reacted).toBe(false);
    expect(off.body.reactions).toEqual([]);
  });

  it("refuses emoji outside the bar and messages that are not there", async () => {
    const bad = await api(env.app, "POST", `/v1/orgs/${orgId}/messages/${messageId}/reactions`, { token, body: { emoji: "🦄" } });
    expect(bad.status).toBe(400);
    const missing = await api(env.app, "POST", `/v1/orgs/${orgId}/messages/01a00000-0000-7000-8000-000000000000/reactions`, { token, body: { emoji: "👍" } });
    expect(missing.status).toBe(404);
  });
});
