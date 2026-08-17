import { TEAMMATES, type Teammate } from "./teammates.js";

/**
 * Huddle turn intelligence: shared Turn Manager (hybrid end-of-turn),
 * backchannel/interruption classification, and agent routing.
 * Pure logic — clock-injected, fully unit-tested; rtc.ts wires it to audio.
 */

// ---- configuration (env-tunable, conservative defaults) -------------------

export interface TurnConfig {
  graceMs: number;            // silence after a seemingly-complete final
  incompleteGraceMs: number;  // extended wait when the thought looks unfinished
  maxTurnWaitMs: number;      // safety commit
  minInterruptWords: number;  // words needed for an implicit barge-in
}

export function turnConfigFromEnv(env = process.env): TurnConfig {
  const num = (key: string, dflt: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    graceMs: num("HUDDLE_GRACE_MS", 1800),
    incompleteGraceMs: num("HUDDLE_INCOMPLETE_GRACE_MS", 3200),
    maxTurnWaitMs: num("HUDDLE_MAX_TURN_WAIT_MS", 12000),
    minInterruptWords: num("HUDDLE_MIN_INTERRUPT_WORDS", 2),
  };
}

// ---- end-of-turn semantics -------------------------------------------------

const CONTINUATION_TAIL = new Set([
  "and", "but", "so", "or", "because", "um", "uh", "er", "the", "a", "an", "to",
  "with", "for", "of", "in", "is", "was", "are", "were", "i", "we", "you",
  "they", "it", "that", "this", "my", "our", "first", "second", "then", "like",
  "about", "was...", "if", "when", "which", "what", "should", "would", "could",
]);

const COMPLETE_SHORT = new Set([
  "stop", "wait", "yes", "no", "go ahead", "that's all", "thats all", "continue",
  "okay go", "do it", "approve", "pass", "wrap up",
]);

/** Heuristic semantic completeness for unpunctuated ASR text. */
export function looksComplete(text: string): boolean {
  const clean = text.trim().toLowerCase();
  if (!clean) return false;
  if (COMPLETE_SHORT.has(clean)) return true;
  const words = clean.split(/\s+/);
  if (words.length < 3) return false; // one or two words: almost never a thought
  const tail = words[words.length - 1]!;
  if (CONTINUATION_TAIL.has(tail)) return false;
  if (/\b(i wanted to|i think we should|the problem is|there are \w+ things|give me a second)$/.test(clean)) return false;
  return true;
}

// ---- Turn Manager ----------------------------------------------------------

export type TurnState =
  | "IDLE" | "LISTENING" | "TURN_COMPLETION_PENDING" | "TURN_COMMITTED";

export interface CommittedTurn {
  turnId: string;
  text: string;
  reason: "semantic_complete" | "max_wait" | "explicit_flush";
  waitedMs: number;
}

/**
 * Owns the user's speaking turn. ASR finals are candidate segments, never
 * commitments: commit happens only after a grace window with no resumed
 * speech (longer when the tail looks unfinished), or the safety timeout.
 */
export class TurnManager {
  state: TurnState = "IDLE";
  private segments: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private turnStartedAt = 0;
  private pendingSince = 0;
  private counter = 0;

  constructor(
    private readonly config: TurnConfig,
    private readonly onCommit: (turn: CommittedTurn) => void,
    private readonly onState: (state: TurnState) => void = () => undefined,
    private readonly now: () => number = () => Date.now()
  ) {}

  private setState(s: TurnState) {
    if (this.state !== s) { this.state = s; this.onState(s); }
  }

  /** Provisional speech resumed — cancel any pending commit. */
  onPartial(partial: string): void {
    if (!partial.trim()) return;
    if (this.state === "IDLE" || this.state === "TURN_COMMITTED") {
      this.turnStartedAt = this.now();
      this.setState("LISTENING");
    }
    if (this.state === "TURN_COMPLETION_PENDING") {
      this.clearTimer();
      this.setState("LISTENING"); // the user kept talking — same turn continues
    }
    this.armSafety();
  }

  /** A stable ASR final — a candidate segment, not a commitment. */
  onFinal(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (this.state === "IDLE" || this.state === "TURN_COMMITTED") {
      this.turnStartedAt = this.now();
    }
    this.segments.push(clean);
    this.setState("TURN_COMPLETION_PENDING");
    this.pendingSince = this.now();
    this.clearTimer();
    const joined = this.text();
    const wait = looksComplete(joined) ? this.config.graceMs : this.config.incompleteGraceMs;
    this.timer = setTimeout(() => this.commit("semantic_complete"), wait);
    this.armSafety();
  }

