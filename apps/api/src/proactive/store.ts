import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";

/** Row helpers for the proactive tables. Every call runs on a tenant-scoped
 *  client (RLS does the isolation); nothing here decides anything. */

export interface GoalInput {
  tenantId: string; userId: string; subjectKey: string; title: string; description?: string | null;
  status?: string; priority?: number; channelId?: string | null; runId?: string | null; targetDate?: string | null;
}
export async function upsertGoal(client: PoolClient, g: GoalInput): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO user_goals (id, tenant_id, user_id, subject_key, title, description, status, priority, originating_channel_id, originating_run_id, target_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, subject_key) DO UPDATE SET
       title = EXCLUDED.title, description = COALESCE(EXCLUDED.description, user_goals.description),
       status = COALESCE($7, user_goals.status), priority = COALESCE($8, user_goals.priority),
       target_date = COALESCE(EXCLUDED.target_date, user_goals.target_date)
     RETURNING id`,
    [uuidv7(), g.tenantId, g.userId, g.subjectKey, g.title, g.description ?? null, g.status ?? "active", g.priority ?? 3,
     g.channelId ?? null, g.runId ?? null, g.targetDate ?? null]
  );
  return rows[0].id as string;
}

export async function setGoalStatus(client: PoolClient, tenantId: string, subjectKey: string, status: string): Promise<string | null> {
  const { rows } = await client.query(
    "UPDATE user_goals SET status = $3 WHERE tenant_id = $1 AND subject_key = $2 RETURNING id",
    [tenantId, subjectKey, status]
  );
  return (rows[0]?.id as string) ?? null;
}

export interface IntentInput {
  tenantId: string; userId: string; subjectKey: string; goalId?: string | null; agentKey: string; intent: string;
  status: string; nextExpectedAction?: string | null; nextExpectedActor?: "user" | "agent" | null;
  followUpEligibleAt?: Date | null; channelId?: string | null; runId?: string | null; metadata?: Record<string, unknown>;
  /** When the situation actually arose (a run's updated_at), so a backfilled intent is not "0 hours old". */
  lastActivityAt?: Date | null;
}
export async function upsertIntent(client: PoolClient, i: IntentInput): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO user_intents (id, tenant_id, user_id, subject_key, goal_id, agent_key, intent, status, next_expected_action,
                               next_expected_actor, follow_up_eligible_at, channel_id, run_id, metadata, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15, now()))
     ON CONFLICT (tenant_id, subject_key) DO UPDATE SET
       goal_id = COALESCE(EXCLUDED.goal_id, user_intents.goal_id), agent_key = EXCLUDED.agent_key, intent = EXCLUDED.intent,
       status = EXCLUDED.status, next_expected_action = EXCLUDED.next_expected_action, next_expected_actor = EXCLUDED.next_expected_actor,
       follow_up_eligible_at = EXCLUDED.follow_up_eligible_at, last_activity_at = COALESCE($15, now()),
       resolved_at = CASE WHEN EXCLUDED.status IN ('completed','abandoned') THEN now() ELSE NULL END,
       channel_id = COALESCE(EXCLUDED.channel_id, user_intents.channel_id), metadata = user_intents.metadata || EXCLUDED.metadata
     RETURNING id`,
    [uuidv7(), i.tenantId, i.userId, i.subjectKey, i.goalId ?? null, i.agentKey, i.intent, i.status, i.nextExpectedAction ?? null,
     i.nextExpectedActor ?? null, i.followUpEligibleAt ?? null, i.channelId ?? null, i.runId ?? null, JSON.stringify(i.metadata ?? {}), i.lastActivityAt ?? null]
  );
  return rows[0].id as string;
}

