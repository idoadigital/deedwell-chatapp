import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

describe("channel messages: newest-anchored pages with attachments", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let channelId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "pages@example.org"));
    orgId = await createOrg(env.app, token, "pages-org");
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    channelId = channels.body.channels.find((c: { kind: string }) => c.kind !== "dm")?.id ?? channels.body.channels[0].id;
    for (let i = 1; i <= 25; i += 1) {
      const r = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token, body: { body: `note ${i}` } });
      expect(r.status).toBe(201);
    }
  });
  afterAll(async () => { await env.close(); });

  it("returns the newest messages, ascending, and pages back by id without losing ties", async () => {
    const page = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages?limit=20`, { token });
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(20);
    expect(page.body.hasMore).toBe(true);
    const bodies = page.body.messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain("note 25");                        // the newest note is on the first page
    expect(bodies).not.toContain("note 1");                     // the oldest fell off it
    // Ascending by (created_at, id): never a later timestamp before an earlier one.
    for (let i = 1; i < page.body.messages.length; i += 1) {
      expect(page.body.messages[i].created_at >= page.body.messages[i - 1].created_at).toBe(true);
    }
    const ids = new Set(page.body.messages.map((m: { id: string }) => m.id));
    const older = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages?limit=300&before=${page.body.messages[0].id}`, { token });
    expect(older.status).toBe(200);
    const olderBodies = older.body.messages.map((m: { body: string }) => m.body);
    expect(olderBodies).toContain("note 1");
    expect(older.body.messages.every((m: { id: string }) => !ids.has(m.id))).toBe(true);   // no overlap, no gap
    expect(older.body.hasMore).toBe(false);
    // Every message in the channel is on exactly one of the two pages.
    const all = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages?limit=300`, { token });
    expect(all.body.messages.length).toBe(page.body.messages.length + older.body.messages.length);
  });

  it("carries the attached file's name and type on the message", async () => {
    const up = await api(env.app, "POST", `/v1/orgs/${orgId}/files`, {
      token, body: { filename: "budget.txt", mime: "text/plain", contentBase64: Buffer.from("line items").toString("base64") },
    });
    expect(up.status).toBe(201);
    const fileId = up.body.fileId ?? up.body.id;
    const posted = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token, body: { body: "Here is the budget", fileId } });
    expect(posted.status).toBe(201);
    const page = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages?limit=20`, { token });
    const mine = page.body.messages.find((m: { body: string }) => m.body === "Here is the budget");
    expect(mine.attachment).toMatchObject({ id: fileId, filename: "budget.txt", mime: "text/plain" });
  });
});
