import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TurnManager, turnConfigFromEnv, looksComplete,
  classifyWhileAgentSpeaking, routeTurn, overlapRatio,
} from "./huddle-turns.js";

const cfg = { graceMs: 1800, incompleteGraceMs: 3200, maxTurnWaitMs: 12000, minInterruptWords: 2 };

describe("Turn Manager — hybrid end-of-turn (spec §2–3, §18)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const manager = (onCommit: (t: { text: string; reason: string }) => void) =>
    new TurnManager(cfg, onCommit as never, () => undefined, () => Date.now());

  it("incomplete speech: 'I need help' + 1s pause + continuation = ONE turn", () => {
    const commits: string[] = [];
    const tm = manager((t) => commits.push(t.text));
    tm.onFinal("i need help");
    vi.advanceTimersByTime(1000);           // the defect scenario: 1s pause
    expect(commits).toHaveLength(0);        // no agent responds yet
    tm.onPartial("fixing");                  // speech resumed — cancel pending
    tm.onFinal("fixing the checkout flow");
    vi.advanceTimersByTime(1900);
    expect(commits).toEqual(["i need help fixing the checkout flow"]);
  });

  it("a single word is never a committed thought on the short grace", () => {
    const commits: string[] = [];
    const tm = manager((t) => commits.push(t.text));
    tm.onFinal("so");
    vi.advanceTimersByTime(1900);           // short grace passes — still waiting
    expect(commits).toHaveLength(0);
    vi.advanceTimersByTime(1400);           // extended incomplete grace elapses
    expect(commits).toEqual(["so"]);        // eventually committed, not dropped
  });

  it("hesitation joins into one turn", () => {
    const commits: string[] = [];
    const tm = manager((t) => commits.push(t.text));
    tm.onFinal("so um");
    vi.advanceTimersByTime(800);
    tm.onFinal("the problem i'm having is with deployment");
    vi.advanceTimersByTime(1900);
    expect(commits).toEqual(["so um the problem i'm having is with deployment"]);
  });

  it("trailing continuation words extend the wait", () => {
    expect(looksComplete("what i wanted to ask you was")).toBe(false);
    expect(looksComplete("i think we should")).toBe(false);
    expect(looksComplete("there are three things first")).toBe(false);
    expect(looksComplete("can you review the budget for me")).toBe(true);
    expect(looksComplete("that's all")).toBe(true);
  });

  it("safety timeout commits a stalled turn", () => {
    const commits: Array<{ text: string; reason: string }> = [];
    const tm = new TurnManager(cfg, (t) => commits.push(t), () => undefined);
    tm.onFinal("um");
    for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(1500); tm.onPartial("uh"); }
    vi.advanceTimersByTime(13000);
    expect(commits).toHaveLength(1);
  });
});

describe("backchannel vs genuine interruption (spec §11–12)", () => {
  it("'yeah' during an explanation does not steal the floor", () => {
    expect(classifyWhileAgentSpeaking("yeah", cfg, false)).toBe("backchannel");
    expect(classifyWhileAgentSpeaking("mm-hmm", cfg, false)).toBe("backchannel");
    expect(classifyWhileAgentSpeaking("okay", cfg, false)).toBe("backchannel");
  });
  it("'yes' after the agent asked a question is a real answer", () => {
    expect(classifyWhileAgentSpeaking("yes", cfg, true)).toBe("interruption");
  });
  it("priority commands always interrupt", () => {
    expect(classifyWhileAgentSpeaking("stop", cfg, false)).toBe("interruption");
    expect(classifyWhileAgentSpeaking("wait that's not what i meant", cfg, false)).toBe("interruption");
    expect(classifyWhileAgentSpeaking("hold on", cfg, false)).toBe("interruption");
  });
  it("substantive speech interrupts; single stray words do not", () => {
    expect(classifyWhileAgentSpeaking("change the budget section", cfg, false)).toBe("interruption");
    expect(classifyWhileAgentSpeaking("hm", cfg, false)).toBe("backchannel");
  });
});

