import { z } from "zod";

/**
 * The tunable half of proactive messaging. Every number the orchestrator
 * uses lives here, read from platform_settings (key "proactive_messaging")
 * with these defaults, so behaviour can be adjusted from Platform Admin
 * without a deploy. Nothing in the orchestrator hard-codes a threshold.
 */
export const PROACTIVE_SETTINGS_KEY = "proactive_messaging";

export const ProactivePolicy = z.object({
  proactiveMessagingEnabled: z.boolean().default(true),
  /** Per user, per rolling 24 h. Critical messages may exceed these. */
  maxDailyProactiveMessages: z.number().int().min(0).max(50).default(3),
  maxDailyPushNotifications: z.number().int().min(0).max(50).default(2),
  /** Minimum gap between two non-critical proactive messages to one user. */
  minimumMessageSpacingMinutes: z.number().int().min(0).default(120),
  /** Local-time hours during which non-critical delivery waits. */
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).default({ start: 21, end: 8 }),
  /** After one agent reaches out, that agent waits this long before another non-critical message. */
  agentCooldownMinutes: z.number().int().min(0).default(240),
  /** The same subject is not raised again within this window. */
  topicCooldownHours: z.number().int().min(0).default(24),
  /** Score at or above which a candidate is approved. */
  scoringThreshold: z.number().min(0).max(100).default(50),
  /** Score at or above which a candidate bypasses spacing, daily caps and quiet hours. */
  criticalPriorityThreshold: z.number().min(0).max(100).default(85),
  /** How long after work stalls a follow-up first becomes eligible, per trigger. */
  followUpDelayHours: z.object({
    waiting_on_user: z.number().min(0).default(20),
    blocked: z.number().min(0).default(4),
    check_in: z.number().min(0).default(72),
  }).default({}),
  /** The user recently active in Deedwell: a follow-up about work they can see is noise. */
  recentActivityGraceMinutes: z.number().int().min(0).default(30),
  /** After this many unanswered proactive messages, each further one is penalised. */
  maxFollowUpsPerIntent: z.number().int().min(0).default(2),
  ignoredMessagePenalty: z.number().min(0).default(12),
  ignoredMessageWindowDays: z.number().int().min(1).default(14),
  /** Two candidates for the same user due together are merged when both clear the threshold. */
  combineWindowMinutes: z.number().int().min(0).default(30),
  weights: z.object({
    importance: z.number().default(10),
    urgency: z.number().default(8),
    actionability: z.number().default(15),
    goalRelevance: z.number().default(10),
    freshness: z.number().default(10),
    fatiguePenalty: z.number().default(15),
    duplicatePenalty: z.number().default(40),
    recentMessagePenalty: z.number().default(20),
    lowValuePenalty: z.number().default(25),
  }).default({}),
});
export type ProactivePolicy = z.infer<typeof ProactivePolicy>;

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export async function loadProactivePolicy(db: Queryable): Promise<ProactivePolicy> {
  const { rows } = await db.query("SELECT value FROM platform_settings WHERE key = $1", [PROACTIVE_SETTINGS_KEY]);
  const parsed = ProactivePolicy.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : ProactivePolicy.parse({});
}

/** Per-user preferences, stored on the membership. Absent = policy defaults. */
export const ProactivePrefs = z.object({
  enabled: z.boolean().optional(),
  notifications: z.boolean().optional(),
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).nullable().optional(),
});
export type ProactivePrefs = z.infer<typeof ProactivePrefs>;

// ---- scoring ----------------------------------------------------------------

export interface ScoreInputs {
  importance: number;          // 1-5
  urgency: number;             // 1-5
  /** The user must act (1), the agent could do it itself (0), somewhere between. */
  actionability: number;       // 0-1
  /** Tied to an active goal (1), loosely (0.5), not at all (0). */
  goalRelevance: number;       // 0-1
  /** Hours since the situation arose; freshness decays over ~7 days. */
  ageHours: number;
  /** Proactive messages delivered to this user in the last 24 h. */
  deliveredToday: number;
  /** Delivered but unanswered proactive messages in the ignored-message window. */
  ignoredRecently: number;
  /** Minutes since any proactive message reached this user (null = never). */
  minutesSinceLastProactive: number | null;
  /** Minutes since the user last wrote in Deedwell (null = never). */
  minutesSinceUserActivity: number | null;
  /** Same subject already raised within the topic cooldown. */
  duplicateSubject: boolean;
  /** The same subject was raised by another agent's pending or recent message. */
  crossAgentOverlap: boolean;
  /** The model or the derivation said this would not help right now. */
  lowValue: boolean;
  /** Earlier follow-ups already sent for this intent. */
  followUpsForIntent: number;
}

