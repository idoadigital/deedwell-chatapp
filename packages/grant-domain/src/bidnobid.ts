import type { ApplicationViability, BidDimension, BidRecommendation, EligibilityStatus } from "@deedwell/schemas";

/**
 * Bid/no-bid scoring (BRD §8.3 Stage 5). Deterministic weighted model over
 * computed inputs — the system must recommend NOT applying when the case is
 * weak, so weak inputs produce weak scores rather than optimistic prose.
 */

export interface BidInputs {
  eligibility: EligibilityStatus;
  daysToDeadline: number | null;
  passportCompleteness: number; // 0..100
  fundingMax: number | null;
  annualBudgetUsd: number | null;
  mandatoryRequirementCount: number;
}

export interface BidResult {
  dimensions: BidDimension[];
  total: number; // 0..100
  recommendation: BidRecommendation;
  rationale: string;
}

const ELIGIBILITY_SCORE: Record<EligibilityStatus, number> = {
  verified_eligible: 5,
  likely_eligible: 4,
  insufficient_information: 2,
  conflicting: 1,
  ineligible: 0,
};

export function computeBidDecision(inputs: BidInputs): BidResult {
  const dimensions: BidDimension[] = [];

  dimensions.push({
    key: "eligibility",
    label: "Eligibility confidence",
    score: ELIGIBILITY_SCORE[inputs.eligibility],
    weight: 0.35,
    note: `Eligibility engine result: ${inputs.eligibility.replace(/_/g, " ")}`,
  });

  let timeScore: number;
  let timeNote: string;
  if (inputs.daysToDeadline === null) {
    timeScore = 3;
    timeNote = "No deadline on record — confirm before committing.";
  } else if (inputs.daysToDeadline < 0) {
    timeScore = 0;
    timeNote = "The deadline has passed.";
  } else if (inputs.daysToDeadline < 10) {
    timeScore = 1;
    timeNote = `Only ${inputs.daysToDeadline} day(s) remain — high rush risk.`;
  } else if (inputs.daysToDeadline < 25) {
    timeScore = 3;
    timeNote = `${inputs.daysToDeadline} days remain — workable but tight.`;
  } else {
    timeScore = 5;
    timeNote = `${inputs.daysToDeadline} days remain — comfortable runway.`;
  }
  dimensions.push({ key: "time", label: "Time to deadline", score: timeScore, weight: 0.2, note: timeNote });

  const readinessScore = Math.min(5, Math.round(inputs.passportCompleteness / 20));
  dimensions.push({
    key: "readiness",
    label: "Organizational readiness",
    score: readinessScore,
    weight: 0.2,
    note: `Funding Passport is ${inputs.passportCompleteness}% complete.`,
  });

  let fitScore = 3;
  let fitNote = "Award size not stated — assumed moderate fit.";
  if (inputs.fundingMax !== null && inputs.annualBudgetUsd) {
    const ratio = inputs.fundingMax / inputs.annualBudgetUsd;
    if (ratio > 1.5) {
      fitScore = 1;
      fitNote = "Award would exceed 150% of annual budget — absorption risk funders scrutinize.";
    } else if (ratio < 0.02) {
      fitScore = 2;
      fitNote = "Award is under 2% of annual budget — effort may outweigh value.";
    } else {
      fitScore = 5;
      fitNote = "Award size fits the organization's scale.";
    }
  }
  dimensions.push({ key: "fit", label: "Funding size fit", score: fitScore, weight: 0.15, note: fitNote });

  const complexityScore =
    inputs.mandatoryRequirementCount <= 4 ? 5 : inputs.mandatoryRequirementCount <= 8 ? 3 : 2;
  dimensions.push({
    key: "complexity",
    label: "Requirement burden",
    score: complexityScore,
    weight: 0.1,
    note: `${inputs.mandatoryRequirementCount} mandatory requirement(s) to satisfy.`,
  });

  const total = Math.round(
    dimensions.reduce((sum, d) => sum + (d.score / 5) * d.weight, 0) * 100
  );

  let recommendation: BidRecommendation;
  if (inputs.eligibility === "ineligible" || (inputs.daysToDeadline !== null && inputs.daysToDeadline < 0)) {
    recommendation = "do_not_apply";
  } else if (total >= 65) {
    recommendation = "apply";
  } else if (total >= 45) {
    recommendation = "needs_review";
  } else {
    recommendation = "do_not_apply";
  }

  const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0]!;
  const rationale =
    recommendation === "apply"
      ? `Overall score ${total}/100. The strongest case rests on ${dimensions.filter((d) => d.score >= 4).map((d) => d.label.toLowerCase()).join(", ") || "balanced factors"}; watch ${weakest.label.toLowerCase()}.`
      : recommendation === "needs_review"
        ? `Overall score ${total}/100 is borderline. ${weakest.note} A human should weigh strategic value before committing.`
        : `Overall score ${total}/100. ${weakest.note} Applying now would likely waste effort better spent on stronger opportunities.`;

  return { dimensions, total, recommendation, rationale };
}