describe("orchestrator routing (spec §5–7, §18)", () => {
  const ctx = {
    participants: [
      "core.executive_assistant", "grant.writer", "grant.budget_specialist",
      "website.developer", "website.qa_deployment", "website.seo_accessibility_reviewer",
    ],
    taskOwnerAgent: null,
    recentSpeakers: [],
    defaultAgent: "core.executive_assistant",
  };

  it("explicit name wins deterministically", () => {
    const d = routeTurn("t1", "sophia can you review the narrative", ctx);
    expect(d.primaryCandidateId).toBe("grant.writer");
    expect(d.explicitAddresseeId).toBe("grant.writer");
    expect(d.reasonCodes).toContain("EXPLICIT_NAME");
    expect(d.routingConfidence).toBe(1);
  });

  it("explicit role reference routes correctly", () => {
    const d = routeTurn("t2", "let the website developer answer this", ctx);
    expect(d.primaryCandidateId).toBe("website.developer");
  });

  it("implicit deployment question goes to the deployment owner", () => {
    const d = routeTurn("t3", "why did the deployment fail last night", ctx);
    expect(d.primaryCandidateId).toBe("website.qa_deployment");
    expect(d.reasonCodes).toContain("EXPERTISE_MATCH");
  });

  it("two explicit addressees produce primary plus follow-up", () => {
    const d = routeTurn("t4", "i want both leo and noah to respond", ctx);
    expect(d.responseMode).toBe("primary_plus_followup");
    expect(d.secondaryCandidateIds).toHaveLength(1);
  });

  it("low confidence falls back to the moderator", () => {
    const d = routeTurn("t5", "hmm interesting weather today", ctx);
    expect(d.primaryCandidateId).toBe("core.executive_assistant");
    expect(d.reasonCodes).toContain("LOW_CONFIDENCE");
  });

  it("budget questions route to the budget specialist", () => {
    for (const q of [
      "who should i ask about budgets",
      "can you help with the budget",
      "how much money do we have left",
      "what will this cost us",
      "is there room in the budget for another staff position",
    ]) {
      const d = routeTurn("tb", q, ctx);
      expect(d.primaryCandidateId, q).toBe("grant.budget_specialist");
      expect(d.reasonCodes).toContain("EXPERTISE_MATCH");
    }
  });

  it("a generic-word tie never lets the moderator steal a specialist turn", () => {
    const d = routeTurn("tt", "give me a summary of the budget", ctx);
    expect(d.primaryCandidateId).toBe("grant.budget_specialist");
  });

  it("continuity nudges routing toward the recent speaker", () => {
    const d = routeTurn("t6", "can you keep going with that budget explanation", {
      ...ctx, recentSpeakers: ["grant.budget_specialist"],
    });
    expect(d.primaryCandidateId).toBe("grant.budget_specialist");
  });
});

describe("redundancy suppression (spec §9)", () => {
  it("near-identical answers overlap heavily; distinct ones do not", () => {
    expect(overlapRatio(
      "the budget total exceeds the funding ceiling by ten thousand dollars",
      "your budget total exceeds the funding ceiling by about ten thousand dollars"
    )).toBeGreaterThan(0.6);
    expect(overlapRatio(
      "the budget exceeds the ceiling",
      "accessibility contrast fails on the homepage hero"
    )).toBeLessThan(0.3);
  });
});

describe("configuration (spec §16)", () => {
  it("reads env overrides with conservative defaults", () => {
    expect(turnConfigFromEnv({}).graceMs).toBe(1800);
    expect(turnConfigFromEnv({ HUDDLE_GRACE_MS: "900" }).graceMs).toBe(900);
    expect(turnConfigFromEnv({ HUDDLE_GRACE_MS: "junk" }).graceMs).toBe(1800);
  });
});