  /** Explicit flush (e.g. user pressed send / muted deliberately). */
  flush(): void {
    if (this.segments.length) this.commit("explicit_flush");
  }

  text(): string {
    return this.segments.join(" ").replace(/\s+/g, " ").trim();
  }

  private armSafety() {
    if (this.safetyTimer) return;
    this.safetyTimer = setTimeout(() => {
      if (this.segments.length) this.commit("max_wait");
      else { this.clearSafety(); this.setState("IDLE"); }
    }, this.config.maxTurnWaitMs);
  }

  private commit(reason: CommittedTurn["reason"]) {
    this.clearTimer();
    this.clearSafety();
    const text = this.text();
    this.segments = [];
    if (!text) { this.setState("IDLE"); return; }
    this.setState("TURN_COMMITTED");
    this.onCommit({
      turnId: `turn-${++this.counter}-${this.now().toString(36)}`,
      text,
      reason,
      waitedMs: this.now() - this.turnStartedAt,
    });
    this.setState("IDLE");
  }

  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private clearSafety() { if (this.safetyTimer) { clearTimeout(this.safetyTimer); this.safetyTimer = null; } }
  dispose() { this.clearTimer(); this.clearSafety(); }
}

// ---- backchannel vs genuine interruption -----------------------------------

const BACKCHANNELS = new Set([
  "yeah", "yes", "mm-hmm", "mmhmm", "mhm", "okay", "ok", "right", "i see",
  "sure", "uh-huh", "uh huh", "got it", "cool", "hm", "hmm", "yep",
]);
const PRIORITY_INTERRUPTS = /\b(stop|wait|no no|hold on|hang on|that's not|thats not|let me finish|actually|pause)\b/;

export type UtteranceClass = "backchannel" | "interruption" | "speech";

/** Classify user speech heard WHILE an agent holds the floor. */
export function classifyWhileAgentSpeaking(
  text: string,
  config: TurnConfig,
  agentAskedQuestion: boolean
): UtteranceClass {
  const clean = text.trim().toLowerCase();
  if (!clean) return "backchannel";
  if (PRIORITY_INTERRUPTS.test(clean)) return "interruption";
  const words = clean.split(/\s+/);
  if (BACKCHANNELS.has(clean)) {
    // "yes" right after the agent asked something is an answer, not a nod.
    return agentAskedQuestion ? "interruption" : "backchannel";
  }
  if (words.length < config.minInterruptWords) return "backchannel";
  return "interruption";
}

// ---- routing ---------------------------------------------------------------

export interface RoutingDecision {
  turnId: string;
  explicitAddresseeId?: string;
  primaryCandidateId: string;
  secondaryCandidateIds: string[];
  routingConfidence: number;
  reasonCodes: string[];
  responseMode: "single_agent" | "primary_plus_followup" | "clarification" | "no_response";
}

// The moderator (Maya) is deliberately absent generic words like "help" and
// "plan": she is already the low-confidence fallback, and generic words let
// her tie-steal turns that belong to a specialist.
const EXPERTISE: Record<string, string[]> = {
  "core.executive_assistant": ["status", "coordinate", "summary", "team"],
  "grant.program_planner": ["plan", "timeline", "task", "project", "manage", "deadline"],
  "grant.funding_strategist": ["funding", "strategy", "pursue", "bid", "worth", "fit"],
  "grant.opportunity_researcher": ["find", "search", "grant", "opportunity", "funder", "foundation"],
  "grant.eligibility_analyst": ["eligible", "eligibility", "qualify", "requirements", "criteria"],
  "grant.writer": ["write", "draft", "narrative", "section", "proposal", "statement"],
  "grant.budget_specialist": [
    "budget", "cost", "price", "spend", "expense", "money", "financial", "finance",
    "salary", "salaries", "line item", "indirect", "how much", "afford",
  ],
  "grant.requirements_analyst": ["compliance", "requirement", "checklist", "attachment", "format"],
  "website.digital_strategist": ["website", "site", "audience", "brief", "goal", "sitemap"],
  "website.seo_accessibility_reviewer": ["design", "accessibility", "seo", "color", "visual", "layout"],
  "website.developer": ["build", "page", "update", "change", "deploy", "fix", "checkout", "code"],
  "website.copywriter": ["copy", "text", "tagline", "wording", "content", "headline"],
  "website.qa_deployment": ["deploy", "deployment", "publish", "release", "live", "rollback", "infrastructure"],
};

// Word-boundary prefix match: "budget" hits "budgets"/"budgeting" but "cost"
// never hits inside an unrelated word.
const EXPERTISE_PATTERNS: Array<[string, RegExp[]]> = Object.entries(EXPERTISE).map(
  ([key, words]) => [key, words.map((w) => new RegExp(`\\b${w}`))]
);

export interface RoutingContext {
  participants: string[];       // agentKeys in this huddle
  taskOwnerAgent?: string | null;   // agent responsible for the active run step
  recentSpeakers: string[];     // most recent agent speakers, newest first
  defaultAgent: string;         // channel persona (Maya or DM partner)
}

/** Deterministic-first routing: explicit address > ownership/continuity > expertise. */
export function routeTurn(turnId: string, text: string, ctx: RoutingContext): RoutingDecision {
  const clean = text.toLowerCase();
  const reasons: string[] = [];
  const inHuddle = (key: string) => ctx.participants.includes(key);

  // 1) Explicit name or role — highest priority, deterministic.
  const explicit: Teammate[] = [];
  for (const mate of TEAMMATES) {
    const namePattern = new RegExp(`\\b${mate.name.toLowerCase()}\\b`);
    const rolePattern = new RegExp(`\\bthe ${mate.role.toLowerCase().split(" ").pop()}\\b`);
    if (namePattern.test(clean)) { explicit.push(mate); reasons.push("EXPLICIT_NAME"); }
    else if (rolePattern.test(clean) || clean.includes(mate.role.toLowerCase())) {
      explicit.push(mate); reasons.push("EXPLICIT_ROLE");
    }
  }
  if (explicit.length) {
    const [primary, second] = explicit;
    return {
      turnId,
      explicitAddresseeId: primary!.agentKey,
      primaryCandidateId: primary!.agentKey,
      secondaryCandidateIds: second ? [second.agentKey] : [],
      routingConfidence: 1,
      reasonCodes: [...new Set(reasons)],
      responseMode: second ? "primary_plus_followup" : "single_agent",
    };
  }

  // 2) Weighted implicit scoring.
  const scores = new Map<string, number>();
  const bump = (key: string, amount: number, reason: string) => {
    if (!inHuddle(key)) return;
    scores.set(key, (scores.get(key) ?? 0) + amount);
    reasons.push(reason);
  };
  for (const [key, patterns] of EXPERTISE_PATTERNS) {
    const hits = patterns.filter((p) => p.test(clean)).length;
    if (hits) bump(key, hits * 2, "EXPERTISE_MATCH");
  }
  if (ctx.taskOwnerAgent) bump(ctx.taskOwnerAgent, 3, "TASK_OWNER");
  if (ctx.recentSpeakers[0]) bump(ctx.recentSpeakers[0], 1.5, "CONVERSATION_CONTINUITY");

  // Ties go to the specialist, never the moderator/default (who answers on
  // low confidence anyway).
  const ranked = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || Number(a[0] === ctx.defaultAgent) - Number(b[0] === ctx.defaultAgent)
  );
  const top = ranked[0];
  if (!top || top[1] < 2) {
    // Low confidence → the channel persona / moderator answers.
    return {
      turnId,
      primaryCandidateId: ctx.defaultAgent,
      secondaryCandidateIds: [],
      routingConfidence: 0.4,
      reasonCodes: [...new Set([...reasons, "LOW_CONFIDENCE"])],
      responseMode: "single_agent",
    };
  }
  const confidence = Math.min(1, top[1] / 8);
  return {
    turnId,
    primaryCandidateId: top[0],
    secondaryCandidateIds: [],
    routingConfidence: confidence,
    reasonCodes: [...new Set(reasons)],
    responseMode: "single_agent",
  };
}

/** Token-overlap redundancy check for secondary contributions. */
export function overlapRatio(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const ta = tok(a); const tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let hits = 0;
  for (const w of ta) if (tb.has(w)) hits++;
  return hits / Math.min(ta.size, tb.size);
}
