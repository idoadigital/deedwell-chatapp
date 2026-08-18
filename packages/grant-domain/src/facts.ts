import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";
import type { ExtractedRequirement, FactStatus } from "@deedwell/schemas";

/**
 * Deterministic mapping from requirement kinds to the organizational facts
 * needed before drafting can proceed. Missing information is requested, never
 * guessed (BRD: missing information must not be treated as eligibility).
 */
const KIND_FACTS: Record<string, string[]> = {
  eligibility: ["legal_name", "entity_type", "registration_status"],
  budget: ["annual_budget"],
};

const ALWAYS_REQUIRED = ["legal_name", "mission"];

export function requiredFactKeys(requirements: Pick<ExtractedRequirement, "kind">[]): string[] {
  const keys = new Set(ALWAYS_REQUIRED);
  for (const req of requirements) {
    for (const key of KIND_FACTS[req.kind] ?? []) keys.add(key);
  }
  return [...keys].sort();
}

export interface WriteOrgFactParams {
  tenantId: string;
  factKey: string;
  value: string;
  status: FactStatus;
  certifiedBy?: string | null;
  sourceFileId?: string | null;
  sourceLocation?: string | null;
  sourceQuote?: string | null;
  extractedByAgent?: string | null;
  /** Bypass the conflict check — used only when a human has just resolved a conflict. */
  force?: boolean;
}

/**
 * The single write path for org_facts. A plain upsert when there's no real
 * disagreement (no existing row, or the existing one isn't verified/
 * user_certified yet); otherwise the disagreement is recorded in
 * org_fact_conflicts and the current value is left untouched — inference
 * or a re-extraction must never silently become organizational fact.
 */
export async function writeOrgFact(
  client: PoolClient,
  params: WriteOrgFactParams
): Promise<{ conflict: boolean }> {
  const existing = await client.query(
    `SELECT value, status, source_file_id FROM org_facts
     WHERE tenant_id = $1 AND fact_key = $2 FOR UPDATE`,
    [params.tenantId, params.factKey]
  );
  const current = existing.rows[0] as
    | { value: string; status: string; source_file_id: string | null }
    | undefined;

  const isRealDisagreement =
    !params.force &&
    current &&
    (current.status === "verified" || current.status === "user_certified") &&
    current.value !== params.value;

  if (isRealDisagreement) {
    await client.query(
      `INSERT INTO org_fact_conflicts (id, tenant_id, fact_key, current_value, current_status,
         current_source_file_id, proposed_value, proposed_status, proposed_source_file_id, proposed_source_quote)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uuidv7(), params.tenantId, params.factKey, current!.value, current!.status,
        current!.source_file_id, params.value, params.status,
        params.sourceFileId ?? null, params.sourceQuote ?? null,
      ]
    );
    return { conflict: true };
  }

  await client.query(
    `INSERT INTO org_facts (id, tenant_id, fact_key, value, status, certified_by,
       source_file_id, source_location, source_quote, extracted_by_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, fact_key) DO UPDATE SET
       value = EXCLUDED.value, status = EXCLUDED.status, certified_by = EXCLUDED.certified_by,
       source_file_id = EXCLUDED.source_file_id, source_location = EXCLUDED.source_location,
       source_quote = EXCLUDED.source_quote, extracted_by_agent = EXCLUDED.extracted_by_agent,
       updated_at = now()`,
    [
      uuidv7(), params.tenantId, params.factKey, params.value, params.status,
      params.certifiedBy ?? null, params.sourceFileId ?? null, params.sourceLocation ?? null,
      params.sourceQuote ?? null, params.extractedByAgent ?? null,
    ]
  );
  return { conflict: false };
}
