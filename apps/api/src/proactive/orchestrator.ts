import type { PoolClient } from "pg";
import { withContext } from "@deedwell/database";
import type { Deps } from "../bootstrap.js";
import { insertMessage } from "../assistant.js";
import { teammateByKey } from "../teammates.js";
import { composeProactiveMessage, type ComposeContext } from "./compose.js";
import { inQuietHours, loadProactivePolicy, quietHoursEnd, scoreCandidate, type ProactivePolicy, ProactivePrefs } from "./policy.js";
import { derivePresence, type Presence } from "./presence.js";
import { cancelCandidates, loadLedger, loadUserActivity, logEvent, setCandidateStatus, type Ledger, type UserActivity } from "./store.js";
import { handleRunEvent } from "./candidates.js";

/**
 * The only component that may turn a proposal into a chat message.
 *
 * A candidate is evaluated when it becomes due, never when it is created:
 * the world may have moved on. Evaluation asks, in order — is the subject
 * still unresolved, is it fresh, does the user need to act, has someone
 * already said this, how is the user's day looking — and only then scores.
 * The outcome is SEND, SEND LATER (with a time), COMBINE (folded into the
 * message that is about to go out), or SUPPRESS (with the reason kept).
 */
export type Decision =
  | { action: "send"; score: number; factors: Record<string, number>; reasons: string[]; critical: boolean }
  | { action: "schedule"; at: Date; score: number; reason: string }
  | { action: "suppress"; reason: string; score: number; factors?: Record<string, number> }
  | { action: "cancel"; reason: string }
  | { action: "expire" };

interface Candidate extends Record<string, any> { id: string; tenant_id: string; user_id: string; agent_key: string; type: string }

const ACTIONABLE: Record<string, number> = {
  waiting_on_user: 1, blocked: 0.9, deadline: 0.9, work_completed: 0.6, goal_progress: 0.7, status_change: 0.5, opportunity: 0.4, check_in: 0.3,
};

/** True while the thing the candidate is about is still unresolved. */
async function stillRelevant(client: PoolClient, c: Candidate): Promise<{ ok: boolean; reason?: string; intent?: Record<string, any> | null; goal?: Record<string, any> | null }> {
  const intent = c.intent_id ? (await client.query("SELECT * FROM user_intents WHERE id = $1", [c.intent_id])).rows[0] ?? null : null;
  const goal = c.goal_id ? (await client.query("SELECT * FROM user_goals WHERE id = $1", [c.goal_id])).rows[0] ?? null : null;
  if (goal && ["completed", "abandoned"].includes(goal.status)) return { ok: false, reason: "goal already completed", intent, goal };
  if (intent && ["completed", "abandoned"].includes(intent.status)) return { ok: false, reason: "intent already resolved", intent, goal };
  if (["waiting_on_user", "blocked"].includes(c.type) && intent && intent.status !== "waiting_on_user" && intent.status !== "blocked") {
    return { ok: false, reason: `intent is now ${intent.status}`, intent, goal };
  }
  if (intent?.run_id) {
    const run = (await client.query("SELECT status FROM workflow_runs WHERE id = $1", [intent.run_id])).rows[0];
    if (run && ["waiting_on_user"].includes(c.type) && !["waiting_for_info", "waiting_approval"].includes(run.status)) {
      return { ok: false, reason: `run is now ${run.status}`, intent, goal };
    }
  }
  return { ok: true, intent, goal };
}

