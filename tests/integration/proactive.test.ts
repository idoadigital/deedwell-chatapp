import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeFlush } from "../../apps/api/src/assistant.js";
import { workspaceBridgeFlush } from "../../apps/api/src/workspace.js";
import { proactiveFlush, proposeProactiveMessage } from "../../apps/api/src/proactive/candidates.js";
import { runProactiveTick } from "../../apps/api/src/proactive/orchestrator.js";
import { scoreCandidate, ProactivePolicy } from "../../apps/api/src/proactive/policy.js";
import { api, createOrg, createTestEnv, registerUser, startSlice, type TestEnv } from "../helpers.js";

/** Proactive messaging, scenario by scenario. Time is injected into the
 *  orchestrator (`runProactiveTick(deps, now)`); a fixed 14:00 UTC keeps
 *  the default quiet hours out of the way unless a test wants them. */
const T0 = new Date("2026-09-10T14:00:00Z");
const hours = (h: number, from = T0) => new Date(from.getTime() + h * 3600_000);

describe("Proactive agent messaging", () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(async () => { await env.close(); });

  const drainAll = async () => {
    for (let i = 0; i < 40; i++) {
      await env.deps.engine.drain("test-worker");
      await bridgeFlush(); await workspaceBridgeFlush(); await proactiveFlush();
      const { rows } = await env.adminPool.query(`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE status IN ('pending','running')`);
      if (rows[0].n === 0) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const candidates = (orgId: string) => env.adminPool.query("SELECT * FROM proactive_candidates WHERE tenant_id = $1 ORDER BY created_at", [orgId]).then((r) => r.rows);
  const proactiveMessages = (orgId: string) => env.adminPool.query("SELECT * FROM messages WHERE tenant_id = $1 AND metadata->>'proactive' = 'true' ORDER BY created_at", [orgId]).then((r) => r.rows);
  const generalChannel = async (orgId: string, token: string) => {
    const r = await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token });
    return r.body.channels.find((c: { key: string }) => c.key === "general").id as string;
  };
  const fresh = async (slug: string) => {
    const { token, userId } = await registerUser(env.app, `${slug}@example.org`);
    const orgId = await createOrg(env.app, token, slug);
    const channelId = await generalChannel(orgId, token);
    return { token, userId, orgId, channelId };
  };

  it("scenario 1: a run waiting on the user becomes a goal, an intent and a follow-up that is sent later — not immediately", async () => {
    const s = await startSlice(env, "proactive-1");
    await drainAll();
    const run = (await env.adminPool.query("SELECT status FROM workflow_runs WHERE id = $1", [s.runId])).rows[0];
    expect(run.status).toBe("waiting_for_info");
    const goals = (await env.adminPool.query("SELECT * FROM user_goals WHERE tenant_id = $1", [s.orgId])).rows;
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Apply for CYD 2026 Application");
    expect(goals[0].status).toBe("blocked");
    const intents = (await env.adminPool.query("SELECT * FROM user_intents WHERE tenant_id = $1", [s.orgId])).rows;
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe("waiting_on_user");
    expect(intents[0].next_expected_actor).toBe("user");
    expect(intents[0].next_expected_action).toMatch(/provide/);
    let rows = await candidates(s.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("waiting_on_user");
    expect(rows[0].status).toBe("candidate");
    // Not due yet: nothing happens now.
    await runProactiveTick(env.deps, new Date());
    expect((await proactiveMessages(s.orgId))).toHaveLength(0);
    // Due (default 20 h later), still waiting, user away: sent as the same agent, in the project channel.
    const stats = await runProactiveTick(env.deps, hours(21, new Date()));
    expect(stats.delivered).toBe(1);
    const sent = await proactiveMessages(s.orgId);
    expect(sent).toHaveLength(1);
    expect(sent[0].author_kind).toBe("agent");
    expect(sent[0].metadata.messageOrigin).toBe("proactive_agent");
    expect(sent[0].metadata.intentId).toBe(intents[0].id);
    expect(sent[0].body).not.toMatch(/^Reminder/);
    rows = await candidates(s.orgId);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].notified).toBe(true); // user was offline
    const log = (await env.adminPool.query("SELECT event FROM proactive_log WHERE candidate_id = $1 ORDER BY created_at", [rows[0].id])).rows.map((r) => r.event);
    expect(log).toEqual(["candidate_created", "delivered"]);
  });

  it("scenario 2 + 9: the user acts before the follow-up is due, so it is cancelled — and a completed goal cancels the rest", async () => {
    const s = await startSlice(env, "proactive-2");
    await drainAll();
    const before = await candidates(s.orgId);
    expect(before[0].status).toBe("candidate");
    const status = await api(env.app, "GET", `/v1/orgs/${s.orgId}/runs/${s.runId}`, { token: s.token });
    const missing: string[] = (status.body.infoRequest?.fields ?? []).map((f: { key: string }) => f.key);
    expect(missing.length).toBeGreaterThan(0);
    const r = await api(env.app, "POST", `/v1/orgs/${s.orgId}/runs/${s.runId}/provide-info`, {
      token: s.token, body: { facts: missing.map((key) => ({ key, value: key === "ein" ? "12-3456789" : `Answer for ${key}` })) },
    });
    expect(r.status).toBe(200);
    await drainAll();
    const after = await candidates(s.orgId);
    const followUp = after.find((c) => c.id === before[0].id);
    expect(followUp.status).toBe("cancelled");
    expect(followUp.decision.cancelledReason).toMatch(/resumed|completed|stopped/);
    // A later tick must not resurrect it.
    await runProactiveTick(env.deps, hours(30, new Date()));
    expect((await proactiveMessages(s.orgId)).filter((m) => m.metadata.candidateId === before[0].id)).toHaveLength(0);
    // Scenario 9: a goal marked completed cancels any follow-up still queued against it.
    const goal = (await env.adminPool.query("SELECT id, subject_key FROM user_goals WHERE tenant_id = $1 LIMIT 1", [s.orgId])).rows[0];
    await proposeProactiveMessage(env.deps, s.orgId, {
      userId: s.userId, agentKey: "grant.writer", goalId: goal.id, type: "check_in", reason: "It has been a while", subjectKey: `goal:${goal.id}:checkin`,
      importance: 3, urgency: 2, requiresResponse: true, relatedEntity: {}, metadata: {},
    });
    await env.adminPool.query("UPDATE user_goals SET status = 'completed' WHERE id = $1", [goal.id]);
    const stats = await runProactiveTick(env.deps, hours(48, new Date()));
    expect(stats.cancelled).toBeGreaterThanOrEqual(1);
    const checkin = (await candidates(s.orgId)).find((c) => c.subject_key === `goal:${goal.id}:checkin`);
    expect(checkin.status).toBe("cancelled");
    expect(checkin.decision.cancelledReason).toMatch(/goal already completed/);
  });

  it("scenario 3: three agents want the user at once — one message goes out, the rest ride along or wait", async () => {
    const f = await fresh("proactive-3");
    const propose = (agentKey: string, type: string, subject: string, importance: number, urgency: number, message: string) =>
      proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey, channelId: f.channelId, type: type as never, reason: message, proposedMessage: message,
        subjectKey: subject, importance, urgency, requiresResponse: type !== "work_completed", relatedEntity: {}, metadata: {} });
    await propose("website.developer", "work_completed", "site:1:done", 5, 4, "Your website is ready to look at.");
    await propose("grant.eligibility_analyst", "waiting_on_user", "run:x:info", 4, 3, "Connect your Google account so I can continue the grant application.");
    await propose("content.designer", "waiting_on_user", "content:y:approve", 3, 2, "Yesterday's social post is still waiting for your approval.");
    const stats = await runProactiveTick(env.deps, T0);
    const sent = await proactiveMessages(f.orgId);
    expect(sent).toHaveLength(1);
    expect(sent[0].author_agent).toBe("website.developer");
    expect(stats.delivered).toBe(1);
    const rows = await candidates(f.orgId);
    const others = rows.filter((c) => c.agent_key !== "website.developer");
    // Each other agent's item was either folded into the one message or deferred — never a second message now.
    for (const c of others) expect(["delivered", "scheduled"]).toContain(c.status);
    const combined = others.filter((c) => c.combined_into);
    if (combined.length) expect(sent[0].metadata.combinedCandidateIds).toEqual(expect.arrayContaining(combined.map((c) => c.id)));
    expect(rows.filter((c) => c.notified)).toHaveLength(1);
  });

  it("scenario 4: a high-priority task beats a low-priority coaching nudge", async () => {
    const f = await fresh("proactive-4");
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "core.executive_assistant", channelId: f.channelId, type: "check_in",
      reason: "Some general coaching", proposedMessage: "Thought I'd share a tip about grant writing.", subjectKey: "coach:tip", importance: 1, urgency: 1, requiresResponse: false, relatedEntity: {}, metadata: {} });
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.writer", channelId: f.channelId, type: "deadline",
      reason: "The application deadline is tomorrow and the budget is not approved", proposedMessage: "The application is due tomorrow and the budget still needs your approval.",
      subjectKey: "run:z:deadline", importance: 5, urgency: 5, requiresResponse: true, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    const rows = await candidates(f.orgId);
    const high = rows.find((c) => c.subject_key === "run:z:deadline");
    const low = rows.find((c) => c.subject_key === "coach:tip");
    expect(high.status).toBe("delivered");
    expect(["suppressed", "scheduled"]).toContain(low.status);
    expect(Number(high.score)).toBeGreaterThan(Number(low.score ?? 0));
    const sent = await proactiveMessages(f.orgId);
    expect(sent).toHaveLength(1);
    expect(sent[0].author_agent).toBe("grant.writer");
  });

  it("scenario 5: the user is active in Deedwell — the message lands in chat with no notification", async () => {
    const f = await fresh("proactive-5");
    const hb = await api(env.app, "POST", `/v1/orgs/${f.orgId}/presence`, { token: f.token, body: { state: "active" } });
    expect(hb.status).toBe(200);
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "content.designer", channelId: f.channelId, type: "work_completed",
      reason: "Designs are ready", proposedMessage: "I finished the designs. Want to see them?", subjectKey: "content:5:ready", importance: 4, urgency: 3, requiresResponse: false, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, new Date());
    const [c] = await candidates(f.orgId);
    expect(c.status).toBe("delivered");
    expect(c.notified).toBe(false);
    expect(c.decision.presence).toBe("ONLINE_ACTIVE");
    expect(await proactiveMessages(f.orgId)).toHaveLength(1);
  });

  it("scenario 6: the user is offline — the message is unread, notified, deep-linked, and reading clears it", async () => {
    const f = await fresh("proactive-6");
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "website.developer", channelId: f.channelId, type: "work_completed",
      reason: "Website generation completed", proposedMessage: "I finished your website. Want to take a look?", subjectKey: "site:6:done", importance: 5, urgency: 4, requiresResponse: false, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    const [c] = await candidates(f.orgId);
    expect(c.status).toBe("delivered");
    expect(c.notified).toBe(true);
    const unread = await api(env.app, "GET", `/v1/orgs/${f.orgId}/channels/unread`, { token: f.token });
    expect(unread.body.unread[f.channelId]).toMatchObject({ count: expect.any(Number), proactive: 1 });
    const notifications = await api(env.app, "GET", `/v1/orgs/${f.orgId}/notifications`, { token: f.token });
    const item = notifications.body.items.find((i: { kind: string }) => i.kind === "proactive");
    expect(item).toMatchObject({ agentName: "Noah", read: false, channelId: f.channelId, messageId: c.delivered_message_id });
    expect(item.href).toBe(`/dashboard/chat?channel=${f.channelId}&message=${c.delivered_message_id}`);
    const opened = await api(env.app, "POST", `/v1/orgs/${f.orgId}/proactive/candidates/${c.id}/read`, { token: f.token });
    expect(opened.status).toBe(200);
    const read = await api(env.app, "POST", `/v1/orgs/${f.orgId}/channels/${f.channelId}/read`, { token: f.token });
    expect(read.status).toBe(200);
    const after = await api(env.app, "GET", `/v1/orgs/${f.orgId}/channels/unread`, { token: f.token });
    expect(after.body.unread[f.channelId]).toBeUndefined();
    const again = await api(env.app, "GET", `/v1/orgs/${f.orgId}/notifications`, { token: f.token });
    expect(again.body.items.find((i: { kind: string }) => i.kind === "proactive").read).toBe(true);
  });

  it("scenario 7: several ignored low-value messages make the system less aggressive", async () => {
    const policy = ProactivePolicy.parse({});
    const base = { importance: 3, urgency: 2, actionability: 0.6, goalRelevance: 0.6, ageHours: 2, deliveredToday: 0, minutesSinceLastProactive: null, minutesSinceUserActivity: null, duplicateSubject: false, crossAgentOverlap: false, lowValue: false, followUpsForIntent: 0 };
    const attentive = scoreCandidate({ ...base, ignoredRecently: 0 }, policy);
    const ignoring = scoreCandidate({ ...base, ignoredRecently: 3 }, policy);
    expect(ignoring.score).toBeLessThan(attentive.score);
    expect(attentive.score).toBeGreaterThanOrEqual(policy.scoringThreshold);
    expect(ignoring.score).toBeLessThan(policy.scoringThreshold);
    // And through the orchestrator: three unanswered deliveries in the ledger, then the same medium candidate is suppressed.
    const f = await fresh("proactive-7");
    for (let i = 0; i < 3; i++) {
      await env.adminPool.query(
        `INSERT INTO proactive_candidates (id, tenant_id, user_id, agent_key, channel_id, type, reason, subject_key, importance, urgency, status, delivered_at, suggested_send_at)
         VALUES (gen_random_uuid(), $1, $2, 'core.executive_assistant', $3, 'check_in', 'nudge', $4, 2, 1, 'delivered', $5, $5)`,
        [f.orgId, f.userId, f.channelId, `nudge:${i}`, hours(-24 * (i + 1))]
      );
    }
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.writer", channelId: f.channelId, type: "goal_progress",
      reason: "Progress update", proposedMessage: "We have done 3 of 5 steps.", subjectKey: "progress:7", importance: 3, urgency: 2, requiresResponse: false, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    const c = (await candidates(f.orgId)).find((x) => x.subject_key === "progress:7");
    expect(c.status).toBe("suppressed");
    expect(c.decision.reason).toMatch(/unanswered|below threshold/);
  });

  it("scenario 8: the user replies to a proactive message through the normal chat route, and the candidate is marked responded", async () => {
    const f = await fresh("proactive-8");
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "core.executive_assistant", channelId: f.channelId, type: "work_completed",
      reason: "Draft ready", proposedMessage: "Your website draft is ready. Want me to show it to you?", subjectKey: "site:8:draft", importance: 4, urgency: 3, requiresResponse: false, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    const reply = await api(env.app, "POST", `/v1/orgs/${f.orgId}/channels/${f.channelId}/messages`, { token: f.token, body: { body: "Yeah, show me." } });
    expect(reply.status).toBe(201);
    // The existing assistant answered, as it would to any message.
    expect(reply.body.messages.some((m: { author_kind: string }) => m.author_kind === "agent")).toBe(true);
    const [c] = await candidates(f.orgId);
    expect(c.status).toBe("responded");
    expect(c.responded_at).not.toBeNull();
    const presence = (await env.adminPool.query("SELECT presence FROM organization_memberships WHERE tenant_id = $1 AND user_id = $2", [f.orgId, f.userId])).rows[0];
    expect(presence.presence).toBe("active");
  });

  it("scenario 10: a second agent proposing what was just said is suppressed as a duplicate", async () => {
    const f = await fresh("proactive-10");
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.eligibility_analyst", channelId: f.channelId, type: "waiting_on_user",
      reason: "Google account not connected", proposedMessage: "I still need you to connect your Google account.", subjectKey: "google:connect", importance: 4, urgency: 4, requiresResponse: true, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    expect(await proactiveMessages(f.orgId)).toHaveLength(1);
    // Same subject, different agent, an hour later.
    const second = await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "core.executive_assistant", channelId: f.channelId, type: "waiting_on_user",
      reason: "Google account not connected", proposedMessage: "Don't forget to connect Google.", subjectKey: "google:connect", importance: 5, urgency: 5, requiresResponse: true,
      suggestedSendAt: hours(1), relatedEntity: {}, metadata: {} });
    expect(second.deduplicated).toBe(false);
    await runProactiveTick(env.deps, hours(1.5));
    const dup = (await candidates(f.orgId)).find((c) => c.id === second.candidateId);
    expect(dup.status).toBe("suppressed");
    expect(dup.decision.reason).toMatch(/duplicate/);
    expect(await proactiveMessages(f.orgId)).toHaveLength(1);
    // A proposal while one is still queued for the subject is merged rather than duplicated.
    const third = await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.writer", channelId: f.channelId, type: "waiting_on_user",
      reason: "x", subjectKey: "queued:subject", importance: 3, urgency: 2, requiresResponse: true, suggestedSendAt: hours(50), relatedEntity: {}, metadata: {} });
    const fourth = await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.budget_specialist", channelId: f.channelId, type: "waiting_on_user",
      reason: "y", subjectKey: "queued:subject", importance: 3, urgency: 2, requiresResponse: true, suggestedSendAt: hours(50), relatedEntity: {}, metadata: {} });
    expect(fourth).toEqual({ candidateId: third.candidateId, deduplicated: true });
  });

  it("policy: platform admins can tune the policy, and disabling it suppresses everything", async () => {
    const f = await fresh("proactive-admin");
    await env.adminPool.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [f.userId]);
    const got = await api(env.app, "GET", "/v1/admin/proactive/settings", { token: f.token });
    expect(got.status).toBe(200);
    expect(got.body.settings.scoringThreshold).toBe(50);
    const put = await api(env.app, "PUT", "/v1/admin/proactive/settings", { token: f.token, body: { ...got.body.settings, proactiveMessagingEnabled: false } });
    expect(put.status).toBe(200);
    await proposeProactiveMessage(env.deps, f.orgId, { userId: f.userId, agentKey: "grant.writer", channelId: f.channelId, type: "deadline",
      reason: "Due tomorrow", proposedMessage: "Due tomorrow.", subjectKey: "deadline:admin", importance: 5, urgency: 5, requiresResponse: true, relatedEntity: {}, metadata: {} });
    await runProactiveTick(env.deps, T0);
    expect((await candidates(f.orgId))[0].status).toBe("suppressed");
    await api(env.app, "PUT", "/v1/admin/proactive/settings", { token: f.token, body: { ...got.body.settings } });
    const stats = await api(env.app, "GET", "/v1/admin/proactive/stats?days=30", { token: f.token });
    expect(stats.status).toBe(200);
    expect(stats.body.byStatus.length).toBeGreaterThan(0);
    expect(stats.body.suppressionReasons.length).toBeGreaterThan(0);
  });
});
