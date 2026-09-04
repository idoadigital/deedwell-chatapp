import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeFlush } from "../../apps/api/src/assistant.js";
import { workspaceBridgeFlush } from "../../apps/api/src/workspace.js";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/**
 * Chat-first workspace: the entire grant journey driven through conversation —
 * DM Maya → search → agent-created channel → info requests → approvals — with
 * workflow milestones arriving as teammate messages.
 */

let env: TestEnv;
let token: string;
let orgId: string;

const drainAll = async () => {
  // Drain until no run is actively runnable: a step can requeue with a retry
  // backoff seconds in the future, which fixed drain passes would miss.
  for (let i = 0; i < 40; i++) {
    await env.deps.engine.drain("test-worker");
    await bridgeFlush();
    await workspaceBridgeFlush();
    const { rows } = await env.adminPool.query(
      `SELECT COUNT(*)::int AS n FROM workflow_runs WHERE status IN ('pending','running')`
    );
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
};

const send = (channelId: string, body: string, fileId?: string) =>
  api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, {
    token, body: { body, fileId: fileId ?? null },
  });

const messagesOf = async (channelId: string) =>
  (await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token })).body
    .messages as Array<{ author_kind: string; author_agent: string | null; body: string; metadata: any }>;

beforeAll(async () => {
  env = await createTestEnv();
  ({ token } = await registerUser(env.app, "chat@example.org"));
  orgId = await createOrg(env.app, token, "chat-org");
  await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
    token,
    body: { facts: [
      { key: "legal_name", value: "Chat Org Inc." },
      { key: "mission", value: "Community programs" },
    ] },
  });
});
afterAll(async () => {
  await env.close();
});

