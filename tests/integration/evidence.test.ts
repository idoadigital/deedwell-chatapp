import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, uploadDoc, type TestEnv } from "../helpers.js";

/**
 * Evidence provenance: facts extracted from a real document cite where they
 * came from and land as "verified", not "user_certified" — and when a second
 * document disagrees with an already-verified fact, the disagreement is
 * recorded for a human to resolve instead of silently overwritten.
 */

let env: TestEnv;
let token: string;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  env = await createTestEnv();
  ({ token } = await registerUser(env.app, "evidence@example.com"));
  orgId = await createOrg(env.app, token, "evidence-org");
  const res = await api(env.app, "POST", `/v1/orgs/${orgId}/projects`, {
    token, body: { name: "Evidence Project", type: "grant_application" },
  });
  projectId = res.body.projectId;
});
afterAll(async () => {
  await env.close();
});

const ANNUAL_REPORT = `2025 Annual Report
Beneficiaries Served: 36,000
Program Region: Central Valley
`;

const IMPACT_REPORT = `2025 Impact Report
Beneficiaries Served: 41,200
Program Region: Central Valley
`;

describe("evidence extraction: provenance", () => {
  it("extracted facts are written as verified, citing their source document and quote", async () => {
    const fileId = await uploadDoc(env.app, token, orgId, projectId, ANNUAL_REPORT);
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/files/${fileId}/extract-facts`, { token });
    expect(res.status).toBe(201);
    expect(res.body.written).toContain("beneficiaries_served");
    expect(res.body.conflicts).toEqual([]);

    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    const beneficiaries = facts.body.facts.find((f: any) => f.fact_key === "beneficiaries_served");
    expect(beneficiaries.status).toBe("verified");
    expect(beneficiaries.value).toBe("36,000");
  });

  it("a manually-typed fact is recorded as user_certified, never verified", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/facts`, {
      token, body: { facts: [{ key: "legal_name", value: "Hopeful Futures Inc." }] },
    });
    expect(res.status).toBe(201);
    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    const legalName = facts.body.facts.find((f: any) => f.fact_key === "legal_name");
    expect(legalName.status).toBe("user_certified");
  });
});

describe("evidence extraction: conflict handling", () => {
  it("a second document disagreeing with an already-verified fact is flagged, not silently overwritten", async () => {
    const fileId = await uploadDoc(env.app, token, orgId, projectId, IMPACT_REPORT);
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/files/${fileId}/extract-facts`, { token });
    expect(res.status).toBe(201);
    expect(res.body.conflicts).toContain("beneficiaries_served");
    // "program_region" agrees across both documents, so it's written cleanly.
    expect(res.body.written).toContain("program_region");

    // The original value must still stand — nothing overwrote it silently.
    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    const beneficiaries = facts.body.facts.find((f: any) => f.fact_key === "beneficiaries_served");
    expect(beneficiaries.value).toBe("36,000");
  });

  it("the conflict is listed for a human to resolve", async () => {
    const res = await api(env.app, "GET", `/v1/orgs/${orgId}/fact-conflicts`, { token });
    expect(res.status).toBe(200);
    const conflict = res.body.conflicts.find((c: any) => c.fact_key === "beneficiaries_served");
    expect(conflict).toBeTruthy();
    expect(conflict.current_value).toBe("36,000");
    expect(conflict.proposed_value).toBe("41,200");
  });

  it("resolving in favor of the new document updates the fact and closes the conflict", async () => {
    const list = await api(env.app, "GET", `/v1/orgs/${orgId}/fact-conflicts`, { token });
    const conflict = list.body.conflicts.find((c: any) => c.fact_key === "beneficiaries_served");

    const resolve = await api(env.app, "POST", `/v1/orgs/${orgId}/fact-conflicts/${conflict.id}/resolve`, {
      token, body: { resolution: "use_proposed" },
    });
    expect(resolve.status).toBe(200);

    const facts = await api(env.app, "GET", `/v1/orgs/${orgId}/facts`, { token });
    const beneficiaries = facts.body.facts.find((f: any) => f.fact_key === "beneficiaries_served");
    expect(beneficiaries.value).toBe("41,200");

    const listAfter = await api(env.app, "GET", `/v1/orgs/${orgId}/fact-conflicts`, { token });
    expect(listAfter.body.conflicts.find((c: any) => c.fact_key === "beneficiaries_served")).toBeUndefined();
  });
});
