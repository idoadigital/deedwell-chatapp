import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeps } from "../../apps/api/src/bootstrap.js";
import { api, createOrg, createTestEnv, registerUser, uploadDoc, type TestEnv } from "../helpers.js";
import { workspaceBridgeFlush } from "../../apps/api/src/workspace.js";

/**
 * Acceptance criteria (enhancement spec §12) that cut across workflows:
 *  - a broken website can never be marked successfully completed (14)
 *  - duplicate triggers never start duplicate runs (§7)
 *  - interrupted work resumes after an application restart (17)
 */

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const WEBSITE_FACTS = [
  { key: "legal_name", value: "Acceptance Org" },
  { key: "mission", value: "Testing that broken things stay honestly broken" },
  { key: "programs", value: "QA; Verification" },
  { key: "beneficiaries", value: "Users" },
  { key: "service_area", value: "Test County" },
  { key: "headquarters", value: "1 Test Way" },
];

async function setupWebsiteOrg(slug: string) {
  const { token } = await registerUser(env.app, `${slug}@example.org`);
  const orgId = await createOrg(env.app, token, slug);
  await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts: WEBSITE_FACTS } });
  const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
    token, body: { name: "Site", type: "website" },
  });
  return { token, orgId, projectId: project.body.projectId };
}

describe("acceptance: broken site cannot complete (criterion 14)", () => {
  it("blocking validation failures stop the run before the publish gate, honestly", async () => {
    const s = await setupWebsiteOrg("broken-site");
    const created = await api(env.app, "POST", `/v1/orgs/${s.orgId}/projects/${s.projectId}/website`, {
      token: s.token, body: { siteName: "Broken Site Org", slug: "broken-site" },
    });
    const runId = created.body.runId as string;
    await env.deps.engine.drain("acc-worker");

    // Approve the brief…
    const run1 = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    const brief = run1.body.approvals.find((a: any) => a.status === "pending");
    expect(brief.kind).toBe("website_brief");
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${brief.id}`, {
      token: s.token, body: { decision: "approved" },
    });

    // …then a fact disappears before content generation (simulates the gap
    // that produces real placeholder content).
    await env.adminPool.query(
      `DELETE FROM org_facts WHERE tenant_id = $1 AND fact_key IN ('mission','programs')`,
      [s.orgId]
    );
    await env.deps.engine.drain("acc-worker");
    await workspaceBridgeFlush();

    const run2 = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    // The run finished, but NOT as a publishable success: no publish approval
    // was ever created, and the state carries the named blocking failures.
    expect(run2.body.run.status).toBe("completed");
    expect(run2.body.approvals.some((a: any) => a.kind === "publish_site")).toBe(false);
    expect(run2.body.run.published).toBe(false);
    const { rows: stateRows } = await env.adminPool.query(
      "SELECT state->'blockingChecks' AS blocking FROM workflow_runs WHERE id = $1", [runId]
    );
    const blockingChecks = stateRows[0].blocking as string[];
    expect(blockingChecks.length).toBeGreaterThan(0);
    expect(blockingChecks.join(" ")).toContain("Placeholder");

    // The QA record exists as a versioned artifact with the blocking count.
    const report = run2.body.artifacts.find((a: any) => a.type === "website_test_report");
    expect(report).toBeTruthy();
    const detail = await api(env.app, "GET", `/v1/orgs/${s.orgId}/artifacts/${report.id}`, { token: s.token });
    const content = detail.body.versions.at(-1).content;
    expect(content.blocking).toBeGreaterThan(0);
    expect(content.checks.some((c: any) => c.severity === "blocking" && !c.pass)).toBe(true);

    // The site was never published.
    const site = await api(env.app, "GET", `/v1/orgs/${s.orgId}/sites/${created.body.siteId}`, { token: s.token });
    expect(site.body.site.status).not.toBe("published");
  });
});

describe("acceptance: duplicate triggers do not fork runs (§7)", () => {
  it("starting a second website run while one is active returns 409", async () => {
    const s = await setupWebsiteOrg("dup-site");
    const created = await api(env.app, "POST", `/v1/orgs/${s.orgId}/projects/${s.projectId}/website`, {
      token: s.token, body: { siteName: "Dup Site", slug: "dup-site" },
    });
    await env.deps.engine.drain("acc-worker"); // parks at brief approval
    const dup = await api(env.app, "POST", `/v1/orgs/${s.orgId}/sites/${created.body.siteId}/update`, {
      token: s.token, body: { instruction: "change the tagline to Something Else" },
    });
    expect(dup.status).toBe(409);
  });

  it("starting a second grant application on the same project returns 409", async () => {
    const { token } = await registerUser(env.app, "dupgrant@example.org");
    const orgId = await createOrg(env.app, token, "dup-grant");
    const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
      token, body: { name: "G", type: "grant_application" },
    });
    const projectId = project.body.projectId;
    const opp = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/opportunities`, {
      token, body: { title: "T", funder: "F", source: "manual" },
    });
    const fileId = await uploadDoc(env.app, token, orgId, projectId,
      "Grant announcement. Eligibility: nonprofit. Narrative: describe your program.");
    const first = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/grant-application`, {
      token, body: { opportunityId: opp.body.opportunityId, fileId },
    });
    expect(first.status).toBe(201);
    const second = await api(env.app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/grant-application`, {
      token, body: { opportunityId: opp.body.opportunityId, fileId },
    });
    expect(second.status).toBe(409);
  });
});

describe("acceptance: work survives an application restart (criterion 17)", () => {
  it("a waiting run persisted by one process resumes under a fresh one", async () => {
    const s = await setupWebsiteOrg("restart-org");
    // Remove a discovery fact so the run parks waiting_for_info.
    await env.adminPool.query(
      `DELETE FROM org_facts WHERE tenant_id = $1 AND fact_key = 'headquarters'`, [s.orgId]
    );
    const created = await api(env.app, "POST", `/v1/orgs/${s.orgId}/projects/${s.projectId}/website`, {
      token: s.token, body: { siteName: "Restart Org", slug: "restart-org" },
    });
    const runId = created.body.runId as string;
    await env.deps.engine.drain("acc-worker");
    const parked = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    expect(parked.body.run.status).toBe("waiting_for_info");

    // "Restart": an entirely new dependency graph over the same database —
    // nothing carried over in memory.
    const fresh = await createDeps({ backoffMs: () => 0 });
    try {
      await api(env.app, "POST", `/v1/orgs/${s.orgId}/runs/${runId}/provide-info`, {
        token: s.token, body: { facts: [{ key: "headquarters", value: "1 Test Way" }] },
      });
      await fresh.engine.drain("fresh-worker");
      const resumed = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
      // The fresh process carried the run forward to the next human gate.
      expect(resumed.body.run.status).toBe("waiting_approval");
      expect(resumed.body.approvals.some((a: any) => a.kind === "website_brief")).toBe(true);
    } finally {
      await fresh.appPool.end();
      await fresh.adminPool.end();
    }
  });
});
