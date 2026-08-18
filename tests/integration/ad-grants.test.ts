import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/**
 * The Ad Grants workflow's data-gathering stages, end to end over HTTP, with
 * browser automation off (AD_GRANTS_AUTOMATION unset in test env — see
 * setup-env.ts): check_ad_grants_facts → verify_eligibility →
 * techsoup_validation → connect_google_account, where it parks honestly
 * instead of simulating a Google connection.
 */

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("Ad Grants application — data-gathering stages", () => {
  let token: string;
  let orgId: string;
  let runId: string;

  it("starts a run and pauses to request the required facts", async () => {
    const user = await registerUser(env.app, "ad-grants-slug@example.org");
    token = user.token;
    orgId = await createOrg(env.app, token, "ad-grants-slug");

    const started = await api(env.app, "POST", `/v1/orgs/${orgId}/ad-grants/start`, { token });
    expect(started.status).toBe(201);
    runId = started.body.runId;

    await env.deps.engine.drain("test-worker");

    const status = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(status.status).toBe(200);
    expect(status.body.run.status).toBe("waiting_for_info");
    expect(status.body.waitingContext).toBe("ad_grants_facts");
    const keys = status.body.questions.map((q: any) => q.key);
    for (const expected of ["legal_name", "entity_type", "registration_status", "mission", "website_url", "ein"]) {
      expect(keys).toContain(expected);
    }
  });

  it("re-starting is idempotent — reuses the same run", async () => {
    const again = await api(env.app, "POST", `/v1/orgs/${orgId}/ad-grants/start`, { token });
    expect(again.status).toBe(201);
    expect(again.body.runId).toBe(runId);
  });

  it("proceeds to eligibility once facts are provided, and passes the pre-screen", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/runs/${runId}/provide-info`, {
      token,
      body: {
        facts: [
          { key: "legal_name", value: "Hopeful Futures Inc." },
          { key: "entity_type", value: "501(c)(3) public charity" },
          { key: "registration_status", value: "Registered and in good standing" },
          { key: "mission", value: "Mentoring and after-school programs for youth" },
          { key: "website_url", value: "https://hopefulfutures.example.org" },
          { key: "ein", value: "12-3456789" },
        ],
      },
    });
    expect(res.status).toBe(200);
    await env.deps.engine.drain("test-worker");

    const status = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(status.body.run.status).toBe("waiting_for_info");
    expect(status.body.waitingContext).toBe("techsoup");

    const eligibility = status.body.artifacts.find((a: any) => a.type === "ad_grants_eligibility");
    expect(eligibility).toBeTruthy();
  });

  it("parks at connect_google_account once TechSoup validation is on record", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/runs/${runId}/provide-info`, {
      token,
      body: { facts: [{ key: "techsoup_validation_token", value: "TS-VALIDATED-12345" }] },
    });
    expect(res.status).toBe(200);
    await env.deps.engine.drain("test-worker");

    const status = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(status.body.run.status).toBe("waiting_for_info");
    expect(status.body.run.current_step).toBe("connect_google_account");
    expect(status.body.waitingContext).toBe("google_connect");
    // Automation is off in tests — this must be an honest wait, not a guess.
    expect(status.body.googleSession.connected).toBe(false);
  });

  it("recorded a checklist timeline for every step reached", async () => {
    const status = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    const steps = status.body.events.map((e: any) => e.event_type);
    for (const expected of [
      "step:check_ad_grants_facts", "step:verify_eligibility",
      "step:techsoup_validation", "step:connect_google_account",
    ]) {
      expect(steps).toContain(expected);
    }
  });
});

describe("Ad Grants application — eligibility pre-screen rejects ineligible orgs", () => {
  it("completes as ineligible without ever reaching TechSoup or Google", async () => {
    const { token } = await registerUser(env.app, "ineligible-org@example.org");
    const orgId = await createOrg(env.app, token, "ineligible-org");
    const started = await api(env.app, "POST", `/v1/orgs/${orgId}/ad-grants/start`, { token });
    const runId = started.body.runId;
    await env.deps.engine.drain("test-worker");

    await api(env.app, "POST", `/v1/orgs/${orgId}/runs/${runId}/provide-info`, {
      token,
      body: {
        facts: [
          { key: "legal_name", value: "City Hall" },
          { key: "entity_type", value: "Government entity" },
          { key: "registration_status", value: "Registered" },
          { key: "mission", value: "Municipal services" },
          { key: "website_url", value: "https://example.gov" },
          { key: "ein", value: "00-0000000" },
        ],
      },
    });
    await env.deps.engine.drain("test-worker");

    const status = await api(env.app, "GET", `/v1/orgs/${orgId}/ad-grants/status`, { token });
    expect(status.body.run.status).toBe("completed");
    expect(status.body.run.result).toBe("ineligible");
    expect(status.body.run.eligibility_reasons).toBeTruthy();
  });
});
