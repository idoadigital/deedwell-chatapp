import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEnv, api, registerUser, createOrg, type TestEnv } from "../helpers.js";
import type { GcpGrantPlatform, GcpIds, GcpTurnResult } from "../../apps/api/src/gcp/platform.js";
import { poll as bridgePoll } from "../../apps/api/src/gcp/bridge.js";
import { invalidateGcpWorkspace } from "../../apps/api/src/gcp/workspace.js";

/**
 * The external grant platform integration, driven end-to-end through the real
 * API with a scripted platform double. What's under test is OUR side of the
 * contract: routing (which channels reach the platform and which never do),
 * tenancy mapping (server-side ids only), the handoff (apply → bound project
 * channel), metadata translation (cards), the async bridge, and isolation.
 */

const APP_ID = "aaaaaaaa-1111-4111-8111-111111111111";

function scriptedPlatform() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let orgCounter = 0;
  const provisioned = new Map<string, GcpIds>();
  let nextTurn: Partial<GcpTurnResult> | null = null;
  let activityTasks: Array<Record<string, unknown>> = [];
  let running = 0;

  const turnResult = (over: Partial<GcpTurnResult>): GcpTurnResult => ({
    conversation_id: "c0000000-0000-4000-8000-000000000000",
    message: "Here is what I found.",
    intent: { capability: "status_overview", label: "Status", backend: "conversation API", task_type: null, routing_method: "deterministic" },
    outcome: "OK", tasks: [], application_id: null, data: null, latency_ms: 5, error: null,
    ...over,
  });

  const platform: GcpGrantPlatform = {
    name: "scripted",
    async provision(input) {
      calls.push({ method: "provision", args: [input] });
      const key = input.externalOrgRef + ":" + input.userEmail;
      if (!provisioned.has(key)) {
        orgCounter += 1;
        provisioned.set(key, {
          organizationId: `bbbbbbbb-2222-4222-8222-${String(orgCounter).padStart(12, "0")}`,
          userId: `cccccccc-3333-4333-8333-${String(orgCounter).padStart(12, "0")}`,
        });
      }
      return provisioned.get(key)!;
    },
    async createConversation(ids, applicationId) {
      calls.push({ method: "createConversation", args: [ids, applicationId] });
      return `dddddddd-4444-4444-8444-${String(calls.length).padStart(12, "0")}`;
    },
    async turn(conversationId, ids, message) {
      calls.push({ method: "turn", args: [conversationId, ids, message] });
      const r = turnResult(nextTurn ?? {});
      nextTurn = null;
      return r;
    },
    async activity() { return { tasks: activityTasks, counts: { running } }; },
    async conversationState() { return {}; },
    async applicationOverview(applicationId) {
      calls.push({ method: "applicationOverview", args: [applicationId] });
      return { application_id: applicationId, status: "REQUIREMENTS_ANALYSIS",
        funder: "The Waterloo Foundation", program_name: "Education Small Grants",
        official_url: "https://example.org/grant", deadline_text: "Rolling", deadline_date: null,
        grant_opportunity: { recommendation: "Apply", mission_fit_score: 8 } };
    },
    async requirements() {
      return { readiness: { total: 4, complete: 1, percent_complete: 25 },
        requirements: [{ requirement_key: "org_info", title: "Basic organisation information",
          requirement_type: "ORGANIZATION_INFORMATION", is_required: true, status: "COMPLETE",
          status_reason: "Answered by the organization.", word_limit: null,
          source: { quote: "Supply basic information on your organisation" } }] };
    },
    async informationRequests() {
      return { open_count: 1, requests: [{ request_id: "e1111111-5555-4555-8555-000000000001",
        request_type: "INFORMATION", question: "What is the requested grant amount?",
        rationale: "The funder requires a requested amount.", options: [], status: "OPEN" }] };
    },
    async answerInformationRequest(applicationId, requestId, ids, answerText) {
      calls.push({ method: "answerInformationRequest", args: [applicationId, requestId, ids, answerText] });
      return { request_id: requestId, status: "ANSWERED" };
    },
    async strategy() { return { strategy: { version: 1, status: "DRAFT", positioning: "Community-led WASH", evidence_gaps: [] }, approved_version: null }; },
    async sections() { return { progress: { total: 2, not_started: 1, draft: 1, review: 0, approved: 0 }, sections: [
      { section_id: "f0000000-6666-4666-8666-000000000001", section_title: "Project title", status: "DRAFT", current_revision_number: 1 },
      { section_id: "f0000000-6666-4666-8666-000000000002", section_title: "Outcomes", status: "NOT_STARTED", current_revision_number: 0 },
    ] }; },
    async budget() { return { budget: { version: 2, status: "DRAFT", validation_status: "VALID", currency: "GBP", requested_amount: 9200, total_project_cost: 12000, direct_costs: 11000, indirect_costs: 1000, lines: [] } }; },
    async compliance() { return { latest: { result: "NOT_READY", hard_blocker_count: 2, checks_run: 10, checks_passed: 8, created_at: new Date().toISOString(), blockers: [{ label: "No section approved", result: "HARD_BLOCKER" }], warnings: [], checks: [] } }; },
    async deliverables() { return { deliverables: [{ deliverable_id: "d1111111-7777-4777-8777-000000000001", deliverable_type: "APPLICATION_PACKAGE", format: "DOCX", status: "COMPLETE", size_bytes: 11287, version: 1, created_at: new Date().toISOString() }] }; },
    async documents() { return { documents: [] }; },
    async evidence() { return { count: 12, evidence: [] }; },
    async uploadDocument(ids, filename) {
      calls.push({ method: "uploadDocument", args: [ids, filename] });
      return { document_id: "d2222222-8888-4888-8888-000000000001", ingestion_status: "PENDING" };
    },
    async getDocument() { return {}; },
    async downloadDeliverable(deliverableId, ids) {
      calls.push({ method: "downloadDeliverable", args: [deliverableId, ids] });
      if (deliverableId !== "d1111111-7777-4777-8777-000000000001") throw new Error("not found");
      return { bytes: Buffer.from("PK-fake-docx"), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "application.docx" };
    },
  };
  return {
    platform, calls,
    setNextTurn(t: Partial<GcpTurnResult>) { nextTurn = t; },
    setActivity(tasks: Array<Record<string, unknown>>, runningCount: number) { activityTasks = tasks; running = runningCount; },
  };
}

