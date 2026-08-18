import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createTestEnv, registerUser, createOrg, uploadDoc, SAMPLE_GRANT_DOC, type TestEnv } from "../helpers.js";

/**
 * Phase 3: the complete grant application workflow end-to-end —
 * intake → eligibility → bid/no-bid gate → plan → multi-section drafting →
 * budget → logic model → reviewer panel → compliance → final gate → export —
 * plus discovery, passport, and outcome tracking.
 */

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const PASSPORT_FACTS = [
  { key: "legal_name", value: "Hopeful Futures Inc." },
  { key: "entity_type", value: "501(c)(3) public charity" },
  { key: "mission", value: "Mentoring and after-school programs for youth" },
  { key: "registration_status", value: "Registered in Ohio since 2015" },
  { key: "headquarters", value: "Columbus, Ohio" },
  { key: "service_area", value: "Franklin County, Ohio" },
  { key: "annual_budget", value: "$420,000" },
  { key: "programs", value: "Youth mentoring; after-school tutoring" },
  { key: "beneficiaries", value: "Youth ages 10-18" },
];

async function setupOrgWithOpportunity(slug: string, facts = PASSPORT_FACTS) {
  const { app } = env;
  const { userId, token } = await registerUser(app, `${slug}@example.org`);
  const orgId = await createOrg(app, token, slug);
  if (facts.length) {
    await api(app, "POST", `/v1/orgs/${orgId}/facts`, { token, body: { facts } });
  }
  const project = await api(app, "POST", `/v1/orgs/${orgId}/projects`, {
    token, body: { name: "CYD 2026", type: "grant_application" },
  });
  const projectId = project.body.projectId;
  const opp = await api(app, "POST", `/v1/orgs/${orgId}/projects/${projectId}/opportunities`, {
    token,
    body: {
      title: "Community Youth Development Grant",
      funder: "Example Community Foundation",
      opportunityNumber: "CYD-2026-014",
      deadline: "2026-09-30",
      fundingMax: 150000,
      source: "manual",
    },
  });
  const fileId = await uploadDoc(app, token, orgId, projectId, SAMPLE_GRANT_DOC);
  return { userId, token, orgId, projectId, opportunityId: opp.body.opportunityId, fileId };
}

async function startFull(s: Awaited<ReturnType<typeof setupOrgWithOpportunity>>) {
  const started = await api(env.app, "POST",
    `/v1/orgs/${s.orgId}/projects/${s.projectId}/grant-application`,
    { token: s.token, body: { opportunityId: s.opportunityId, fileId: s.fileId } });
  expect(started.status).toBe(201);
  return started.body.runId as string;
}

async function pendingApproval(orgId: string, token: string, runId: string) {
  const run = await api(env.app, "GET", `/v1/orgs/${orgId}/runs/${runId}`, { token });
  return { run, approval: run.body.approvals.find((a: any) => a.status === "pending") };
}