export interface ScoreResult { score: number; factors: Record<string, number>; reasons: string[] }

/** proactiveScore = importance + urgency + actionability + goalRelevance + freshness
 *                   − fatigue − duplicate − recentMessage − lowValue, each weighted by policy. */
export function scoreCandidate(inputs: ScoreInputs, policy: ProactivePolicy): ScoreResult {
  const w = policy.weights;
  const reasons: string[] = [];
  const freshness = Math.max(0, 1 - inputs.ageHours / (24 * 7));
  const fatigueUnits = inputs.deliveredToday / Math.max(1, policy.maxDailyProactiveMessages)
    + Math.min(1, inputs.ignoredRecently / Math.max(1, policy.maxFollowUpsPerIntent)) ;
  const recentUnit = inputs.minutesSinceLastProactive !== null && policy.minimumMessageSpacingMinutes > 0
    ? Math.max(0, 1 - inputs.minutesSinceLastProactive / policy.minimumMessageSpacingMinutes)
    : 0;
  const factors: Record<string, number> = {
    importance: (inputs.importance / 5) * w.importance,
    urgency: (inputs.urgency / 5) * w.urgency,
    actionability: inputs.actionability * w.actionability,
    goalRelevance: inputs.goalRelevance * w.goalRelevance,
    freshness: freshness * w.freshness,
    fatiguePenalty: -Math.min(1.5, fatigueUnits) * w.fatiguePenalty,
    duplicatePenalty: -((inputs.duplicateSubject || inputs.crossAgentOverlap) ? w.duplicatePenalty : 0),
    recentMessagePenalty: -recentUnit * w.recentMessagePenalty,
    lowValuePenalty: -(inputs.lowValue ? w.lowValuePenalty : 0),
    ignoredPenalty: -Math.max(0, inputs.followUpsForIntent - policy.maxFollowUpsPerIntent + 1) * policy.ignoredMessagePenalty
      - inputs.ignoredRecently * (policy.ignoredMessagePenalty / 2),
  };
  if (inputs.duplicateSubject) reasons.push("same subject raised within the topic cooldown");
  if (inputs.crossAgentOverlap) reasons.push("another agent already covers this subject");
  if (inputs.lowValue) reasons.push("would not materially help the user right now");
  if (inputs.ignoredRecently) reasons.push(`${inputs.ignoredRecently} recent proactive message(s) went unanswered`);
  if (inputs.deliveredToday >= policy.maxDailyProactiveMessages) reasons.push("daily proactive message cap reached");
  // The scale: a fully-weighted positive set sums to ~53; normalised to 0-100.
  const positiveMax = w.importance + w.urgency + w.actionability + w.goalRelevance + w.freshness;
  const raw = Object.values(factors).reduce((s, v) => s + v, 0);
  const score = Math.max(0, Math.min(100, (raw / positiveMax) * 100));
  return { score: Math.round(score * 10) / 10, factors, reasons };
}

/** Whether `at` (UTC) falls inside the user's quiet hours in their timezone. */
export function inQuietHours(at: Date, quiet: { start: number; end: number } | null | undefined, timeZone: string | null): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timeZone ?? "UTC" }).format(at));
  } catch { hour = at.getUTCHours(); }
  if (hour === 24) hour = 0;
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

/** The next moment after `at` that is outside quiet hours. */
export function quietHoursEnd(at: Date, quiet: { start: number; end: number }, timeZone: string | null): Date {
  const out = new Date(at);
  for (let i = 0; i < 24 && inQuietHours(out, quiet, timeZone); i++) out.setUTCHours(out.getUTCHours() + 1, 5, 0, 0);
  return out;
}