/** Every intent on a run moves to `status`; returns the ids touched. */
export async function resolveIntentsForRun(client: PoolClient, tenantId: string, runId: string, status: string): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE user_intents SET status = $3, last_activity_at = now(),
            resolved_at = CASE WHEN $3 IN ('completed','abandoned') THEN now() ELSE resolved_at END,
            next_expected_actor = CASE WHEN $3 IN ('completed','abandoned') THEN NULL ELSE 'agent' END
      WHERE tenant_id = $1 AND run_id = $2 AND status NOT IN ('completed','abandoned') RETURNING id`,
    [tenantId, runId, status]
  );
  return rows.map((r) => r.id as string);
}

export interface CandidateInput {
  tenantId: string; userId: string; agentKey: string; channelId?: string | null; intentId?: string | null; goalId?: string | null;
  type: string; reason: string; proposedMessage?: string | null; importance: number; urgency: number; requiresResponse: boolean;
  subjectKey: string; suggestedSendAt: Date; expiresAt?: Date | null; relatedEntity?: Record<string, unknown>; metadata?: Record<string, unknown>;
  /** Ledger-only rows: the message already exists (a milestone the bridge wrote). */
  delivered?: { messageId: string | null; notified: boolean } | null;
}

export async function insertCandidate(client: PoolClient, c: CandidateInput): Promise<Record<string, any>> {
  const id = uuidv7();
  const { rows } = await client.query(
    `INSERT INTO proactive_candidates (id, tenant_id, user_id, agent_key, channel_id, intent_id, goal_id, type, reason, proposed_message,
        importance, urgency, requires_response, subject_key, suggested_send_at, expires_at, related_entity, metadata,
        status, delivered_at, delivered_message_id, notified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [id, c.tenantId, c.userId, c.agentKey, c.channelId ?? null, c.intentId ?? null, c.goalId ?? null, c.type, c.reason, c.proposedMessage ?? null,
     c.importance, c.urgency, c.requiresResponse, c.subjectKey, c.suggestedSendAt, c.expiresAt ?? null,
     JSON.stringify(c.relatedEntity ?? {}), JSON.stringify(c.metadata ?? {}),
     c.delivered ? "delivered" : "candidate", c.delivered ? new Date() : null, c.delivered?.messageId ?? null, c.delivered?.notified ?? false]
  );
  return rows[0];
}

/** An open candidate for the same subject, if one is already queued. */
export async function openCandidateFor(client: PoolClient, tenantId: string, subjectKey: string): Promise<Record<string, any> | null> {
  const { rows } = await client.query(
    `SELECT * FROM proactive_candidates WHERE tenant_id = $1 AND subject_key = $2
       AND status IN ('candidate','evaluating','scheduled','approved') ORDER BY created_at DESC LIMIT 1`,
    [tenantId, subjectKey]
  );
  return rows[0] ?? null;
}

export async function logEvent(client: PoolClient, tenantId: string, candidateId: string | null, event: string, reason?: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await client.query(
    "INSERT INTO proactive_log (id, tenant_id, candidate_id, event, reason, metadata) VALUES ($1,$2,$3,$4,$5,$6)",
    [uuidv7(), tenantId, candidateId, event, reason ?? null, JSON.stringify(metadata)]
  );
  console.log(JSON.stringify({ at: "proactive." + event, tenantId, candidateId, reason: reason ?? undefined, ...metadata }));
}

