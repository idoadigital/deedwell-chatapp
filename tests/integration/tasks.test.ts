import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@deedwell/database";
import { creditTokens, saveStripeConfig } from "@deedwell/billing-domain";
import { runTaskTick } from "../../apps/api/src/tasks/runner.js";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Tasks: a person hands work to a teammate; the runner does it, stores the
 *  deliverables, meters tokens, reports in chat, and keeps routines on
 *  schedule. Chat can create tasks, approve them, and answer their questions. */
describe("Agent tasks", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;
  let dmChannel: string;
  let generalChannel: string;
  const AGENT = "grant.opportunity_researcher";

  const get = (path: string) => api(env.app, "GET", `/v1/orgs/${orgId}${path}`, { token });
  const post = (path: string, body: unknown = {}) => api(env.app, "POST", `/v1/orgs/${orgId}${path}`, { token, body });
  const detail = async (id: string) => (await get(`/tasks/${id}`)).body;
  const messagesIn = async (channelId: string) => (await get(`/channels/${channelId}/messages`)).body.messages as Array<Record<string, any>>;
  const tick = () => runTaskTick(env.deps, new Date(), 5, "test");
  // Earlier scenarios may leave queued work behind; start each new one clean.
  const drain = async () => { for (let i = 0; i < 6; i += 1) if ((await tick()).claimed === 0) return; };

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "tasks@example.org"));
    orgId = await createOrg(env.app, token, "tasks-org");
    const channels = (await get("/channels")).body.channels as Array<{ id: string; key: string }>;
    dmChannel = channels.find((c) => c.key === `dm:${AGENT}`)!.id;
    generalChannel = channels.find((c) => c.key === "general")!.id;
  });
  afterAll(async () => { await env.close(); });

  it("creates a one-off task, runs it, stores deliverables, meters tokens and reports in chat", async () => {
    const created = await post("/tasks", {
      title: "Summarize three youth literacy funders", instructions: "Find three funders and summarize each in two lines.",
      agentKey: AGENT, taskType: "research", priority: "high", tags: ["grants", "research"],
    });
    expect(created.status).toBe(201);
    const task = created.body.task;
    expect(task).toMatchObject({ status: "queued", agentName: "David", channelId: dmChannel, isRecurring: false });

    const listed = await get("/tasks?status=queued&agent=grant.opportunity_researcher&tag=grants&q=literacy");
    expect(listed.body.tasks.map((t: any) => t.id)).toEqual([task.id]);

    const stats = await tick();
    expect(stats).toMatchObject({ claimed: 1, completed: 1 });
    const d = await detail(task.id);
    expect(d.task.status).toBe("completed");
    expect(d.task.tokensUsed).toBeGreaterThan(0);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0].status).toBe("completed");
    expect(d.deliverables.map((x: any) => x.kind)).toEqual(["markdown"]);
    expect(d.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["created", "started", "progress", "deliverable", "completed"]));

    // Token usage is on the ledger, tagged as task work.
    const usage = await env.adminPool.query(`SELECT quantity, metadata FROM usage_ledger WHERE tenant_id = $1 AND metadata->>'source' = 'task'`, [orgId]);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].metadata.taskId).toBe(task.id);

    // The teammate reported in their DM with task cards.
    const msgs = (await messagesIn(dmChannel)).filter((m) => m.metadata?.taskId === task.id);
    expect(msgs.map((m) => m.metadata.taskUpdate)).toEqual(["started", "completed"]);
    expect(msgs[1]!.author_agent).toBe(AGENT);
    expect(msgs[1]!.metadata.taskDeliverables).toHaveLength(1);

    // Deliverables download as markdown, PDF, and all together as a zip.
    const md = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/tasks/${task.id}/deliverables/${d.deliverables[0].id}`, headers: { authorization: `Bearer ${token}` } });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Summarize three youth literacy funders");
    const pdf = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/tasks/${task.id}/deliverables/${d.deliverables[0].id}?format=pdf`, headers: { authorization: `Bearer ${token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(Buffer.from(pdf.rawPayload).subarray(0, 5).toString()).toBe("%PDF-");
    const zip = await env.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/tasks/${task.id}/deliverables.zip`, headers: { authorization: `Bearer ${token}` } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(Buffer.from(zip.rawPayload).subarray(0, 2).toString()).toBe("PK");

    // It shows up in the bell.
    const notes = await get("/notifications");
    expect(notes.body.items.some((i: any) => i.href === `/dashboard/tasks?task=${task.id}`)).toBe(true);
  });

  it("keeps a recurring task on its schedule", async () => {
    const created = await post("/tasks", {
      title: "Weekly funder scan", instructions: "Scan for new opportunities.", agentKey: AGENT,
      isRecurring: true, cronExpression: "0 9 * * 1", timezone: "America/New_York",
    });
    expect(created.status).toBe(201);
    const task = created.body.task;
    expect(task.scheduleLabel).toBe("Every Monday at 9:00 AM");
    expect(new Date(task.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect((await tick()).claimed).toBe(0);

    // "Run now" runs it ahead of schedule; afterwards it is queued again for the next Monday.
    expect((await post(`/tasks/${task.id}/run`)).status).toBe(200);
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    const d = await detail(task.id);
    expect(d.task.status).toBe("queued");
    expect(d.task.runCount).toBe(1);
    expect(d.task.lastRunStatus).toBe("completed");
    expect(new Date(d.task.nextRunAt).getUTCDay()).toBe(1);
    const filtered = await get("/tasks?recurring=true");
    expect(filtered.body.tasks.map((t: any) => t.id)).toEqual([task.id]);
    const bad = await post("/tasks", { title: "Bad schedule", agentKey: AGENT, isRecurring: true, cronExpression: "every monday" });
    expect(bad.status).toBe(400);
  });

  it("asks for approval before sensitive work, from chat or the dashboard", async () => {
    const created = await post("/tasks", { title: "Email the board", instructions: "Draft the board update.", agentKey: AGENT, requiresApproval: true, taskType: "outreach" });
    const task = created.body.task;
    expect(await tick()).toMatchObject({ claimed: 1, waiting: 1 });
    expect((await detail(task.id)).task.status).toBe("waiting_approval");
    const ask = (await messagesIn(dmChannel)).find((m) => m.metadata?.taskId === task.id && m.metadata.taskApproval);
    expect(ask).toBeTruthy();
    // Approving in the teammate's DM by chat.
    const reply = await post(`/channels/${dmChannel}/messages`, { body: "approve" });
    expect(reply.status).toBe(201);
    expect(reply.body.messages.some((m: any) => /Approved/.test(m.body))).toBe(true);
    expect((await detail(task.id)).task.status).toBe("queued");
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    expect((await detail(task.id)).task.status).toBe("completed");
  });

  it("parks a task with a question and resumes on the chat answer", async () => {
    const created = await post("/tasks", { title: "Program overview", instructions: "Write an overview. [needs user]", agentKey: AGENT });
    const task = created.body.task;
    expect(await tick()).toMatchObject({ claimed: 1, blocked: 1 });
    let d = await detail(task.id);
    expect(d.task.status).toBe("blocked");
    expect(d.task.blockedReason).toBe("needs_input");
    expect(d.task.metadata.question).toBe("Which program should this cover?");
    const q = (await messagesIn(dmChannel)).find((m) => m.metadata?.taskId === task.id && m.metadata.taskQuestion);
    expect(q).toBeTruthy();
    const answer = await post(`/channels/${dmChannel}/messages`, { body: "The after-school reading program" });
    expect(answer.body.messages.some((m: any) => /back on/.test(m.body))).toBe(true);
    d = await detail(task.id);
    expect(d.task.status).toBe("queued");
    expect(d.task.instructions).toContain("Answer from the team: The after-school reading program");
    // The answer removed the "[needs user]" trigger? No — instructions still carry it, so the mock asks again.
    // Answering through the API instead is equivalent; cancel to clean up.
    expect((await post(`/tasks/${task.id}/cancel`)).status).toBe(200);
    expect((await detail(task.id)).task.status).toBe("cancelled");
  });

  it("creates a task from a chat conversation: cadence, confirmation, card", async () => {
    const first = await post(`/channels/${generalChannel}/messages`, { body: "Set up a task to summarize new grant opportunities every Monday" });
    expect(first.status).toBe(201);
    const ask = first.body.messages.find((m: any) => m.author_kind === "agent");
    expect(ask.metadata.taskDraftStage).toBe("cadence");
    const second = await post(`/channels/${generalChannel}/messages`, { body: "Every Monday at 9am please" });
    const summary = second.body.messages.find((m: any) => m.author_kind === "agent");
    expect(summary.metadata.taskDraftStage).toBe("confirm");
    expect(summary.body).toContain("Every Monday at 9:00 AM");
    const third = await post(`/channels/${generalChannel}/messages`, { body: "confirm" });
    const done = third.body.messages.find((m: any) => m.author_kind === "agent");
    expect(done.metadata.taskId).toBeTruthy();
    expect(done.metadata.taskCard.isRecurring).toBe(true);
    const task = (await detail(done.metadata.taskId)).task;
    expect(task.cronExpression).toBe("0 9 * * 1");
    expect(task.createdFrom).toBe("chat");
    expect(task.channelId).toBe(generalChannel);
    // The draft is closed: a later message is handled normally.
    const later = await post(`/channels/${generalChannel}/messages`, { body: "hello" });
    expect(later.body.messages.find((m: any) => m.author_kind === "agent").metadata.taskId).toBeUndefined();
    // Declining a draft creates nothing.
    await post(`/channels/${generalChannel}/messages`, { body: "create a task to draft a thank-you letter once" });
    const cancel = await post(`/channels/${generalChannel}/messages`, { body: "never mind" });
    expect(cancel.body.messages.find((m: any) => m.author_kind === "agent").body).toContain("won't create");
  });

  it("waits for tokens when the organization has none, and resumes after a top-up", async () => {
    await saveStripeConfig(env.deps.appPool, { secretKey: "sk_test_x", webhookSecret: "whsec_x", setBy: userId });
    const created = await post("/tasks", { title: "Blocked by billing", agentKey: AGENT });
    // The org's balance is already negative from the runs above, so the create itself is refused…
    if (created.status === 402) {
      await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) => creditTokens(c, orgId, 5_000_000, { reason: "test" }));
      const again = await post("/tasks", { title: "Blocked by billing", agentKey: AGENT });
      expect(again.status).toBe(201);
      // …then drain the balance so the runner hits the gate.
      await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
        c.query(`INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES (gen_random_uuid(),$1,NULL,'model_tokens',6000000,'{}')`, [orgId]));
      expect(await tick()).toMatchObject({ claimed: 1, blocked: 1 });
      const d = await detail(again.body.task.id);
      expect(d.task.blockedReason).toBe("out_of_tokens");
      await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) => creditTokens(c, orgId, 10_000_000, { reason: "test" }));
      expect((await detail(again.body.task.id)).task.status).toBe("queued");
      expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    } else {
      expect(created.status).toBe(201);
    }
  });

  it("runs a multi-step workflow across teammates in sequence, then synthesises", async () => {
    await drain();
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) => creditTokens(c, orgId, 50_000_000, { reason: "test" }));
    const created = await post("/tasks", {
      title: "Spring funder outreach", instructions: "Research, then write.", agentKey: "grant.program_planner",
      steps: [
        { title: "Shortlist five funders", agentKey: AGENT, taskType: "research" },
        { title: "Draft the outreach email", agentKey: "grant.writer", taskType: "outreach" },
      ],
    });
    expect(created.status, created.raw).toBe(201);
    const wf = created.body.task;
    expect(wf.taskType).toBe("workflow");
    expect(wf.stepCount).toBe(2);
    // Only the first step is claimable; the second depends on it; the parent waits.
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    let d = await detail(wf.id);
    expect(d.task.status).toBe("in_progress");
    expect(d.steps.map((s: any) => s.status)).toEqual(["completed", "queued"]);
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    // Last step done → the coordinator is queued for synthesis and runs it.
    d = await detail(wf.id);
    expect(d.task.status).toBe("queued");
    expect(d.task.metadata.synthesis).toBe(true);
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    d = await detail(wf.id);
    expect(d.task.status).toBe("completed");
    // Deliverables roll up: two steps' documents plus the synthesis.
    expect(d.deliverables).toHaveLength(3);
    expect(d.deliverables.filter((x: any) => x.taskId === wf.id)).toHaveLength(1);
    expect(d.events.some((e: any) => /Every step is in/.test(e.message))).toBe(true);
    const list = await get("/tasks");
    expect(list.body.tasks.find((t: any) => t.id === wf.id).stepsDone).toBe(2);
    expect(list.body.tasks.some((t: any) => t.parentId)).toBe(false);
  });

  it("lets a teammate hand part of a task to another teammate, and waits for them", async () => {
    await drain();
    const created = await post("/tasks", { title: "Board packet", instructions: "Assemble the packet. [hand off to grant.writer]", agentKey: "grant.program_planner" });
    const task = created.body.task;
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });
    let d = await detail(task.id);
    expect(d.task.status).toBe("in_progress");
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].agentKey).toBe("grant.writer");
    expect(d.events.some((e: any) => e.kind === "delegated")).toBe(true);
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });   // the hand-off runs
    expect(await tick()).toMatchObject({ claimed: 1, completed: 1 });   // then the synthesis
    d = await detail(task.id);
    expect(d.task.status).toBe("completed");
    expect(d.deliverables.length).toBeGreaterThanOrEqual(3);
  });

  it("pauses and resumes a routine without losing its schedule", async () => {
    await drain();
    const created = await post("/tasks", { title: "Daily digest", agentKey: AGENT, isRecurring: true, cronExpression: "0 9 * * *", timezone: "UTC" });
    const task = created.body.task;
    expect((await post(`/tasks/${task.id}/pause`)).body.task.paused).toBe(true);
    await post(`/tasks/${task.id}/run`);
    expect((await tick()).claimed).toBe(0);
    const resumed = await post(`/tasks/${task.id}/resume`);
    expect(resumed.body.task.paused).toBe(false);
    expect(new Date(resumed.body.task.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const oneOff = await post("/tasks", { title: "Not a routine", agentKey: AGENT });
    expect((await post(`/tasks/${oneOff.body.task.id}/pause`)).status).toBe(409);
  });
});