describe("workspace conversations", () => {
  let channels: Array<{ id: string; key: string; kind: string; agent_key: string | null; name: string }>;
  let mayaDm: { id: string };

  it("provisions default channels, teammate DMs, and Maya's welcome", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    channels = res.body.channels;
    const keys = channels.map((c) => c.key);
    for (const expected of ["general", "announcements", "funding-opportunities", "grant-work", "website", "organization-information"]) {
      expect(keys).toContain(expected);
    }
    expect(channels.filter((c) => c.kind === "dm").length).toBe(13);
    expect(res.body.teammates.map((t: any) => t.name)).toContain("Maya");

    mayaDm = channels.find((c) => c.key === "dm:core.executive_assistant")!;
    const msgs = await messagesOf(mayaDm.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("I'm Maya");
  });

  it("greets and answers in DM as the teammate persona", async () => {
    const res = await send(mayaDm.id, "hello");
    expect(res.status).toBe(201);
    const reply = res.body.messages.at(-1);
    expect(reply.author_kind).toBe("agent");
    expect(reply.author_agent).toBe("core.executive_assistant");
    expect(reply.body).toContain("Maya");
  });

  it("is honest when it cannot understand a request", async () => {
    const res = await send(mayaDm.id, "quantum synergize the paradigm backwards");
    expect(res.body.messages.at(-1).body).toContain("couldn't map that");
  });

  let searchChannelId: string;
  let grantChannelId: string;

  it("searches for grants in conversation (results from David, the researcher)", async () => {
    searchChannelId = channels.find((c) => c.key === "funding-opportunities")!.id;
    const res = await send(searchChannelId, "Find grants for our youth development program");
    const reply = res.body.messages.at(-1);
    expect(reply.author_agent).toBe("grant.opportunity_researcher");
    expect(reply.metadata.searchResults.length).toBeGreaterThan(0);
    expect(reply.metadata.searchResults[0].title).toContain("[mock source]");
  });

  it("asks a NAMED clarification when 'apply for it' is ambiguous", async () => {
    const res = await send(searchChannelId, "apply for it");
    const reply = res.body.messages.at(-1).body as string;
    expect(reply).toContain("Capacity Building");
    expect(reply).toContain("Innovation Fund");
  });

  let pendingProjectId: string;
  let pendingChannelId: string;

  it("saves the application intent when announcement retrieval fails — no generic re-ask", async () => {
    // MOCK-002 has no retrievable announcement: honest failure + saved intent.
    const res = await send(searchChannelId, "apply for #2");
    const reply = res.body.messages.at(-1);
    expect(reply.body).toContain("saved");
    pendingChannelId = reply.metadata.goToChannelId;
    expect(pendingChannelId).toBeTruthy();

    const ws = await api(env.app, "GET", `/v1/orgs/${orgId}/workspace`, { token });
    const ch = ws.body.channels.find((c: any) => c.id === pendingChannelId);
    pendingProjectId = ch.project_id;
    const detail = await api(
      env.app, "GET", `/v1/orgs/${orgId}/projects/${pendingProjectId}/grant-workspace`, { token }
    );
    expect(detail.status).toBe(200);
    expect(detail.body.project.pending_intent.type).toBe("start_application");
    // The failed retrieval is a FAILED event and a failed source — never faked.
    expect(detail.body.events.some((e: any) => e.event_type === "announcement_retrieval_failed" && e.status === "failed")).toBe(true);
    expect(detail.body.sources.some((sc: any) => sc.fetch_status === "failed")).toBe(true);
    expect(detail.body.events.some((e: any) => e.event_type === "workspace_created")).toBe(true);
  });

  it("answers 'where do I find the announcement document?' with the exact grant", async () => {
    const res = await send(searchChannelId, "where do I find the announcement document?");
    const reply = res.body.messages.at(-1).body as string;
    expect(reply).toContain("Innovation Fund");           // names the actual grant
    expect(reply).toContain("already saved");             // intent preserved
    expect(reply).not.toContain("couldn't map that");     // never a generic re-ask
  });

  it("treats 'apply for it' as the saved application, not a new question", async () => {
    const res = await send(searchChannelId, "apply for it");
    const reply = res.body.messages.at(-1).body as string;
    expect(reply).toContain("Innovation Fund");
    expect(reply).toContain("saved");
  });

  it("re-attempts retrieval on 'can you go get it' and reports failure honestly", async () => {
    const res = await send(searchChannelId, "can you go get it");
    const reply = res.body.messages.at(-1).body as string;
    expect(reply).toContain("tried again");
    expect(reply).toContain("Innovation Fund");
    // Intent survives the failed retry.
    const detail = await api(
      env.app, "GET", `/v1/orgs/${orgId}/projects/${pendingProjectId}/grant-workspace`, { token }
    );
    expect(detail.body.project.pending_intent).toBeTruthy();
    expect(detail.body.events.filter((e: any) => e.event_type === "announcement_retrieval_failed").length).toBeGreaterThan(1);
  });

  it("resumes automatically when a retry retrieval succeeds", async () => {
    process.env.MOCK_ANNOUNCEMENT_RETRY_OK = "1";
    try {
      const res = await send(searchChannelId, "please try again");
      const reply = res.body.messages.at(-1);
      expect(reply.body).toContain("Resuming your application");
      expect(reply.metadata.runId).toBeTruthy();
      const detail = await api(
        env.app, "GET", `/v1/orgs/${orgId}/projects/${pendingProjectId}/grant-workspace`, { token }
      );
      expect(detail.body.project.pending_intent).toBeNull();
      expect(detail.body.events.some((e: any) => e.event_type === "intent_resumed")).toBe(true);
      expect(detail.body.sources.some((sc: any) => sc.fetch_status === "retrieved")).toBe(true);
    } finally {
      delete process.env.MOCK_ANNOUNCEMENT_RETRY_OK;
    }
    await drainAll();
  });

  it("resumes the blocked application automatically when the document arrives", async () => {
    // Fresh blocked application in another channel (retrieval fails again).
    const general = channels.find((c) => c.key === "general")!.id;
    await send(general, "find grants for our arts program");
    const applied = await send(general, "apply for #2");
    const chId = applied.body.messages.at(-1).metadata.goToChannelId as string;
    const ws = await api(env.app, "GET", `/v1/orgs/${orgId}/workspace`, { token });
    const projId = ws.body.channels.find((c: any) => c.id === chId).project_id;

    const doc = Buffer.from(
      "Applicants must be a registered 501(c)(3) nonprofit organization.\nThe narrative must not exceed 300 words and must describe the target population.\n",
      "utf8"
    ).toString("base64");
    const upload = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${chId}/files`, {
      token, body: { filename: "announcement.txt", mime: "text/plain", contentBase64: doc },
    });
    const res = await send(chId, "Attached: announcement.txt", upload.body.fileId);
    const reply = res.body.messages.at(-1);
    expect(reply.body.toLowerCase()).toContain("resum");
    expect(reply.metadata.runId).toBeTruthy();

    const detail = await api(
      env.app, "GET", `/v1/orgs/${orgId}/projects/${projId}/grant-workspace`, { token }
    );
    expect(detail.body.project.pending_intent).toBeNull(); // blocker cleared
    expect(detail.body.events.some((e: any) => e.event_type === "intent_resumed")).toBe(true);
    await drainAll();
  });

  it("retrieves the announcement automatically and starts the workflow on Apply", async () => {
    // Fresh channel: nothing uploaded here, so retrieval must do the work.
    const workChannel = channels.find((c) => c.key === "grant-work")!.id;
    await send(workChannel, "Find grants for our youth development program");
    // Structured Apply-button event: exact grant, not a re-parsed "#1".
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${workChannel}/messages`, {
      token, body: {
        body: "Apply for #1 — youth development Capacity Building Program [mock source]",
        action: {
          type: "start_grant_application", index: 1,
          title: "youth development Capacity Building Program [mock source]",
          number: "MOCK-2026-001", funder: "Mock Federal Agency", externalId: "MOCK-001",
        },
      },
    });
    const reply = res.body.messages.at(-1);
    expect(reply.body).toContain("set up #");
    grantChannelId = reply.metadata.goToChannelId;
    expect(grantChannelId).toBeTruthy();

    const ws = await api(env.app, "GET", `/v1/orgs/${orgId}/workspace`, { token });
    const projectId = ws.body.channels.find((c: any) => c.id === grantChannelId).project_id;
    const detail = await api(
      env.app, "GET", `/v1/orgs/${orgId}/projects/${projectId}/grant-workspace`, { token }
    );
    // Real retrieval recorded with provenance; workflow started immediately.
    expect(detail.body.events.some((e: any) => e.event_type === "announcement_retrieved" && e.status === "completed")).toBe(true);
    expect(detail.body.sources.some((sc: any) => sc.fetch_status === "retrieved" && sc.excerpt.includes("[mock source announcement]"))).toBe(true);
    expect(detail.body.files.length).toBeGreaterThan(0);
    expect(detail.body.run).toBeTruthy();

    await drainAll();
    const msgs = await messagesOf(grantChannelId);
    expect(msgs.some((m) => m.body.includes("I've selected"))).toBe(true);
    const ask = msgs.find((m) => m.metadata.infoRequest);
    expect(ask).toBeTruthy();
    // Structured info request (spec §6): typed fields with guidance, not bare keys.
    const fields = ask!.metadata.infoRequest as Array<Record<string, unknown>>;
    const entityField = fields.find((f) => f.key === "entity_type");
    expect(entityField).toBeTruthy();
    expect(entityField!.inputType).toBe("choice");
    expect(Array.isArray(entityField!.choices)).toBe(true);
    expect(String(entityField!.reason)).toContain("eligibility");
    expect(String(entityField!.label)).toBe("Entity type");

    // The timeline shows the real steps the durable engine persisted, and the
    // waiting run surfaces its open questions as a prefillable intake form.
    const after = await api(
      env.app, "GET", `/v1/orgs/${orgId}/projects/${projectId}/grant-workspace`, { token }
    );
    expect(after.body.events.some((e: any) => e.event_type === "step:extract_requirements")).toBe(true);
    expect(after.body.requirements.length).toBeGreaterThan(0);
    expect(after.body.questions.some((q: any) => q.key === "entity_type")).toBe(true);
    expect(after.body.completion).toBeGreaterThan(0);
    expect(after.body.completion).toBeLessThan(100);
  });

  it("accepts facts as a chat reply and reaches the bid gate as a message", async () => {
    await send(grantChannelId, "entity_type: 501(c)(3) public charity\nregistration_status: Registered in Ohio");
    await drainAll();
    const msgs = await messagesOf(grantChannelId);
    const bid = msgs.find((m) => m.metadata.approvalKind === "bid_decision");
    expect(bid).toBeTruthy();
    expect(bid!.author_agent).toBe("grant.funding_strategist");
    expect(bid!.body).toContain("/100");
  });

  it('replying "approve" decides the gate and the team continues to the final gate', async () => {
    await send(grantChannelId, "approve");
    await drainAll();
    const msgs = await messagesOf(grantChannelId);
    const final = msgs.find((m) => m.metadata.approvalKind === "final_export");
    expect(final).toBeTruthy();

    await send(grantChannelId, "approve");
    await drainAll();
    const done = await messagesOf(grantChannelId);
    expect(done.some((m) => m.body.includes("package is exported"))).toBe(true);
    expect(done.some((m) => m.body.includes("never guaranteed"))).toBe(true);
  });

  it("builds a website from a sentence: discovery → brief approval → build", async () => {
    const res = await send(mayaDm.id, "Please build a website for our organization");
    const reply = res.body.messages.at(-1);
    const siteChannel = reply.metadata.goToChannelId as string;
    expect(siteChannel).toBeTruthy();
    await drainAll();
    let msgs = await messagesOf(siteChannel);
    // Discovery first: the team asks for what it doesn't know.
    const ask = msgs.find((m) => m.metadata.infoRequest);
    expect(ask).toBeTruthy();
    await send(siteChannel, "programs: Community outreach\nbeneficiaries: Local families\nservice_area: Springfield\nheadquarters: 1 Main St");
    await drainAll();
    msgs = await messagesOf(siteChannel);
    // Then the brief gate — before anything is built.
    expect(msgs.some((m) => m.metadata.approvalKind === "website_brief")).toBe(true);
    expect(msgs.some((m) => m.metadata.approvalKind === "publish_site")).toBe(false);
    await send(siteChannel, "approve");
    await drainAll();
    msgs = await messagesOf(siteChannel);
    expect(msgs.some((m) => m.metadata.approvalKind === "publish_site")).toBe(true);
  });

  it("remembers its own outputs: asking about 'the website you built' returns the saved link", async () => {
    // The site was published in the previous test; the agent must find the
    // URL in project memory / the artifact registry — never ask for it.
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const siteChannel = res.body.channels.find(
      (c: any) => c.kind === "project" && c.name.includes("website")
    ) ?? res.body.channels.find((c: any) => c.name === "website-launch");
    // fall back: any project channel with a site
    const target = siteChannel ?? res.body.channels.find((c: any) => c.kind === "project");
    const reply = await send(target.id, "What is the link to the website you built?");
    const last = reply.body.messages.at(-1);
    expect(last.body).toMatch(/http/);
    expect(last.body.toLowerCase()).not.toContain("please provide");
    expect(last.body.toLowerCase()).not.toContain("send me the link");
  });

  it("does not rebuild when a website already exists — points to it instead", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const target = res.body.channels.find((c: any) => c.kind === "project" && c.name.includes("website"))
      ?? res.body.channels.find((c: any) => c.kind === "project");
    const reply = await send(target.id, "build a website please");
    const last = reply.body.messages.at(-1);
    expect(last.body).toContain("already has a website");
    expect(last.body).toMatch(/http/);
  });

  it("records decisions and URLs in durable project memory", async () => {
    const { rows } = await env.adminPool.query(
      "SELECT key_decisions, known_urls, latest_status FROM project_memories WHERE tenant_id = (SELECT id FROM organizations WHERE slug = 'chat-org') ORDER BY updated_at DESC"
    );
    expect(rows.length).toBeGreaterThan(0);
    const all = JSON.stringify(rows);
    expect(all).toContain("preview");
  });

  it("deduplicates resent messages via clientKey (idempotency)", async () => {
    const key = "test-idem-key-1";
    const first = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${mayaDm.id}/messages`, {
      token, body: { body: "hello again", clientKey: key },
    });
    expect(first.body.messages.length).toBeGreaterThan(0);
    const retry = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${mayaDm.id}/messages`, {
      token, body: { body: "hello again", clientKey: key },
    });
    expect(retry.body.messages).toHaveLength(0); // no duplicate work
  });

  it("keeps conversations tenant-isolated", async () => {
    const outsider = await registerUser(env.app, "chat-outsider@example.org");
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${mayaDm.id}/messages`, {
      token: outsider.token,
    });
    expect(res.status).toBe(404);
  });
});

describe("content from the conversation", () => {
  it("designs social posts on request and posts them back into the channel, saved as a campaign", async () => {
    const ws = (await api(env.app, "GET", `/v1/orgs/${orgId}/workspace`, { token })).body;
    const general = ws.channels.find((c: { kind?: string; name?: string }) => /general/i.test(String(c.name ?? "")) || c.kind === "general") ?? ws.channels[0];
    const res = await send(general.id, "Please create a social media post to promote our upcoming gala");
    expect(res.status).toBe(201);
    let msgs = await messagesOf(general.id);
    const ack = msgs.find((m) => m.author_kind === "agent" && m.metadata?.contentProjectId);
    expect(ack, "the designer should acknowledge with the campaign id").toBeTruthy();

    // The designs land on their own connection after the request; wait for them.
    let withImages: (typeof msgs)[number] | undefined;
    for (let i = 0; i < 60 && !withImages; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      msgs = await messagesOf(general.id);
      withImages = msgs.find((m) => Array.isArray(m.metadata?.images) && m.metadata.images.length > 0);
    }
    expect(withImages, "the finished designs should be posted").toBeTruthy();
    expect(withImages!.metadata.images[0]).toMatchObject({ fileId: expect.any(String) });

    // Same campaign the Content page and Artifacts list.
    const projects = (await api(env.app, "GET", `/v1/orgs/${orgId}/content`, { token })).body.contentProjects;
    expect(projects.some((p: { id: string; status: string }) => p.id === ack!.metadata.contentProjectId && p.status === "ready")).toBe(true);
  });
});
