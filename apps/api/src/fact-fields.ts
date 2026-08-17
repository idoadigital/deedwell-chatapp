import { PASSPORT_FIELDS } from "@deedwell/grant-domain";
import type { InfoRequestField } from "@deedwell/schemas";

/**
 * Structured information requests (workspace spec §5-6): when a workflow is
 * genuinely missing facts, the user gets a typed form — not a bare list of
 * snake_case keys. The reason shown depends on WHY the workflow needs it, so
 * grant eligibility and website discovery don't share one canned sentence.
 */

const CONTEXT_REASONS: Record<string, (label: string) => string> = {
  eligibility: (label) =>
    `The announcement's eligibility rules depend on your ${label.toLowerCase()}, and there is no certified value on record.`,
  website_discovery: (label) =>
    `The website team writes your pages from certified facts — your ${label.toLowerCase()} isn't on record yet.`,
  drafting: (label) =>
    `The writer cites only certified facts; your ${label.toLowerCase()} is needed for a claim in the draft.`,
};

const fieldByKey = new Map(PASSPORT_FIELDS.map((f) => [f.key, f]));

export function describeInfoRequest(keys: string[], context = "eligibility"): InfoRequestField[] {
  const reason = CONTEXT_REASONS[context] ?? CONTEXT_REASONS.eligibility!;
  return keys.map((key) => {
    const field = fieldByKey.get(key);
    const label = field?.label ?? key.replace(/_/g, " ");
    return {
      key,
      label,
      inputType: field?.inputType ?? "text",
      ...(field?.choices ? { choices: field.choices } : {}),
      help: field?.hint ?? "",
      reason: reason(label),
      required: field?.required ?? true,
      group: field?.section ?? "Details",
    };
  });
}
