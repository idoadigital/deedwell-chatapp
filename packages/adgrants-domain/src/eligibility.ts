import type { OrgFact } from "@deedwell/schemas";

export interface AdGrantsEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

// Entity types Ad Grants does not accept, matched against PASSPORT_FIELDS'
// entity_type choices. This is a pre-screen only — Google's and TechSoup's
// own review is the actual, final determination; this exists so an
// obviously-ineligible org isn't walked through the rest of the workflow
// first.
const INELIGIBLE_ENTITY_TYPES = new Set([
  "501(c)(4)",
  "Fiscally sponsored project",
  "Government entity",
]);

const BAD_REGISTRATION = /\b(revoked|suspended|not\s+registered|inactive|dissolved)\b/i;

/**
 * Deterministic pre-screen against the fact ledger. Never guesses: a
 * required fact that's missing surfaces as ineligible-for-now with an
 * explanatory reason, not as a silent pass.
 */
export function checkAdGrantsEligibility(facts: OrgFact[]): AdGrantsEligibilityResult {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const usable = (key: string) => {
    const f = byKey.get(key);
    return f && (f.status === "verified" || f.status === "user_certified") ? f.value : null;
  };

  const reasons: string[] = [];
  const entityType = usable("entity_type");
  if (!entityType) {
    reasons.push("Entity type is not on record.");
  } else if (INELIGIBLE_ENTITY_TYPES.has(entityType)) {
    reasons.push(`Entity type "${entityType}" is not eligible for Google Ad Grants.`);
  }

  const registration = usable("registration_status");
  if (!registration) {
    reasons.push("Registration status is not on record.");
  } else if (BAD_REGISTRATION.test(registration)) {
    reasons.push(`Registration status "${registration}" does not indicate good standing.`);
  }

  const website = usable("website_url");
  if (!website) reasons.push("Google Ad Grants requires a live, substantial website.");

  return { eligible: reasons.length === 0, reasons };
}