// ---------------------------------------------------------------------------
// Mission Fit — how well the opportunity aligns with what the org does and
// its scale. Independent of eligibility/deadline: a 95%-fit opportunity that
// happens to be closed is still a 95% fit, just not viable right now.
// ---------------------------------------------------------------------------

export interface MissionFitInputs {
  fundingMax: number | null;
  annualBudgetUsd: number | null;
  passportCompleteness: number; // 0..100
}

export interface MissionFitResult {
  score: number; // 0..100
  dimensions: BidDimension[];
  rationale: string;
}

export function computeMissionFit(inputs: MissionFitInputs): MissionFitResult {
  const dimensions: BidDimension[] = [];

  const readinessScore = Math.min(5, Math.round(inputs.passportCompleteness / 20));
  dimensions.push({
    key: "readiness",
    label: "Organizational readiness",
    score: readinessScore,
    weight: 0.4,
    note: `Funding Passport is ${inputs.passportCompleteness}% complete.`,
  });

  let fitScore = 3;
  let fitNote = "Award size not stated — assumed moderate fit.";
  if (inputs.fundingMax !== null && inputs.annualBudgetUsd) {
    const ratio = inputs.fundingMax / inputs.annualBudgetUsd;
    if (ratio > 1.5) {
      fitScore = 1;
      fitNote = "Award would exceed 150% of annual budget — absorption risk funders scrutinize.";
    } else if (ratio < 0.02) {
      fitScore = 2;
      fitNote = "Award is under 2% of annual budget — effort may outweigh value.";
    } else {
      fitScore = 5;
      fitNote = "Award size fits the organization's scale.";
    }
  }
  dimensions.push({ key: "fit", label: "Funding size fit", score: fitScore, weight: 0.6, note: fitNote });

  const score = Math.round(dimensions.reduce((sum, d) => sum + (d.score / 5) * d.weight, 0) * 100);
  const strongest = [...dimensions].sort((a, b) => b.score - a.score)[0]!;
  const rationale = `${score}/100. ${strongest.note}`;

  return { dimensions, score, rationale };
}

// ---------------------------------------------------------------------------
// Application Viability — can the org actually apply right now. Purely
// deterministic from eligibility + the opportunity's own status/deadline;
// never an LLM opinion, and never gated by how good a fit the opportunity is.
// ---------------------------------------------------------------------------

export interface ViabilityInputs {
  eligibility: EligibilityStatus;
  opportunityStatus: string;
  daysToDeadline: number | null;
}

export interface ViabilityResult {
  viability: ApplicationViability;
  rationale: string;
}

const CLOSED_OPPORTUNITY_STATUSES = new Set(["closed", "not_pursued", "submitted"]);

export function computeApplicationViability(inputs: ViabilityInputs): ViabilityResult {
  if (inputs.eligibility === "ineligible") {
    return { viability: "not_eligible", rationale: "The eligibility engine found a hard disqualifier." };
  }
  if (CLOSED_OPPORTUNITY_STATUSES.has(inputs.opportunityStatus)) {
    return { viability: "closed", rationale: `This opportunity is marked ${inputs.opportunityStatus.replace(/_/g, " ")}.` };
  }
  if (inputs.daysToDeadline !== null && inputs.daysToDeadline < 0) {
    return { viability: "closed", rationale: "The application deadline has passed." };
  }
  if (inputs.eligibility === "insufficient_information" || inputs.eligibility === "conflicting") {
    return { viability: "monitor", rationale: "Eligibility can't be confirmed yet — more organizational facts are needed." };
  }
  const rationale = inputs.daysToDeadline !== null && inputs.daysToDeadline < 10
    ? `Eligible and open, but only ${inputs.daysToDeadline} day(s) remain.`
    : "Eligible and open — nothing blocks applying.";
  return { viability: "apply", rationale };
}