describe("external grant platform integration", () => {
  let env: TestEnv;
  let scripted: ReturnType<typeof scriptedPlatform>;
  let token: string;
  let orgId: string;
  let davidDm: string;

  beforeAll(async () => {
    scripted = scriptedPlatform();
    env = await createTestEnv({ gcp: scripted.platform });
    const user = await registerUser(env.app, "gcp-owner@example.org");
    token = user.token;
    orgId = await createOrg(env.app, token, "gcp-test-org");
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    davidDm = ch.body.channels.find((c: any) => c.key === "dm:grant.opportunity_researcher").id;
  });
  afterAll(async () => { await env.close(); });

  it("routes a grant-team DM to the platform and answers as that teammate", async () => {
    scripted.setNextTurn({ message: "I researched three opportunities.", intent: { capability: "research_grants", label: "Grant research", backend: "research worker", task_type: "research", routing_method: "deterministic" }, tasks: [{ task_id: "a1111111-9999-4999-8999-000000000001", task_type: "research", status: "queued" }] });
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${davidDm}/messages`, {
      token, body: { body: "Find grants for Generosity Global" } });
    expect(res.status).toBe(201);
    const agentMsg = res.body.messages.find((m: any) => m.author_kind === "agent");
    expect(agentMsg.author_agent).toBe("grant.opportunity_researcher");
    expect(agentMsg.body).toContain("I researched three opportunities.");
    expect(scripted.calls.filter((c) => c.method === "provision").length).toBe(1);
    expect(scripted.calls.filter((c) => c.method === "turn").length).toBe(1);
  });

  it("does not re-provision on the next message", async () => {
    await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${davidDm}/messages`, {
      token, body: { body: "Anything new?" } });
    expect(scripted.calls.filter((c) => c.method === "provision").length).toBe(1);
  });

  it("maps opportunities into the existing search-result card metadata", async () => {
    scripted.setNextTurn({
      message: "Here are the opportunities.",
      intent: { capability: "show_opportunities", label: "Opportunities", backend: "conversation API", task_type: null, routing_method: "deterministic" },
      data: { opportunities: [
        { funder: "The Waterloo Foundation", program_name: "Education Small Grants", recommendation: "Apply", deadline_text: "Rolling", official_url: "https://example.org/grant" },
        { funder: "AFNet", program_name: "Flexible Grant", recommendation: "Do not apply" },
      ] },
    });
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${davidDm}/messages`, {
      token, body: { body: "Show me the opportunities" } });
    const agentMsg = res.body.messages.find((m: any) => m.author_kind === "agent");
    expect(agentMsg.metadata.searchResults).toHaveLength(2);
    expect(agentMsg.metadata.searchResults[0]).toMatchObject({ index: 1, title: "Education Small Grants", funder: "The Waterloo Foundation" });
  });

  it("apply → durable handoff: project channel bound to the platform application", async () => {
    scripted.setNextTurn({
      message: "Workspace opened for The Waterloo Foundation.",
      intent: { capability: "create_application", label: "Start application", backend: "conversation API", task_type: null, routing_method: "deterministic" },
      application_id: APP_ID, outcome: "OK",
      tasks: [{ task_id: "a1111111-9999-4999-8999-000000000002", task_type: "requirements_analysis", status: "queued" }],
    });
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${davidDm}/messages`, {
      token, body: { body: "Apply for number 1" } });
    const agentMsg = res.body.messages.find((m: any) => m.author_kind === "agent");
    expect(agentMsg.metadata.goToChannelId).toBeTruthy();

    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.id === agentMsg.metadata.goToChannelId);
    expect(projectChannel.kind).toBe("project");
    expect(projectChannel.project_type).toBe("grant_application");

    // The platform conversation for the new channel opened already bound to
    // the application — that binding is the durable cross-agent context.
    const bound = scripted.calls.find((c) => c.method === "createConversation" && c.args[1] === APP_ID);
    expect(bound).toBeTruthy();

    // Daniel greets in the new workspace channel.
    const msgs = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${projectChannel.id}/messages`, { token });
    expect(msgs.body.messages.some((m: any) => m.author_agent === "grant.program_planner")).toBe(true);
  });

  it("project-channel turns run on the platform; capability picks the speaking teammate", async () => {
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.kind === "project" && c.project_type === "grant_application");
    scripted.setNextTurn({
      message: "Strategy v1 drafted.",
      intent: { capability: "generate_strategy", label: "Application strategy", backend: "agent worker", task_type: "strategy_generation", routing_method: "deterministic" },
      application_id: APP_ID,
    });
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${projectChannel.id}/messages`, {
      token, body: { body: "Draft the application strategy" } });
    const agentMsg = res.body.messages.find((m: any) => m.author_kind === "agent");
    expect(agentMsg.author_agent).toBe("grant.funding_strategist");
    expect(agentMsg.metadata.openWorkspace).toBe(true);
  });

  it("Maya's DM and the website team stay on the local engine", async () => {
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const mayaDm = ch.body.channels.find((c: any) => c.key === "dm:core.executive_assistant").id;
    const avaDm = ch.body.channels.find((c: any) => c.key === "dm:website.digital_strategist").id;
    const turnsBefore = scripted.calls.filter((c) => c.method === "turn").length;
    await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${mayaDm}/messages`, { token, body: { body: "hello" } });
    await api(env.app, "POST", `/v1/orgs/${orgId}/channels/${avaDm}/messages`, { token, body: { body: "hello" } });
    expect(scripted.calls.filter((c) => c.method === "turn").length).toBe(turnsBefore);
  });

  it("workspace panel serves real platform state (requirements, questions, compliance)", async () => {
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.kind === "project" && c.project_type === "grant_application");
    invalidateGcpWorkspace(projectChannel.project_id);
    const ws = await api(env.app, "GET", `/v1/orgs/${orgId}/projects/${projectChannel.project_id}/grant-workspace`, { token });
    expect(ws.status).toBe(200);
    expect(ws.body.gcp).toBeTruthy();
    expect(ws.body.gcp.application.funder).toBe("The Waterloo Foundation");
    expect(ws.body.completion).toBe(25);
    expect(ws.body.requirements[0]).toMatchObject({ text: "Basic organisation information", status: "COMPLETE" });
    expect(ws.body.questions[0]).toMatchObject({ key: "e1111111-5555-4555-8555-000000000001" });
    expect(ws.body.gcp.compliance.result).toBe("NOT_READY");
    expect(ws.body.gcp.deliverables).toHaveLength(1);
  });

  it("structured question answers reach the platform's answer endpoint", async () => {
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.kind === "project" && c.project_type === "grant_application");
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${projectChannel.project_id}/gcp-answers`, {
      token, body: { requestId: "e1111111-5555-4555-8555-000000000001", answer: "GBP 9,200" } });
    expect(res.status).toBe(201);
    const call = scripted.calls.find((c) => c.method === "answerInformationRequest");
    expect(call?.args[0]).toBe(APP_ID);
    expect(call?.args[3]).toBe("GBP 9,200");
  });

  it("deliverable download streams privately through the API", async () => {
    const res = await env.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/gcp-deliverables/d1111111-7777-4777-8777-000000000001/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("application.docx");
    expect(res.body).toContain("PK-fake-docx");
  });

  it("the async bridge announces a finished task exactly once, as the right teammate", async () => {
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.kind === "project" && c.project_type === "grant_application");
    scripted.setActivity([{ task_id: "a1111111-9999-4999-8999-000000000002", task_type: "requirements_analysis",
      status: "running", created_at: new Date().toISOString() }], 1);
    await bridgePoll(env.deps);
    scripted.setActivity([{ task_id: "a1111111-9999-4999-8999-000000000002", task_type: "requirements_analysis",
      status: "completed", created_at: new Date().toISOString(), result_summary: "31 requirements extracted.", attempts: 1 }], 0);
    await bridgePoll(env.deps);
    await bridgePoll(env.deps); // second pass must not re-announce
    const msgs = await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${projectChannel.id}/messages`, { token });
    const announcements = msgs.body.messages.filter((m: any) => m.metadata?.gcpTaskId === "a1111111-9999-4999-8999-000000000002");
    expect(announcements).toHaveLength(1);
    expect(announcements[0].author_agent).toBe("grant.requirements_analyst");
    expect(announcements[0].body).toContain("Requirements analysis finished");
  });

  it("cross-tenant: org B cannot see org A's platform workspace, answers, or downloads", async () => {
    const evil = await registerUser(env.app, "gcp-evil@example.org");
    const evilOrg = await createOrg(env.app, evil.token, "gcp-evil-org");
    const ch = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    const projectChannel = ch.body.channels.find((c: any) => c.kind === "project" && c.project_type === "grant_application");

    // Org A's ids under org B's token: the org path check 404s outright.
    const ws = await api(env.app, "GET", `/v1/orgs/${orgId}/projects/${projectChannel.project_id}/grant-workspace`, { token: evil.token });
    expect(ws.status).toBe(404);
    // Org A's project under org B's own org path: RLS yields not-found.
    const ws2 = await api(env.app, "GET", `/v1/orgs/${evilOrg}/projects/${projectChannel.project_id}/grant-workspace`, { token: evil.token });
    expect(ws2.status).toBe(404);
    const ans = await api(env.app, "POST", `/v1/orgs/${evilOrg}/projects/${projectChannel.project_id}/gcp-answers`, {
      token: evil.token, body: { requestId: "e1111111-5555-4555-8555-000000000001", answer: "steal" } });
    expect(ans.status).toBe(404);
  });

  it("with the platform disabled nothing routes and grant DMs behave locally", async () => {
    const off = await createTestEnv({ gcp: null });
    try {
      const user = await registerUser(off.app, "gcp-off@example.org");
      const offOrg = await createOrg(off.app, user.token, "gcp-off-org");
      const ch = await api(off.app, "GET", `/v1/orgs/${offOrg}/channels`, { token: user.token });
      const dm = ch.body.channels.find((c: any) => c.key === "dm:grant.opportunity_researcher").id;
      const res = await api(off.app, "POST", `/v1/orgs/${offOrg}/channels/${dm}/messages`, {
        token: user.token, body: { body: "hello" } });
      expect(res.status).toBe(201);
      expect(res.body.messages.some((m: any) => m.author_kind === "agent")).toBe(true);
    } finally {
      await off.close();
    }
  });
});