export async function evaluateCandidate(client: PoolClient, c: Candidate, policy: ProactivePolicy, now: Date): Promise<Decision & { ledger?: Ledger; activity?: UserActivity; intent?: Record<string, any> | null; goal?: Record<string, any> | null }> {
  if (c.expires_at && new Date(c.expires_at) < now) return { action: "expire" };
  const activity = await loadUserActivity(client, c.tenant_id, c.user_id);
  const prefs = ProactivePrefs.safeParse(activity.prefs).success ? ProactivePrefs.parse(activity.prefs) : {};
  if (!policy.proactiveMessagingEnabled || prefs.enabled === false) return { action: "suppress", reason: "proactive messaging disabled", score: 0 };

  const rel = await stillRelevant(client, c);
  if (!rel.ok) return { action: "cancel", reason: rel.reason! };

  const ledger = await loadLedger(client, c.tenant_id, c.user_id, now, { ignoredWindowDays: policy.ignoredMessageWindowDays, topicCooldownHours: policy.topicCooldownHours });
  const ageHours = (now.getTime() - new Date(c.created_at).getTime()) / 3600_000;
  const minutesSince = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 60_000 : null);
  const userActivityMin = minutesSince([activity.lastUserMessageAt, activity.lastActiveAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null);

  // A follow-up about work the user can already see is noise while they are here.
  if (["waiting_on_user", "check_in", "goal_progress"].includes(c.type) && userActivityMin !== null && userActivityMin < policy.recentActivityGraceMinutes && c.evaluations < 8) {
    return { action: "schedule", at: new Date(now.getTime() + policy.recentActivityGraceMinutes * 60_000), score: 0, reason: "user active recently; follow-up postponed" };
  }

  const duplicateSubject = ledger.recentSubjects.has(c.subject_key);
  const overlap = ledger.pendingOthers.find((o) => o.id !== c.id && o.subject_key === c.subject_key && o.agent_key !== c.agent_key
    && (o.importance + o.urgency > c.importance + c.urgency || new Date(o.suggested_send_at) < new Date(c.suggested_send_at)));
  const lowValue = Boolean(c.metadata?.lowValue);
  const inputs = {
    importance: c.importance, urgency: c.urgency,
    actionability: c.requires_response ? 1 : (ACTIONABLE[c.type] ?? 0.5),
    goalRelevance: rel.goal ? (rel.goal.status === "active" || rel.goal.status === "in_progress" || rel.goal.status === "blocked" ? 1 : 0.3) : rel.intent ? 0.6 : 0.2,
    ageHours, deliveredToday: ledger.deliveredToday, ignoredRecently: ledger.ignoredRecently,
    minutesSinceLastProactive: minutesSince(ledger.lastProactiveAt), minutesSinceUserActivity: userActivityMin,
    duplicateSubject, crossAgentOverlap: Boolean(overlap), lowValue,
    followUpsForIntent: c.intent_id ? (ledger.followUpsByIntent.get(c.intent_id) ?? 0) : 0,
  };
  const { score, factors, reasons } = scoreCandidate(inputs, policy);
  // Spacing after another agent's message defers a good candidate rather than
  // vetoing it, so the threshold is judged without that one penalty.
  const merit = scoreCandidate({ ...inputs, minutesSinceLastProactive: null }, policy).score;
  const base = { ledger, activity, intent: rel.intent, goal: rel.goal };
  if (duplicateSubject) return { action: "suppress", reason: "duplicate: subject raised within the topic cooldown", score, factors, ...base };
  if (overlap) return { action: "suppress", reason: `duplicate: ${overlap.agent_key} already covers this subject`, score, factors, ...base };
  if (merit < policy.scoringThreshold) return { action: "suppress", reason: reasons[0] ?? `score ${merit} below threshold ${policy.scoringThreshold}`, score, factors, ...base };

  const critical = score >= policy.criticalPriorityThreshold || c.urgency >= 5;
  if (!critical) {
    if (ledger.deliveredToday >= policy.maxDailyProactiveMessages) {
      const oldest = new Date(now.getTime() - 24 * 3600_000 + 3600_000);
      return { action: "schedule", at: oldest > now ? oldest : new Date(now.getTime() + 3600_000), score, reason: "daily proactive message cap reached", ...base };
    }
    const sinceLast = minutesSince(ledger.lastProactiveAt);
    if (sinceLast !== null && sinceLast < policy.minimumMessageSpacingMinutes) {
      return { action: "schedule", at: new Date(ledger.lastProactiveAt!.getTime() + policy.minimumMessageSpacingMinutes * 60_000), score, reason: "minimum spacing between proactive messages", ...base };
    }
    const agentLast = ledger.lastAgentAt[c.agent_key];
    if (agentLast && (now.getTime() - agentLast.getTime()) / 60_000 < policy.agentCooldownMinutes) {
      return { action: "schedule", at: new Date(agentLast.getTime() + policy.agentCooldownMinutes * 60_000), score, reason: `${c.agent_key} cooldown`, ...base };
    }
    const quiet = prefs.quietHours === null ? null : (prefs.quietHours ?? policy.quietHours);
    if (inQuietHours(now, quiet, activity.timezone)) {
      return { action: "schedule", at: quietHoursEnd(now, quiet!, activity.timezone), score, reason: "quiet hours", ...base };
    }
  }
  return { action: "send", score, factors, reasons, critical, ...base };
}

/** Other due candidates for the same user that clear the bar on their own
 *  merits and can ride along in one message. */
