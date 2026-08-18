import type { PoolClient } from "pg";
import { PASSPORT_FIELDS } from "@deedwell/grant-domain";
import { websiteIntakeFields } from "@deedwell/website-domain";
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

// ---------------------------------------------------------------------------
// Resolving a run's open information request
// ---------------------------------------------------------------------------

/**
 * What a waiting run is actually asking for.
 *
 * The wait payload is deliberately tiny — summarize() truncates it to 800
 * characters, so it carries a context tag and an id, never the questions. The
 * question set is recomputed here from durable records: missing passport facts
 * for grant work, and the website intake catalog minus what's already answered
 * for a site build. Recomputing also means a catalog change reaches runs that
 * are already in flight.
 */
export interface ResolvedInfoRequest {
  fields: InfoRequestField[];
  context: string;
  stage: string | null;
  /** True when the user may hand the remaining choices to the team. */
  allowSkip: boolean;
}

const EMPTY: ResolvedInfoRequest = { fields: [], context: "eligibility", stage: null, allowSkip: false };

export async function resolveInfoRequest(
  client: PoolClient,
  runId: string,
): Promise<ResolvedInfoRequest> {
  const { rows } = await client.query(
    `SELECT status,
            state->'waiting'->>'payload' AS payload,
            state->'input'->>'siteId'    AS site_id
       FROM workflow_runs WHERE id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run || run.status !== "waiting_for_info") return EMPTY;

  let parsed: { missingFacts?: string[]; context?: string; stage?: string; siteId?: string } = {};
  try {
    parsed = JSON.parse(run.payload ?? "{}");
  } catch {
    // A truncated or malformed payload must not take the whole panel down; an
    // empty request renders as "no open questions", which is honest.
    return EMPTY;
  }

  const context = parsed.context ?? "eligibility";

  if (context === "website_intake") {
    const siteId = parsed.siteId ?? run.site_id;
    if (!siteId) return EMPTY;
    const answered = await client.query(
      `SELECT question_key FROM site_intake_answers WHERE site_id = $1`,
      [siteId],
    );
    const seen = new Set<string>(answered.rows.map((r) => r.question_key as string));
    const fields: InfoRequestField[] = websiteIntakeFields("direction", seen).map((f) => ({
      key: f.key,
      label: f.label,
      inputType: f.inputType,
      ...(f.choices ? { choices: f.choices } : {}),
      ...(f.maxSelections ? { maxSelections: f.maxSelections } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      help: f.help,
      reason: f.reason,
      required: f.required,
      group: f.group,
    }));
    return { fields, context, stage: parsed.stage ?? "direction", allowSkip: true };
  }

  return {
    fields: describeInfoRequest(parsed.missingFacts ?? [], context),
    context,
    stage: parsed.stage ?? null,
    allowSkip: false,
  };
}
