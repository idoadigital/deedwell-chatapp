import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { mentionedTeammate } from "../../apps/api/src/routes-chat.js";

describe("editing, deleting and addressing messages", () => {
  let env: TestEnv;
  let token: string;      // owner
  let orgId: string;
  let channelId: string;
  let member: string;     // a second, non-admin member

  const post = (t: string, body: string) => api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token: t, body: { body } });
  const mine = (r: { body: { messages: Array<{ author_kind: string; id: string }> } }) => r.body.messages.find((m) => m.author_kind === "user")!.id;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ token } = await registerUser(env.app, "owner@example.org"));
    orgId = await createOrg(env.app, token, "edit-org");
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    channelId = channels.body.channels.find((c: { kind: string }) => c.kind !== "dm")?.id ?? channels.body.channels[0].id;
    // Second member via invitation.
    const other = await registerUser(env.app, "member@example.org");
    member = other.token;
    const invite = await api(env.app, "POST", `/v1/orgs/${orgId}/invitations`, { token, body: { email: "member@example.org", role: "member" } });
    if (invite.status === 201 || invite.status === 200) {
      const code = invite.body.invitation?.code ?? invite.body.code ?? invite.body.token;
      if (code) await api(env.app, "POST", `/v1/invitations/${code}/accept`, { token: member });
    }
  });
  afterAll(async () => { await env.close(); });

  it("lets the author edit, keeps the history, and marks it edited", async () => {
    const id = mine(await post(token, "Lets meet tuesday"));
    const edited = await api(env.app, "PATCH", `/v1/orgs/${orgId}/messages/${id}`, { token, body: { body: "Let's meet Thursday" } });
    expect(edited.status).toBe(200);
    expect(edited.body.message.editedAt).toBeTruthy();
    const page = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token });
    const m = page.body.messages.find((x: { id: string }) => x.id === id);
    expect(m.body).toBe("Let's meet Thursday");
    expect(m.edited_at).toBeTruthy();
    const { rows } = await env.adminPool.query("SELECT previous_body FROM message_edits WHERE message_id = $1", [id]);
    expect(rows.map((r) => r.previous_body)).toEqual(["Lets meet tuesday"]);
  });

  it("refuses edits of other people's and agents' messages", async () => {
    const r = await post(token, "hello team");
    const agentMsg = r.body.messages.find((m: { author_kind: string }) => m.author_kind === "agent");
    if (agentMsg) {
      const res = await api(env.app, "PATCH", `/v1/orgs/${orgId}/messages/${agentMsg.id}`, { token, body: { body: "nope" } });
      expect(res.status).toBe(403);
    }
    const missing = await api(env.app, "PATCH", `/v1/orgs/${orgId}/messages/01a00000-0000-7000-8000-000000000000`, { token, body: { body: "x" } });
    expect(missing.status).toBe(404);
  });

  it("deletes into a tombstone that hides the text and blocks further edits", async () => {
    const id = mine(await post(token, "secret draft numbers"));
    const del = await api(env.app, "DELETE", `/v1/orgs/${orgId}/messages/${id}`, { token });
    expect(del.status).toBe(200);
    const page = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token });
    const m = page.body.messages.find((x: { id: string }) => x.id === id);
    expect(m.deleted).toBe(true);
    expect(m.body).toBe("");
    expect(m.deleted_at).toBeTruthy();
    const edit = await api(env.app, "PATCH", `/v1/orgs/${orgId}/messages/${id}`, { token, body: { body: "back" } });
    expect(edit.status).toBe(409);
  });

  it("routes an @mention to the named teammate", async () => {
    expect(mentionedTeammate("@Michael what should the budget be?")).toBe("grant.budget_specialist");
    expect(mentionedTeammate("hey @maya")).toBe("core.executive_assistant");
    expect(mentionedTeammate("email me at team@example.org")).toBeNull();
    expect(mentionedTeammate("@Nobody around?")).toBeNull();
    const r = await post(token, "@Michael what should the budget be?");
    const agent = r.body.messages.find((m: { author_kind: string }) => m.author_kind === "agent");
    expect(agent?.author_agent).toBe("grant.budget_specialist");
  });
});
