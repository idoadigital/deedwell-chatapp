import { describe, expect, it } from "vitest";
import type { ExtractedRequirement, OrgFact } from "@deedwell/schemas";
import { deriveEligibilityRules, evaluateEligibility } from "./eligibility.js";
import { computeApplicationViability, computeBidDecision, computeMissionFit } from "./bidnobid.js";
import { evaluateCompliance, type ComplianceInputs } from "./compliance.js";
import { passportStatus, PASSPORT_FIELDS } from "./passport.js";

const req = (text: string, line: number, kind = "eligibility", mandatory = true): ExtractedRequirement => ({
  text, kind: kind as never, mandatory,
  sourceLocation: { line, quote: text }, wordLimit: null,
});

const fact = (key: string, value: string, status: OrgFact["status"] = "user_certified"): OrgFact => ({
  key, value, status,
});

describe("eligibility engine (deterministic)", () => {
  const rules = deriveEligibilityRules(
    [
      req("Applicants must be a registered 501(c)(3) nonprofit organization.", 4),
      req("Applicants must have an annual operating budget under $500,000.", 5),
    ],
    "2027-01-15"
  );

  it("derives typed rules with source lines from eligibility requirements", () => {
    const kinds = rules.map((r) => r.kind).sort();
    expect(kinds).toContain("entity_type");
    expect(kinds).toContain("registration_required");
    expect(kinds).toContain("max_annual_budget");
    expect(kinds).toContain("deadline_future");
    expect(rules.find((r) => r.kind === "max_annual_budget")?.params.maxUsd).toBe(500000);
  });

  it("missing information is NEVER treated as eligible", () => {
    const evaluation = evaluateEligibility(rules, []);
    expect(evaluation.overall).toBe("insufficient_information");
    expect(evaluation.missingFacts).toContain("entity_type");
    expect(evaluation.missingFacts).toContain("annual_budget");
  });

  it("fails hard on a disqualifier even when other rules pass", () => {
    const evaluation = evaluateEligibility(rules, [
      fact("entity_type", "501(c)(3) public charity"),
      fact("registration_status", "Registered in Ohio"),
      fact("annual_budget", "$750,000"), // over the cap
    ]);
    expect(evaluation.overall).toBe("ineligible");
    expect(evaluation.findings.find((f) => f.ruleKey.startsWith("budget_cap"))?.status).toBe("fail");
  });

  it("returns likely_eligible on user-certified facts, verified_eligible on verified ones", () => {
    const base = [
      fact("entity_type", "501(c)(3) public charity"),
      fact("registration_status", "Registered"),
      fact("annual_budget", "$300,000"),
    ];
    expect(evaluateEligibility(rules, base).overall).toBe("likely_eligible");
    expect(
      evaluateEligibility(rules, base.map((f) => ({ ...f, status: "verified" as const }))).overall
    ).toBe("verified_eligible");
  });

  it("a passed deadline makes the opportunity ineligible", () => {
    const expired = deriveEligibilityRules([], "2020-01-01");
    expect(evaluateEligibility(expired, []).overall).toBe("ineligible");
  });

  it("unverified fact statuses (assumption/estimate) do not count", () => {
    const evaluation = evaluateEligibility(rules, [
      { key: "entity_type", value: "501(c)(3)", status: "assumption" },
    ]);
    expect(evaluation.overall).toBe("insufficient_information");
  });
});

describe("bid/no-bid scoring (deterministic)", () => {
  const strong = {
    eligibility: "likely_eligible" as const,
    daysToDeadline: 45,
    passportCompleteness: 85,
    fundingMax: 150000,
    annualBudgetUsd: 420000,
    mandatoryRequirementCount: 5,
  };

  it("recommends applying on a strong case", () => {
    const result = computeBidDecision(strong);
    expect(result.recommendation).toBe("apply");
    expect(result.total).toBeGreaterThanOrEqual(65);
    expect(result.dimensions).toHaveLength(5);
  });

  it("recommends NOT applying when ineligible, regardless of other strengths", () => {
    const result = computeBidDecision({ ...strong, eligibility: "ineligible" });
    expect(result.recommendation).toBe("do_not_apply");
  });

  it("recommends NOT applying past the deadline", () => {
    expect(computeBidDecision({ ...strong, daysToDeadline: -1 }).recommendation).toBe("do_not_apply");
  });

  it("weak overall cases get do_not_apply or needs_review, with honest rationale", () => {
    const result = computeBidDecision({
      eligibility: "insufficient_information",
      daysToDeadline: 5,
      passportCompleteness: 20,
      fundingMax: 2000000,
      annualBudgetUsd: 100000,
      mandatoryRequirementCount: 12,
    });
    expect(["do_not_apply", "needs_review"]).toContain(result.recommendation);
    expect(result.total).toBeLessThan(65);
  });
});

describe("funding passport", () => {
  it("scores completeness with required fields carrying 80% weight", () => {
    const requiredKeys = PASSPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
    const allRequired = requiredKeys.map((k) => fact(k, "value"));
    const status = passportStatus(allRequired);
    expect(status.completeness).toBe(80);
    expect(status.requiredMissing).toEqual([]);
  });

  it("lists missing required fields and ignores unverified values", () => {
    const status = passportStatus([{ key: "legal_name", value: "X", status: "assumption" }]);
    expect(status.requiredMissing).toContain("legal_name");
    expect(status.completeness).toBe(0);
  });
});