export async function setCandidateStatus(client: PoolClient, tenantId: string, id: string, status: string, patch: Record<string, unknown> = {}): Promise<void> {
  await client.query(
    `UPDATE proactive_candidates SET status = $3, decision = decision || $4::jsonb, claimed_at = NULL,
            scheduled_for = COALESCE($5, scheduled_for), suggested_send_at = COALESCE($5, suggested_send_at), score = COALESCE($6, score)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, status, JSON.stringify(patch.decision ?? {}), (patch.scheduledFor as Date | undefined) ?? null, (patch.score as number | undefined) ?? null]
  );
}

/** Cancels open candidates matching the filter; returns how many. */
export async function cancelCandidates(
  client: PoolClient, tenantId: string,
  where: { subjectPrefix?: string; subjectKey?: string; intentIds?: string[]; goalId?: string; channelId?: string; userId?: string },
  reason: string
): Promise<number> {
  const clauses: string[] = ["tenant_id = $1", "status IN ('candidate','evaluating','scheduled','approved')"];
  const params: unknown[] = [tenantId];
  const add = (sql: string, v: unknown) => { params.push(v); clauses.push(sql.replace("?", `$${params.length}`)); };
  if (where.subjectPrefix) add("subject_key LIKE ?", `${where.subjectPrefix}%`);
  if (where.subjectKey) add("subject_key = ?", where.subjectKey);
  if (where.intentIds?.length) add("intent_id = ANY(?::uuid[])", where.intentIds);
  if (where.goalId) add("goal_id = ?", where.goalId);
  if (where.channelId) add("channel_id = ?", where.channelId);
  if (where.userId) add("user_id = ?", where.userId);
  const { rows } = await client.query(
    `UPDATE proactive_candidates SET status = 'cancelled', decision = decision || jsonb_build_object('cancelledReason', $${params.length + 1}::text)
      WHERE ${clauses.join(" AND ")} RETURNING id`,
    [...params, reason]
  );
  for (const r of rows) await logEvent(client, tenantId, r.id as string, "cancelled", reason);
  return rows.length;
}

/** What the orchestrator needs to know about this user's recent proactive traffic. */
export interface Ledger {
  deliveredToday: number;
  notifiedToday: number;
  lastProactiveAt: Date | null;
  lastProactiveAgent: string | null;
  lastProactiveSubject: string | null;
  lastAgentAt: Record<string, Date>;
  ignoredRecently: number;
  recentSubjects: Map<string, Date>;
  pendingOthers: Array<{ id: string; agent_key: string; subject_key: string; importance: number; urgency: number; suggested_send_at: Date; type: string }>;
  followUpsByIntent: Map<string, number>;
}
export async function loadLedger(client: PoolClient, tenantId: string, userId: string, now: Date, opts: { ignoredWindowDays: number; topicCooldownHours: number }): Promise<Ledger> {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const delivered = await client.query(
    `SELECT id, agent_key, subject_key, delivered_at, notified, responded_at, read_at, intent_id
       FROM proactive_candidates WHERE tenant_id = $1 AND user_id = $2 AND delivered_at IS NOT NULL AND delivered_at > $3
       ORDER BY delivered_at DESC`,
    [tenantId, userId, new Date(now.getTime() - Math.max(opts.ignoredWindowDays, 2) * 86400_000)]
  );
  const rows = delivered.rows as Array<Record<string, any>>;
  const lastAgentAt: Record<string, Date> = {};
  const recentSubjects = new Map<string, Date>();
  const followUpsByIntent = new Map<string, number>();
  for (const r of rows) {
    const at = new Date(r.delivered_at);
    if (!lastAgentAt[r.agent_key] || lastAgentAt[r.agent_key]! < at) lastAgentAt[r.agent_key] = at;
    if (now.getTime() - at.getTime() < opts.topicCooldownHours * 3600_000 && !recentSubjects.has(r.subject_key)) recentSubjects.set(r.subject_key, at);
    if (r.intent_id) followUpsByIntent.set(r.intent_id, (followUpsByIntent.get(r.intent_id) ?? 0) + 1);
  }
  const ignoredRecently = rows.filter((r) => !r.responded_at && !r.read_at && now.getTime() - new Date(r.delivered_at).getTime() > 6 * 3600_000).length;
  const pending = await client.query(
    `SELECT id, agent_key, subject_key, importance, urgency, suggested_send_at, type FROM proactive_candidates
      WHERE tenant_id = $1 AND user_id = $2 AND status IN ('candidate','scheduled','approved','evaluating') ORDER BY suggested_send_at`,
    [tenantId, userId]
  );
  const first = rows[0];
  return {
    deliveredToday: rows.filter((r) => new Date(r.delivered_at) > dayAgo).length,
    notifiedToday: rows.filter((r) => r.notified && new Date(r.delivered_at) > dayAgo).length,
    lastProactiveAt: first ? new Date(first.delivered_at) : null,
    lastProactiveAgent: first?.agent_key ?? null,
    lastProactiveSubject: first?.subject_key ?? null,
    lastAgentAt, ignoredRecently, recentSubjects,
    pendingOthers: pending.rows as Ledger["pendingOthers"],
    followUpsByIntent,
  };
}

export interface UserActivity { lastUserMessageAt: Date | null; lastActiveAt: Date | null; presence: string | null; timezone: string | null; prefs: Record<string, unknown> }
export async function loadUserActivity(client: PoolClient, tenantId: string, userId: string): Promise<UserActivity> {
  const [msg, member] = await Promise.all([
    client.query("SELECT MAX(created_at) AS at FROM messages WHERE tenant_id = $1 AND author_user = $2", [tenantId, userId]),
    client.query(
      `SELECT m.last_active_at, m.presence, m.proactive_prefs, u.timezone FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.user_id = $2`, [tenantId, userId]),
  ]);
  const row = member.rows[0] ?? {};
  return {
    lastUserMessageAt: msg.rows[0]?.at ? new Date(msg.rows[0].at) : null,
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
    presence: row.presence ?? null, timezone: row.timezone ?? null, prefs: row.proactive_prefs ?? {},
  };
}

/** The user wrote in a channel: every proactive message there is now answered. */
export async function markResponded(client: PoolClient, tenantId: string, userId: string, channelId: string): Promise<string[]> {
  const { rows } = await client.query(
    `UPDATE proactive_candidates SET status = 'responded', responded_at = now(), read_at = COALESCE(read_at, now())
      WHERE tenant_id = $1 AND user_id = $2 AND channel_id = $3 AND status IN ('delivered','read') AND delivered_at > now() - interval '7 days'
      RETURNING id, delivered_at`,
    [tenantId, userId, channelId]
  );
  for (const r of rows) {
    await logEvent(client, tenantId, r.id as string, "responded", null, { secondsToResponse: Math.round((Date.now() - new Date(r.delivered_at).getTime()) / 1000) });
  }
  return rows.map((r) => r.id as string);
}

export async function markReadInChannel(client: PoolClient, tenantId: string, userId: string, channelId: string): Promise<void> {
  const { rows } = await client.query(
    `UPDATE proactive_candidates SET status = 'read', read_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND channel_id = $3 AND status = 'delivered' RETURNING id`,
    [tenantId, userId, channelId]
  );
  for (const r of rows) await logEvent(client, tenantId, r.id as string, "read");
}