describe("full grant workflow — happy path", () => {
  let s: Awaited<ReturnType<typeof setupOrgWithOpportunity>>;
  let runId: string;

  it("runs to the bid/no-bid gate with an apply recommendation", async () => {
    s = await setupOrgWithOpportunity("full-happy");
    runId = await startFull(s);
    await env.deps.engine.drain("test-worker");

    const { run, approval } = await pendingApproval(s.orgId, s.token, runId);
    expect(run.body.run.status).toBe("waiting_approval");
    expect(approval.kind).toBe("bid_decision");
    expect(approval.payload.recommendation).toBe("apply");
    expect(approval.payload.total).toBeGreaterThanOrEqual(65);

    const detail = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/opportunities/${s.opportunityId}`, { token: s.token });
    expect(detail.body.eligibility.overall).toBe("likely_eligible");
    expect(detail.body.bid.recommendation).toBe("apply");
  });

  it("after bid approval: plans sections, drafts each, builds budget, logic model, review, compliance", async () => {
    const { approval } = await pendingApproval(s.orgId, s.token, runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${approval.id}`, {
      token: s.token, body: { decision: "approved", note: "Pursue it." },
    });
    await env.deps.engine.drain("test-worker");

    // Strategy checkpoint: the plan is reviewed before any drafting starts.
    const { run: planRun, approval: strategyApproval } = await pendingApproval(s.orgId, s.token, runId);
    expect(planRun.body.run.status).toBe("waiting_approval");
    expect(strategyApproval.kind).toBe("strategy");
    expect(strategyApproval.payload.sections.length).toBeGreaterThanOrEqual(2);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${strategyApproval.id}`, {
      token: s.token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");

    const { run, approval: finalApproval } = await pendingApproval(s.orgId, s.token, runId);
    expect(run.body.run.status).toBe("waiting_approval");
    expect(finalApproval.kind).toBe("final_export");
    expect(finalApproval.payload.reviewScore).toMatch(/^\d+\/\d+$/);

    const types = run.body.artifacts.map((a: any) => a.type);
    for (const expected of [
      "compliance_matrix", "application_plan", "grant_section", "budget",
      "logic_model", "review_report", "compliance_report",
    ]) {
      expect(types).toContain(expected);
    }
    // Multiple sections → multiple grant_section artifacts.
    expect(types.filter((t: string) => t === "grant_section").length).toBeGreaterThanOrEqual(2);

    const { rows: sections } = await env.adminPool.query(
      `SELECT s.title, s.status, s.artifact_id FROM application_sections s WHERE s.tenant_id = $1 ORDER BY s.order_idx`,
      [s.orgId]
    );
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.every((r) => r.status === "drafted" && r.artifact_id)).toBe(true);

    const { rows: items } = await env.adminPool.query(
      "SELECT COUNT(*)::int AS n FROM budget_items WHERE tenant_id = $1", [s.orgId]
    );
    expect(items[0].n).toBeGreaterThan(4);

    const { rows: scores } = await env.adminPool.query(
      "SELECT reviewer FROM review_scores WHERE tenant_id = $1", [s.orgId]
    );
    expect(new Set(scores.map((r) => r.reviewer))).toEqual(
      new Set(["program", "financial", "compliance", "skeptic"])
    );
  });

  it("final approval exports the full package with budget CSV", async () => {
    const { approval } = await pendingApproval(s.orgId, s.token, runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${approval.id}`, {
      token: s.token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");

    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    expect(run.body.run.status).toBe("completed");

    const exportArtifact = run.body.artifacts.find((a: any) => a.type === "export_package");
    const artifact = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/artifacts/${exportArtifact.id}`, { token: s.token });
    const content = artifact.body.versions.at(-1).content;
    expect(content.markdown).toContain("does not and cannot guarantee a grant award");
    expect(content.markdown).toContain("## Bid decision");
    expect(content.markdown).toContain("## Budget");
    expect(content.markdown).toContain("## Logic model");
    expect(content.markdown).toContain("## Internal review panel");
    expect(content.markdown).toContain("## Final compliance checklist");
    expect(content.budgetCsv).toContain("category,description,activity");

    const detail = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/opportunities/${s.opportunityId}`, { token: s.token });
    expect(detail.body.opportunity.status).toBe("ready");
    expect(detail.body.application.status).toBe("ready");
  });

  it("records the outcome and closes the loop", async () => {
    const detail = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/opportunities/${s.opportunityId}`, { token: s.token });
    const res = await api(env.app, "POST",
      `/v1/orgs/${s.orgId}/applications/${detail.body.application.id}/outcome`,
      { token: s.token, body: { status: "awarded", awardAmount: 120000, lessons: "Strong need statement." } });
    expect(res.status).toBe(201);

    const apps = await api(env.app, "GET", `/v1/orgs/${s.orgId}/applications`, { token: s.token });
    expect(apps.body.applications[0].outcome).toBe("awarded");
    expect(Number(apps.body.applications[0].award_amount)).toBe(120000);
  });
});

describe("full grant workflow — gates and weak cases", () => {
  it("declining the bid marks the opportunity not_pursued and stops cleanly", async () => {
    const s = await setupOrgWithOpportunity("full-decline");
    const runId = await startFull(s);
    await env.deps.engine.drain("test-worker");

    const { approval } = await pendingApproval(s.orgId, s.token, runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${approval.id}`, {
      token: s.token, body: { decision: "rejected", note: "Not strategic this cycle." },
    });
    await env.deps.engine.drain("test-worker");

    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    expect(run.body.run.status).toBe("completed");

    const detail = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/opportunities/${s.opportunityId}`, { token: s.token });
    expect(detail.body.opportunity.status).toBe("not_pursued");
    expect(detail.body.application).toBeNull();
    expect(detail.body.bid.decision).toBe("decline");
  });

  it("with no organizational facts, eligibility pauses and requests them — never assumes", async () => {
    const s = await setupOrgWithOpportunity("full-nofacts", []);
    const runId = await startFull(s);
    await env.deps.engine.drain("test-worker");

    const run = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${runId}`, { token: s.token });
    expect(run.body.run.status).toBe("waiting_for_info");
    expect(run.body.run.waiting.payload).toContain("entity_type");

    const detail = await api(env.app, "GET",
      `/v1/orgs/${s.orgId}/opportunities/${s.opportunityId}`, { token: s.token });
    expect(detail.body.eligibility.overall).toBe("insufficient_information");

    // Providing the facts resumes through eligibility to the bid gate.
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/runs/${runId}/provide-info`, {
      token: s.token,
      body: { facts: [
        { key: "entity_type", value: "501(c)(3) public charity" },
        { key: "registration_status", value: "Registered" },
      ] },
    });
    await env.deps.engine.drain("test-worker");
    const after = await pendingApproval(s.orgId, s.token, runId);
    expect(after.run.body.run.status).toBe("waiting_approval");
    expect(after.approval.kind).toBe("bid_decision");
  });

  it("rejecting the strategy sends the plan back for revision with feedback, not straight to drafting", async () => {
    const s = await setupOrgWithOpportunity("full-strategy-reject");
    const runId = await startFull(s);
    await env.deps.engine.drain("test-worker");

    const { approval: bidApproval } = await pendingApproval(s.orgId, s.token, runId);
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${bidApproval.id}`, {
      token: s.token, body: { decision: "approved" },
    });
    await env.deps.engine.drain("test-worker");

    const { approval: strategyApproval } = await pendingApproval(s.orgId, s.token, runId);
    expect(strategyApproval.kind).toBe("strategy");
    await api(env.app, "POST", `/v1/orgs/${s.orgId}/approvals/${strategyApproval.id}`, {
      token: s.token, body: { decision: "rejected", note: "Focus more on sustainability, less on Africa." },
    });
    await env.deps.engine.drain("test-worker");

    // A fresh strategy approval is created — not sections drafted without review.
    const { run, approval: secondStrategy } = await pendingApproval(s.orgId, s.token, runId);
    expect(run.body.run.status).toBe("waiting_approval");
    expect(secondStrategy.kind).toBe("strategy");
    expect(secondStrategy.id).not.toBe(strategyApproval.id);

    const { rows: sections } = await env.adminPool.query(
      `SELECT status FROM application_sections WHERE tenant_id = $1`, [s.orgId]
    );
    expect(sections.every((r) => r.status === "planned")).toBe(true);
  });
});

