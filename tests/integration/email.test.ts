import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepEmailOutbox, type OutboundEmail, type ResendSender, ResendError, unsubscribeToken, emailConfig } from "@deedwell/email";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";

/** Transactional email: events write outbox rows in the same transaction,
 *  the sweep renders and hands them to Resend, activity mail honours the
 *  per-person opt-out, and the password-reset flow round-trips a token. */
describe("Transactional email", () => {
  let env: TestEnv;
  let token: string;
  let userId: string;
  let orgId: string;
  const sent: OutboundEmail[] = [];
  const sender: ResendSender = { async send(e) { sent.push(e); return { id: `msg_${sent.length}` }; } };
  const outbox = (kind?: string) => env.adminPool.query(
    `SELECT * FROM email_outbox WHERE ($1::text IS NULL OR kind = $1) ORDER BY created_at`, [kind ?? null]
  ).then((r) => r.rows);

  beforeAll(async () => {
    process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    env = await createTestEnv();
    ({ token, userId } = await registerUser(env.app, "ada@example.org"));
    orgId = await createOrg(env.app, token, "riverbend");
  });
  afterAll(async () => { await env.close(); });

  it("queues welcome, workspace-created and ops alerts from signup", async () => {
    const welcome = await outbox("welcome");
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ to_email: "ada@example.org", user_id: userId, category: "account", status: "pending", tenant_id: null });
    const created = await outbox("workspace_created");
    expect(created[0]).toMatchObject({ tenant_id: orgId, to_email: "ada@example.org" });
    expect(created[0].payload).toMatchObject({ orgSlug: "riverbend" });
    const ops = await outbox("ops_alert");
    expect(ops.length).toBeGreaterThanOrEqual(2);
    expect(ops.every((r) => r.to_email === emailConfig().opsTo[0])).toBe(true);
  });

  it("emails a teammate who is added to the workspace", async () => {
    const other = await registerUser(env.app, "grace@example.org");
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/members`, { token, body: { email: "grace@example.org", role: "admin" } });
    expect(res.status).toBe(201);
    const rows = await outbox("added_to_workspace");
    expect(rows[0]).toMatchObject({ to_email: "grace@example.org", user_id: other.userId, tenant_id: orgId });
    expect(rows[0].payload).toMatchObject({ role: "admin", addedBy: "ada" });
  });

  it("confirms support requests to the sender and alerts ops; replies go to the whole team", async () => {
    const res = await api(env.app, "POST", `/v1/orgs/${orgId}/support/messages`, { token, body: { body: "Logo upload fails" } });
    expect(res.status).toBe(201);
    expect((await outbox("support_received"))[0]).toMatchObject({ to_email: "ada@example.org", tenant_id: orgId });
    const staff = await registerUser(env.app, "staff@example.org");
    await env.adminPool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [staff.userId]);
    const reply = await api(env.app, "POST", `/v1/admin/support/orgs/${orgId}/messages`, { token: staff.token, body: { body: "Fixed it — try again." } });
    expect(reply.status).toBe(201);
    const replies = await outbox("support_reply");
    expect(replies.map((r) => r.to_email).sort()).toEqual(["ada@example.org", "grace@example.org"]);
    expect(replies[0].payload).toMatchObject({ body: "Fixed it — try again." });
  });

  it("delivers pending rows through Resend with the branded layout", async () => {
    const result = await sweepEmailOutbox(env.adminPool, { sender, limit: 100 });
    expect(result.sent).toBeGreaterThanOrEqual(6);
    expect(result.failed).toBe(0);
    const welcome = sent.find((e) => e.subject === "Welcome to Deedwell")!;
    expect(welcome.to).toEqual(["ada@example.org"]);
    expect(welcome.from).toContain("deedwell.org");
    expect(welcome.html).toContain("logo-black.png");
    expect(welcome.html).toContain("Welcome aboard, ada.");
    expect(welcome.text).toContain("Open your dashboard");
    const pending = await env.adminPool.query(`SELECT count(*)::int AS n FROM email_outbox WHERE status = 'pending'`);
    expect(pending.rows[0].n).toBe(0);
    const row = (await outbox("welcome"))[0];
    expect(row).toMatchObject({ status: "sent", attempt_count: 1 });
    expect(row.provider_message_id).toMatch(/^msg_/);
  });

  it("skips activity mail for people who opted out, via the signed unsubscribe link", async () => {
    const cfg = emailConfig();
    const bad = await env.app.inject({ method: "GET", url: `/v1/email/unsubscribe?u=${userId}&t=nope` });
    expect(bad.statusCode).toBe(400);
    const good = await env.app.inject({ method: "GET", url: `/v1/email/unsubscribe?u=${userId}&t=${unsubscribeToken(userId, cfg.unsubscribeSecret)}` });
    expect(good.statusCode).toBe(200);
    expect(good.body).toContain("unsubscribed");
    const prefs = await api(env.app, "GET", "/v1/me/email-preferences", { token });
    expect(prefs.body).toEqual({ activityEmails: false });

    await env.adminPool.query(
      `INSERT INTO email_outbox (id, tenant_id, user_id, to_email, kind, category, payload)
       VALUES (gen_random_uuid(), $1, $2, 'ada@example.org', 'unread_digest', 'activity', '{"orgName":"R","displayName":"Ada","total":1,"channels":[{"name":"Maya","count":1}]}'),
              (gen_random_uuid(), $1, $2, 'ada@example.org', 'topup_receipt', 'billing', '{"orgName":"R","packageName":"Starter","tokens":1000000,"amountCents":1000,"currency":"usd","transactionId":"t1","resumedRuns":0}')`,
      [orgId, userId]
    );
    const before = sent.length;
    const r = await sweepEmailOutbox(env.adminPool, { sender, limit: 100 });
    expect(r).toMatchObject({ sent: 1, skipped: 1 });
    expect(sent[before]!.subject).toContain("Receipt");
    expect((await outbox("unread_digest"))[0]).toMatchObject({ status: "skipped" });

    await api(env.app, "PATCH", "/v1/me/email-preferences", { token, body: { activityEmails: true } });
    expect((await api(env.app, "GET", "/v1/me/email-preferences", { token })).body).toEqual({ activityEmails: true });
  });

  it("retries transient provider errors and gives up on permanent ones", async () => {
    await env.adminPool.query(
      `INSERT INTO email_outbox (id, user_id, to_email, kind, category, payload) VALUES
        (gen_random_uuid(), $1, 'ada@example.org', 'welcome', 'account', '{"displayName":"Ada"}'),
        (gen_random_uuid(), $1, 'bad@example.org', 'welcome', 'account', '{"displayName":"Bad"}')`, [userId]
    );
    const flaky: ResendSender = { async send(e) {
      if (e.to[0] === "bad@example.org") throw new ResendError("Resend 422: validation_error — invalid to", 422, true);
      throw new ResendError("Resend 429: rate limited", 429, false);
    } };
    const r = await sweepEmailOutbox(env.adminPool, { sender: flaky, limit: 100 });
    expect(r).toMatchObject({ failed: 1, retried: 1 });
    const rows = await env.adminPool.query(`SELECT to_email, status, next_attempt_at > now() AS deferred FROM email_outbox WHERE last_error LIKE 'Resend 4%' ORDER BY to_email`);
    expect(rows.rows).toEqual([
      { to_email: "ada@example.org", status: "pending", deferred: true },
      { to_email: "bad@example.org", status: "failed", deferred: false },
    ]);
  });

  it("dedupes by key", async () => {
    const { enqueueEmail } = await import("@deedwell/email");
    const a = await enqueueEmail(env.adminPool, { kind: "low_balance", to: "ada@example.org", payload: { orgName: "R", tokenBalance: 5 }, tenantId: orgId, dedupeKey: "low_balance:test" });
    const b = await enqueueEmail(env.adminPool, { kind: "low_balance", to: "ada@example.org", payload: { orgName: "R", tokenBalance: 5 }, tenantId: orgId, dedupeKey: "low_balance:test" });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("resets a forgotten password through an emailed single-use link", async () => {
    const unknown = await api(env.app, "POST", "/v1/auth/forgot-password", { body: { email: "nobody@example.org" } });
    expect(unknown.status).toBe(200); // never reveals whether an account exists
    expect(await outbox("password_reset")).toHaveLength(0);

    const res = await api(env.app, "POST", "/v1/auth/forgot-password", { body: { email: "ada@example.org" } });
    expect(res.status).toBe(200);
    const [row] = await outbox("password_reset");
    expect(row.to_email).toBe("ada@example.org");
    const resetUrl: string = row.payload.resetUrl;
    expect(resetUrl).toMatch(/^https:\/\/deedwell\.org\/reset-password\?token=/);
    const tok = decodeURIComponent(resetUrl.split("token=")[1]!);

    const weak = await api(env.app, "POST", "/v1/auth/reset-password", { body: { token: tok, password: "short" } });
    expect(weak.status).toBe(400);
    const ok = await api(env.app, "POST", "/v1/auth/reset-password", { body: { token: tok, password: "new-horse-battery-staple" } });
    expect(ok.status).toBe(200);
    expect(ok.body.userId).toBe(userId);
    const again = await api(env.app, "POST", "/v1/auth/reset-password", { body: { token: tok, password: "another-new-password" } });
    expect(again.status).toBe(400); // single use

    const oldLogin = await api(env.app, "POST", "/v1/auth/login", { body: { email: "ada@example.org", password: "correct-horse-battery" } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api(env.app, "POST", "/v1/auth/login", { body: { email: "ada@example.org", password: "new-horse-battery-staple" } });
    expect(newLogin.status).toBe(200);
    // The old session was revoked by the reset.
    expect((await api(env.app, "GET", "/v1/me", { token })).status).toBe(401);
    expect((await outbox("password_changed"))[0]).toMatchObject({ to_email: "ada@example.org" });
    expect((await outbox("password_changed"))[0].payload).toMatchObject({ sessionsRevoked: true });
  });
});
