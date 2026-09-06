import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createTestEnv, startSlice, type TestEnv } from "../helpers.js";

/** Phase 1 workspace endpoints: agent directory, org runs list, approvals list. */

let env: TestEnv;
let s: Awaited<ReturnType<typeof startSlice>>;

beforeAll(async () => {
  env = await createTestEnv();
  s = await startSlice(env, "workspace-org");
  await env.deps.engine.drain("test-worker");
});
afterAll(async () => {
  await env.close();
});

describe("workspace API", () => {
  it("lists the agent directory with roles and tool permissions", async () => {
    const res = await api(env.app, "GET", "/v1/agents", { token: s.token });
    expect(res.status).toBe(200);
    const keys = res.body.agents.map((a: any) => a.agent_key);
    expect(keys).toContain("grant.requirements_analyst");
    expect(keys).toContain("grant.writer");
    const writer = res.body.agents.find((a: any) => a.agent_key === "grant.writer");
    expect(writer.allowed_tools).toEqual(["fetch_org_facts"]);
    expect(writer.display_name).toContain("Sophia");
  });

  it("lists org runs with project names and waiting payloads", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs`, { token: s.token });
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBe(1);
    const run = res.body.runs[0];
    expect(run.project_name).toBe("CYD 2026 Application");
    expect(run.status).toBe("waiting_for_info");
    expect(run.waiting.payload).toContain("legal_name");
  });

  it("lists org approvals joined to projects", async () => {
    // Drive the run to the approval gate first.
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/runs/${s.runId}/provide-info`, {
      token: s.token,
      body: {
        facts: [
          { key: "legal_name", value: "Workspace Org" },
          { key: "entity_type", value: "501(c)(3)" },
          { key: "registration_status", value: "Registered" },
          { key: "annual_budget", value: "$300k" },
          { key: "mission", value: "Testing workspaces" },
        ],
      },
    });
    await env.deps.engine.drain("test-worker");

    const res = await api(env.app, "GET", `/v1/orgs/${s.orgId}/approvals`, { token: s.token });
    expect(res.status).toBe(200);
    expect(res.body.approvals.length).toBe(1);
    expect(res.body.approvals[0].status).toBe("pending");
    expect(res.body.approvals[0].project_name).toBe("CYD 2026 Application");
    // The chat message that raised it carries the approval's current status.
    const chans = await api(env.app, "GET", `/v1/orgs/${s.orgId}/channels`, { token: s.token });
    const projectChannel = chans.body.channels.find((c: { project_id: string | null }) => c.project_id === s.projectId);
    const msgs = await api(env.app, "GET", `/v1/orgs/${s.orgId}/channels/${projectChannel.id}/messages`, { token: s.token });
    const raised = msgs.body.messages.find((m: { metadata: { approvalId?: string } }) => m.metadata?.approvalId === res.body.approvals[0].id);
    expect(raised?.metadata.approvalStatus).toBe("pending");
    expect(res.body.approvals[0].run_id).toBe(s.runId);
  });

  it("keeps the new list endpoints tenant-scoped", async () => {
    const outsider = await api(env.app, "POST", "/v1/auth/register", {
      body: { email: "outsider@example.org", password: "outsider-pass-1", displayName: "O" },
    });
    for (const path of [`/v1/orgs/${s.orgId}/runs`, `/v1/orgs/${s.orgId}/approvals`]) {
      const res = await api(env.app, "GET", path, { token: outsider.body.token });
      expect(res.status).toBe(404);
    }
  });
});