async function combinable(client: PoolClient, primary: Candidate, policy: ProactivePolicy, now: Date): Promise<Candidate[]> {
  if (!policy.combineWindowMinutes) return [];
  const { rows } = await client.query(
    `SELECT * FROM proactive_candidates WHERE tenant_id = $1 AND user_id = $2 AND id <> $3
       AND status IN ('candidate','scheduled','approved','evaluating') AND type IN ('waiting_on_user','blocked','work_completed','goal_progress','deadline')
       AND suggested_send_at <= $4 ORDER BY importance DESC, urgency DESC LIMIT 4`,
    [primary.tenant_id, primary.user_id, primary.id, new Date(now.getTime() + policy.combineWindowMinutes * 60_000)]
  );
  const out: Candidate[] = [];
  for (const row of rows as Candidate[]) {
    if (row.subject_key === primary.subject_key) continue;
    const rel = await stillRelevant(client, row);
    if (!rel.ok) { await setCandidateStatus(client, row.tenant_id, row.id, "cancelled", { decision: { cancelledReason: rel.reason } }); await logEvent(client, row.tenant_id, row.id, "cancelled", rel.reason); continue; }
    const s = scoreCandidate({
      importance: row.importance, urgency: row.urgency, actionability: row.requires_response ? 1 : (ACTIONABLE[row.type] ?? 0.5),
      goalRelevance: rel.goal ? 1 : 0.5, ageHours: (now.getTime() - new Date(row.created_at).getTime()) / 3600_000,
      deliveredToday: 0, ignoredRecently: 0, minutesSinceLastProactive: null, minutesSinceUserActivity: null,
      duplicateSubject: false, crossAgentOverlap: false, lowValue: Boolean(row.metadata?.lowValue), followUpsForIntent: 0,
    }, policy);
    if (s.score >= policy.scoringThreshold) out.push({ ...row, intent: rel.intent, goal: rel.goal });
  }
  return out;
}

