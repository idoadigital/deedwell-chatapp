import type { ExtractedRequirement } from "@deedwell/schemas";

export interface ComplianceCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ComplianceInputs {
  sectionCount: number;
  draftedSectionCount: number;
  costedBudgetLineCount: number;
  requirements: ExtractedRequirement[];
  coveredRequirementLines: Set<number>;
  uploadedFileCount: number;
  flaggedClaims: number;
  budgetWarnings: string[];
  wordLimitViolations: string[];
  deadline: string | null;
  now?: Date;
}

/**
 * Deterministic compliance gate. Every check here is real code, not a model
 * opinion — the export approval flow shows a human exactly what's missing,
 * and an application with no drafted content or no costed budget can never
 * pass vacuously just because there is nothing left to flag.
 */
export function evaluateCompliance(input: ComplianceInputs): ComplianceCheck[] {
  const narrativeMandatory = input.requirements.filter((r) => r.mandatory && r.kind === "narrative");
  const uncovered = narrativeMandatory.filter((r) => !input.coveredRequirementLines.has(r.sourceLocation.line));
  const attachmentReqs = input.requirements.filter((r) => r.mandatory && r.kind === "attachment");
  const now = input.now ?? new Date();

  return [
    {
      name: "Application has real drafted content",
      pass: input.sectionCount > 0
        && input.draftedSectionCount === input.sectionCount
        && input.costedBudgetLineCount > 0,
      detail: input.sectionCount === 0
        ? "No sections have been planned yet — nothing has been drafted."
        : input.draftedSectionCount < input.sectionCount
          ? `${input.draftedSectionCount}/${input.sectionCount} sections drafted — the rest are still empty.`
          : input.costedBudgetLineCount === 0
            ? "No budget line items exist yet."
            : `${input.draftedSectionCount} section(s) drafted, ${input.costedBudgetLineCount} budget line item(s) costed.`,
    },
    {
      name: "Required attachments accounted for",
      pass: attachmentReqs.length === 0 || input.uploadedFileCount >= attachmentReqs.length,
      detail: attachmentReqs.length
        ? `The announcement requires ${attachmentReqs.length} attachment(s): ${attachmentReqs
            .map((r) => r.text.slice(0, 80)).join(" | ")} — project has ${input.uploadedFileCount} uploaded file(s). Verify each before submitting.`
        : "No mandatory attachments in the announcement",
    },
    {
      name: "Mandatory narrative requirements mapped to sections",
      pass: uncovered.length === 0,
      detail: uncovered.length
        ? `${uncovered.length} unmapped: ${uncovered.map((r) => `line ${r.sourceLocation.line}`).join(", ")}`
        : `All ${narrativeMandatory.length} mapped`,
    },
    {
      name: "No unsupported claims",
      pass: input.flaggedClaims === 0,
      detail: input.flaggedClaims ? `${input.flaggedClaims} claim(s) still lack verified evidence` : "All claims supported",
    },
    {
      name: "Budget validation",
      pass: input.budgetWarnings.length === 0,
      detail: input.budgetWarnings.length ? input.budgetWarnings.join("; ") : "Budget checks passed",
    },
    {
      name: "Section word limits",
      pass: input.wordLimitViolations.length === 0,
      detail: input.wordLimitViolations.length ? input.wordLimitViolations.join("; ") : "All sections within their word limits",
    },
    {
      name: "Deadline still in the future",
      pass: !input.deadline || new Date(input.deadline).getTime() > now.getTime(),
      detail: input.deadline ?? "No deadline on record — confirm with the funder",
    },
  ];
}