describe("discovery and passport", () => {
  it("searches the (mock) grant source and imports a result as an opportunity", async () => {
    const { token } = await registerUser(env.app, "discover@example.org");
    const orgId = await createOrg(env.app, token, "discover-org");
    const project = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
      token, body: { name: "Discovery", type: "grant_application" },
    });

    const search = await api(env.app, "POST", `/v1/orgs/${orgId}/grant-search`, {
      token, body: { keyword: "youth development" },
    });
    expect(search.status).toBe(200);
    expect(search.body.source).toBe("mock");
    expect(search.body.results.length).toBeGreaterThan(0);
    const hit = search.body.results[0];
    expect(hit.title).toContain("[mock source]");

    const imported = await api(env.app, "POST",
      `/v1/orgs/${orgId}/projects/${project.body.projectId}/opportunities`,
      { token, body: {
        title: hit.title, funder: hit.agency, opportunityNumber: hit.opportunityNumber,
        deadline: hit.closeDate, sourceUrl: hit.sourceUrl, source: "grants_gov",
      } });
    expect(imported.status).toBe(201);

    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/opportunities`, { token });
    expect(list.body.opportunities).toHaveLength(1);
    expect(list.body.opportunities[0].source).toBe("grants_gov");
  });

  it("reports passport completeness and missing required fields", async () => {
    const { token } = await registerUser(env.app, "passport@example.org");
    const orgId = await createOrg(env.app, token, "passport-org");
    let passport = await api(env.app, "GET", `/v1/orgs/${orgId}/passport`, { token });
    expect(passport.body.completeness).toBe(0);
    expect(passport.body.requiredMissing).toContain("legal_name");

    await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
      token, body: { facts: PASSPORT_FACTS },
    });
    passport = await api(env.app, "GET", `/v1/orgs/${orgId}/passport`, { token });
    expect(passport.body.completeness).toBeGreaterThanOrEqual(80);
    expect(passport.body.requiredMissing).toEqual([]);
  });
});
