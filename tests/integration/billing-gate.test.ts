import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7, withContext } from "@deedwell/database";
import { creditTokens, saveStripeConfig } from "@deedwell/billing-domain";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Paid work needs a prepaid balance once billing is configured: every model
 *  call debits it, paid routes refuse with 402 when it is gone, runs park
 *  instead of burning more, and a platform admin can exempt an org. */
describe("Billing gate", () => {
  let env: TestEnv;
  let token: string;
  let orgId: string;
  let userId: string;
  let channelId: string;
  let adminToken: string;

  const balance = async () => (await api(env.app, "GET", `/v1/orgs/${orgId}/billing/balance`, { token })).body;
  const chat = (body: string) => api(env.app, "POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, { token, body: { body } });
  const credit = (tokens: number) => withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) => creditTokens(c, orgId, tokens, { reason: "test" }));

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "gate@example.org"));
    orgId = await createOrg(env.app, token, "gate-org");
    const channels = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    channelId = channels.body.channels[0].id;
    const admin = await registerUser(env.app, "staff@example.org");
    adminToken = admin.token;
    await env.adminPool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [admin.userId]);
  });
  afterAll(async () => { await env.close(); });

  it("is unmetered until Stripe is configured", async () => {
    expect(await balance()).toMatchObject({ configured: false, blocked: false, tokenBalance: 0 });
    expect((await chat("hello")).status).toBe(201);
    await saveStripeConfig(env.deps.appPool, { secretKey: "sk_test_x", webhookSecret: "whsec_x", setBy: userId });
    expect(await balance()).toMatchObject({ configured: true, exempt: false, blocked: true });
  });

  it("refuses paid work with a 402 the app can act on", async () => {
    const res = await chat("hello again");
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "payment_required", tokenBalance: expect.any(Number) });
    const content = await api(env.app, "POST", `/v1/orgs/${orgId}/content`, { token, body: { kind: "social", prompt: "Spring drive posts" } });
    expect(content.status).toBe(402);
    const search = await api(env.app, "POST", `/v1/orgs/${orgId}/grant-search`, { token, body: { query: "youth literacy" } });
    expect(search.status).toBe(402);
  });

  it("model usage debits the balance wherever it is recorded", async () => {
    // Chat with the mock model already recorded usage above, so work in deltas.
    const before = (await balance()).tokenBalance;
    await credit(1_000);
    expect((await balance()).tokenBalance).toBe(before + 1_000);
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      c.query(`INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',600,'{}')`, [uuidv7(), orgId])
    );
    expect((await balance()).tokenBalance).toBe(before + 400);
    // Non-model rows (step accounting) cost nothing.
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      c.query(`INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'steps',1,'{}')`, [uuidv7(), orgId])
    );
    expect((await balance()).tokenBalance).toBe(before + 400);
    // Spending is allowed while the balance is positive; the debit follows.
    await credit(5_000);
    expect((await chat("with credit")).status).toBe(201);
    expect((await balance()).tokenBalance).toBeLessThan(before + 5_400);
  });

  it("parks a running workflow when the org runs out, and resumes it on top-up", async () => {
    const projectId = uuidv7();
    const runId = uuidv7();
    await env.adminPool.query(`INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'P','grant_application',$3)`, [projectId, orgId, userId]);
    await env.adminPool.query(
      `INSERT INTO workflow_runs (id, tenant_id, project_id, definition, definition_version, status, current_step, state, step_budget, created_by)
       VALUES ($1,$2,$3,'grant-application-slice',1,'pending','parse_document','{}',10,$4)`,
      [runId, orgId, projectId, userId]
    );
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      c.query(`INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',5000,'{}')`, [uuidv7(), orgId])
    );
    expect((await balance()).blocked).toBe(true);
    expect(await env.deps.engine.runPendingOnce("gate-test")).toBe(true);
    let { rows } = await env.adminPool.query(`SELECT status, last_error FROM workflow_runs WHERE id = $1`, [runId]);
    expect(rows[0].status).toBe("waiting_payment");
    expect(rows[0].last_error).toContain("Out of tokens");

    await credit(10_000);
    ({ rows } = await env.adminPool.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]));
    expect(rows[0].status).toBe("pending");
    // Park it again so the exemption test below has something to wake.
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, (c) =>
      c.query(`INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',20000,'{}')`, [uuidv7(), orgId])
    );
    await env.deps.engine.runPendingOnce("gate-test");
    ({ rows } = await env.adminPool.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]));
    expect(rows[0].status).toBe("waiting_payment");
  });

  it("a platform admin can exempt an organization from payment", async () => {
    const denied = await api(env.app, "PATCH", `/v1/admin/organizations/${orgId}/billing`, { token, body: { exempt: true } });
    expect(denied.status).toBe(403);
    const ok = await api(env.app, "PATCH", `/v1/admin/organizations/${orgId}/billing`, { token: adminToken, body: { exempt: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.organization.billing_exempt).toBe(true);
    expect(await balance()).toMatchObject({ exempt: true, blocked: false });
    expect((await balance()).tokenBalance).toBeLessThan(0);
    expect((await chat("exempt now")).status).toBe(201);
    const { rows } = await env.adminPool.query(`SELECT status FROM workflow_runs WHERE tenant_id = $1`, [orgId]);
    expect(rows.every((r: any) => r.status !== "waiting_payment")).toBe(true);
    const list = await api(env.app, "GET", `/v1/admin/organizations`, { token: adminToken });
    expect(list.body.organizations.find((o: any) => o.id === orgId).billing_exempt).toBe(true);
    const off = await api(env.app, "PATCH", `/v1/admin/organizations/${orgId}/billing`, { token: adminToken, body: { exempt: false } });
    expect(off.status).toBe(200);
    expect((await chat("blocked again")).status).toBe(402);
  });
});