/** Writes the message through the ordinary chat path and records delivery. */
export async function deliverCandidate(deps: Deps, client: PoolClient, c: Candidate, decision: Extract<Decision, { action: "send" }> & { ledger?: Ledger; activity?: UserActivity; intent?: Record<string, any> | null; goal?: Record<string, any> | null }, policy: ProactivePolicy, now: Date): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  const extras = await combinable(client, c, policy, now);
  const [org, user] = await Promise.all([
    client.query("SELECT name FROM organizations WHERE id = $1", [c.tenant_id]),
    client.query("SELECT display_name, email FROM users WHERE id = $1", [c.user_id]),
  ]);
  const channelId = c.channel_id ?? decision.intent?.channel_id ?? (await fallbackChannel(client, c.tenant_id, c.agent_key));
  if (!channelId) return { delivered: false, reason: "no channel to deliver into" };
  const lastAgent = await client.query(
    "SELECT body FROM messages WHERE channel_id = $1 AND author_kind = 'agent' AND author_agent = $2 ORDER BY created_at DESC LIMIT 1",
    [channelId, c.agent_key]
  );
  const mate = teammateByKey.get(c.agent_key);
  const ctx: ComposeContext = {
    agentName: mate?.name ?? c.agent_key, agentRole: mate?.role ?? "Deedwell AI", orgName: org.rows[0]?.name ?? "your organization",
    userName: user.rows[0]?.display_name ?? user.rows[0]?.email ?? "there",
    type: c.type, reason: c.reason, goalTitle: decision.goal?.title ?? null, intent: decision.intent?.intent ?? null,
    nextExpectedAction: decision.intent?.next_expected_action ?? (c.related_entity?.nextExpectedAction as string | undefined) ?? null,
    nextExpectedActor: decision.intent?.next_expected_actor ?? null,
    hoursSince: (now.getTime() - new Date(decision.intent?.last_activity_at ?? c.created_at).getTime()) / 3600_000,
    lastAgentMessage: lastAgent.rows[0]?.body ?? null, proposedMessage: c.proposed_message ?? null,
    question: typeof c.related_entity?.question === "string" ? c.related_entity.question : null,
    combined: extras.map((e) => e.intent?.next_expected_action ?? e.proposed_message ?? e.reason),
  };
  const composed = await composeProactiveMessage(deps.provider, ctx);
  if (!composed.shouldSend) {
    await setCandidateStatus(client, c.tenant_id, c.id, "suppressed", { decision: { reason: `model: ${composed.reason ?? "not helpful now"}`, score: decision.score } });
    await logEvent(client, c.tenant_id, c.id, "suppressed", `model: ${composed.reason ?? "not helpful now"}`);
    return { delivered: false, reason: composed.reason ?? "model declined" };
  }
  const presence: Presence = derivePresence({ last_active_at: decision.activity?.lastActiveAt ?? null, presence: decision.activity?.presence ?? null }, now);
  const prefs = ProactivePrefs.safeParse(decision.activity?.prefs ?? {}).success ? ProactivePrefs.parse(decision.activity?.prefs ?? {}) : {};
  const notify = presence !== "ONLINE_ACTIVE" && prefs.notifications !== false
    && (decision.critical || (decision.ledger?.notifiedToday ?? 0) < policy.maxDailyPushNotifications);
  const message = await insertMessage(client, {
    tenantId: c.tenant_id, channelId, authorKind: "agent", authorAgent: c.agent_key, body: composed.message,
    metadata: {
      proactive: true, messageOrigin: "proactive_agent", agentId: c.agent_key, intentId: c.intent_id ?? null, goalId: c.goal_id ?? null,
      triggerType: c.type, orchestrationDecisionId: c.id, candidateId: c.id,
      ...(decision.intent?.run_id ? { runId: decision.intent.run_id } : {}),
      ...(extras.length ? { combinedCandidateIds: extras.map((e) => e.id) } : {}),
    },
  });
  await client.query(
    `UPDATE proactive_candidates SET status = 'delivered', delivered_at = $3, delivered_message_id = $4, notified = $5, channel_id = $6,
            score = $7, decision = decision || $8::jsonb, claimed_at = NULL, proposed_message = $9, metadata = metadata || $10::jsonb
      WHERE tenant_id = $1 AND id = $2`,
    [c.tenant_id, c.id, now, message.id, notify, channelId, decision.score,
     JSON.stringify({ action: "send", critical: decision.critical, presence, factors: decision.factors, combined: extras.length }),
     composed.message, JSON.stringify({ summary: composed.summary })]
  );
  for (const e of extras) {
    await client.query(
      `UPDATE proactive_candidates SET status = 'delivered', delivered_at = $3, delivered_message_id = $4, combined_into = $5, notified = false, claimed_at = NULL,
              decision = decision || '{"action":"combine"}'::jsonb WHERE tenant_id = $1 AND id = $2`,
      [e.tenant_id, e.id, now, message.id, c.id]
    );
    await logEvent(client, e.tenant_id, e.id, "combined", null, { into: c.id });
  }
  await logEvent(client, c.tenant_id, c.id, "delivered", null, { agent: c.agent_key, type: c.type, score: decision.score, presence, notified: notify, channelId, messageId: message.id, combined: extras.length });
  deps.engine.events.emit("event", { type: "message_created", tenantId: c.tenant_id, channelId, proactive: true, candidateId: c.id } as never);
  if (notify) deps.engine.events.emit("event", { type: "notification_created", tenantId: c.tenant_id, userId: c.user_id, candidateId: c.id } as never);
  return { delivered: true, messageId: message.id as string };
}

async function fallbackChannel(client: PoolClient, tenantId: string, agentKey: string): Promise<string | null> {
  const dm = await client.query("SELECT id FROM channels WHERE tenant_id = $1 AND key = $2", [tenantId, `dm:${agentKey}`]);
  if (dm.rows[0]) return dm.rows[0].id;
  const general = await client.query("SELECT id FROM channels WHERE tenant_id = $1 AND key = 'general'", [tenantId]);
  return general.rows[0]?.id ?? null;
}

export interface TickStats { claimed: number; delivered: number; scheduled: number; suppressed: number; cancelled: number; expired: number }

/** One pass: claim what is due, decide, act. Safe to run from several
 *  processes — claims use SKIP LOCKED, the way the publish worker does. */