describe("final compliance gate (deterministic)", () => {
  const baseline: ComplianceInputs = {
    sectionCount: 2,
    draftedSectionCount: 2,
    costedBudgetLineCount: 3,
    requirements: [],
    coveredRequirementLines: new Set(),
    uploadedFileCount: 0,
    flaggedClaims: 0,
    budgetWarnings: [],
    wordLimitViolations: [],
    deadline: null,
  };

  it("a fully empty application (no sections, no budget) fails compliance, not passes vacuously", () => {
    const checks = evaluateCompliance({
      ...baseline,
      sectionCount: 0,
      draftedSectionCount: 0,
      costedBudgetLineCount: 0,
    });
    const content = checks.find((c) => c.name === "Application has real drafted content")!;
    expect(content.pass).toBe(false);
    expect(checks.some((c) => !c.pass)).toBe(true);
  });

  it("a partially drafted application (some sections still planned) fails the content check", () => {
    const checks = evaluateCompliance({ ...baseline, draftedSectionCount: 1 });
    const content = checks.find((c) => c.name === "Application has real drafted content")!;
    expect(content.pass).toBe(false);
    expect(content.detail).toContain("1/2");
  });

  it("a fully drafted, costed application passes the content check", () => {
    const checks = evaluateCompliance(baseline);
    const content = checks.find((c) => c.name === "Application has real drafted content")!;
    expect(content.pass).toBe(true);
  });

  it("attachments are compared against the actual required count, not a fixed threshold", () => {
    const requirements: ExtractedRequirement[] = [
      req("Attach your IRS determination letter.", 10, "attachment"),
      req("Attach your most recent audited financials.", 11, "attachment"),
      req("Attach your board list.", 12, "attachment"),
    ];
    // Old bug: `uploadedFiles.rows.length > 1` passed with exactly 2 files
    // regardless of how many were actually required. Here 3 are required.
    const twoFiles = evaluateCompliance({ ...baseline, requirements, uploadedFileCount: 2 });
    expect(twoFiles.find((c) => c.name === "Required attachments accounted for")!.pass).toBe(false);

    const threeFiles = evaluateCompliance({ ...baseline, requirements, uploadedFileCount: 3 });
    expect(threeFiles.find((c) => c.name === "Required attachments accounted for")!.pass).toBe(true);
  });

  it("a section over its word limit blocks compliance", () => {
    const checks = evaluateCompliance({
      ...baseline,
      wordLimitViolations: ['"Need statement" exceeds its 500-word limit (612 words).'],
    });
    const wordCheck = checks.find((c) => c.name === "Section word limits")!;
    expect(wordCheck.pass).toBe(false);
    expect(wordCheck.detail).toContain("612 words");
  });

  it("a fully drafted, costed, on-time, fully-covered application passes every check", () => {
    const requirements: ExtractedRequirement[] = [req("Describe your program.", 3, "narrative")];
    const checks = evaluateCompliance({
      ...baseline,
      requirements,
      coveredRequirementLines: new Set([3]),
      deadline: "2099-01-01",
    });
    expect(checks.every((c) => c.pass)).toBe(true);
  });
});

describe("Mission Fit vs. Application Viability (deterministic, independent)", () => {
  it("mission fit is unaffected by eligibility or deadline — only funding size and readiness", () => {
    const strongFit = computeMissionFit({ fundingMax: 100_000, annualBudgetUsd: 500_000, passportCompleteness: 100 });
    expect(strongFit.score).toBeGreaterThanOrEqual(80);
  });

  it("a great-fit opportunity that's already closed is still a great fit, just not viable", () => {
    const fit = computeMissionFit({ fundingMax: 100_000, annualBudgetUsd: 500_000, passportCompleteness: 100 });
    const viability = computeApplicationViability({
      eligibility: "verified_eligible", opportunityStatus: "closed", daysToDeadline: -5,
    });
    expect(fit.score).toBeGreaterThanOrEqual(80);
    expect(viability.viability).toBe("closed");
  });

  it("ineligible is always not_eligible, regardless of how open the opportunity is", () => {
    const viability = computeApplicationViability({
      eligibility: "ineligible", opportunityStatus: "intake", daysToDeadline: 60,
    });
    expect(viability.viability).toBe("not_eligible");
  });

  it("a passed deadline is closed even when otherwise eligible", () => {
    const viability = computeApplicationViability({
      eligibility: "verified_eligible", opportunityStatus: "in_progress", daysToDeadline: -1,
    });
    expect(viability.viability).toBe("closed");
  });

  it("unresolved eligibility is monitor, not apply and not closed", () => {
    const viability = computeApplicationViability({
      eligibility: "insufficient_information", opportunityStatus: "intake", daysToDeadline: 30,
    });
    expect(viability.viability).toBe("monitor");
  });

  it("eligible, open, future deadline is apply", () => {
    const viability = computeApplicationViability({
      eligibility: "likely_eligible", opportunityStatus: "in_progress", daysToDeadline: 45,
    });
    expect(viability.viability).toBe("apply");
  });
});