export async function runProactiveTick(deps: Deps, now = new Date(), limit = 50): Promise<TickStats> {
  const stats: TickStats = { claimed: 0, delivered: 0, scheduled: 0, suppressed: 0, cancelled: 0, expired: 0 };
  await backfillWaitingRuns(deps).catch((err) => console.error(JSON.stringify({ at: "proactive.backfill_error", error: String((err as Error).message ?? err).slice(0, 300) })));
  const expired = await deps.adminPool.query(
    `UPDATE proactive_candidates SET status = 'expired' WHERE status IN ('candidate','scheduled','approved') AND expires_at IS NOT NULL AND expires_at < $1 RETURNING id, tenant_id`,
    [now]
  );
  for (const r of expired.rows) {
    stats.expired++;
    await withContext(deps.appPool, { tenantId: r.tenant_id, userId: null }, (client) => logEvent(client, r.tenant_id, r.id, "expired"));
  }
  const due = await deps.adminPool.query(
    `UPDATE proactive_candidates SET status = 'evaluating', claimed_at = $1, evaluations = evaluations + 1
      WHERE id IN (
        SELECT id FROM proactive_candidates
         WHERE status IN ('candidate','scheduled','approved','evaluating') AND suggested_send_at <= $1
           AND (claimed_at IS NULL OR claimed_at < $1 - interval '2 minutes')
         ORDER BY urgency DESC, importance DESC, suggested_send_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now, limit]
  );
  // RETURNING does not keep the subquery's order: the most urgent must be
  // decided first so the others can ride along with it, not the reverse.
  const claimed = (due.rows as Candidate[]).sort((a, b) => (b.urgency - a.urgency) || (b.importance - a.importance) || (new Date(a.suggested_send_at).getTime() - new Date(b.suggested_send_at).getTime()));
  for (const c of claimed) {
    stats.claimed++;
    try {
      await withContext(deps.appPool, { tenantId: c.tenant_id, userId: c.user_id }, async (client) => {
        const current = (await client.query("SELECT status FROM proactive_candidates WHERE id = $1", [c.id])).rows[0];
        if (!current || current.status !== "evaluating") return; // combined into another message meanwhile
        const policy = await loadProactivePolicy(client);
        const decision = await evaluateCandidate(client, c, policy, now);
        switch (decision.action) {
          case "expire":
            stats.expired++;
            await setCandidateStatus(client, c.tenant_id, c.id, "expired");
            await logEvent(client, c.tenant_id, c.id, "expired");
            break;
          case "cancel":
            stats.cancelled++;
            await setCandidateStatus(client, c.tenant_id, c.id, "cancelled", { decision: { cancelledReason: decision.reason } });
            await logEvent(client, c.tenant_id, c.id, "cancelled", decision.reason);
            break;
          case "suppress":
            stats.suppressed++;
            await setCandidateStatus(client, c.tenant_id, c.id, "suppressed", { decision: { reason: decision.reason, factors: decision.factors ?? {} }, score: decision.score });
            await logEvent(client, c.tenant_id, c.id, "suppressed", decision.reason, { score: decision.score, agent: c.agent_key, type: c.type });
            break;
          case "schedule":
            stats.scheduled++;
            await setCandidateStatus(client, c.tenant_id, c.id, "scheduled", { decision: { deferredReason: decision.reason, deferredUntil: decision.at.toISOString() }, scheduledFor: decision.at, score: decision.score });
            await logEvent(client, c.tenant_id, c.id, "scheduled", decision.reason, { until: decision.at.toISOString(), score: decision.score });
            break;
          case "send": {
            const result = await deliverCandidate(deps, client, c, decision, policy, now);
            if (result.delivered) stats.delivered++; else stats.suppressed++;
            break;
          }
        }
      });
    } catch (err) {
      console.error(JSON.stringify({ at: "proactive.tick_error", candidateId: c.id, error: String((err as Error).message ?? err).slice(0, 300) }));
      await deps.adminPool.query("UPDATE proactive_candidates SET status = 'scheduled', claimed_at = NULL, suggested_send_at = $2 WHERE id = $1", [c.id, new Date(now.getTime() + 10 * 60_000)]).catch(() => {});
    }
  }
  return stats;
}

/** Runs that were already waiting on the user before the bridge existed (or
 *  whose event was missed) get their intent and follow-up on the next tick,
 *  so existing stalled work is followed up too. Cheap: only runs with no
 *  intent yet, a few at a time. */
export async function backfillWaitingRuns(deps: Deps, limit = 10): Promise<number> {
  const { rows } = await deps.adminPool.query(
    `SELECT r.id, r.tenant_id, r.status, r.current_step FROM workflow_runs r
      WHERE r.status IN ('waiting_for_info','waiting_approval') AND r.updated_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM user_intents i WHERE i.run_id = r.id)
      ORDER BY r.updated_at DESC LIMIT $1`,
    [limit]
  );
  for (const r of rows) {
    await handleRunEvent(deps, { tenantId: r.tenant_id, runId: r.id, status: r.status, step: r.current_step });
  }
  return rows.length;
}

export { cancelCandidates };
