/**
 * Facts the Google Ad Grants program itself requires, before eligibility
 * can even be checked. Unlike grant-domain's requiredFactKeys(), this isn't
 * derived from extracted funder requirements — Ad Grants has one fixed set
 * of program rules, so the list is just fixed.
 *
 * techsoup_validation_token is deliberately NOT included here — it's gated
 * by its own techsoup_validation step so the checklist shows it as a
 * distinct stage, not folded into the general facts gate.
 */
export function requiredAdGrantsFactKeys(): string[] {
  return [
    "legal_name",
    "entity_type",
    "registration_status",
    "mission",
    "website_url",
    "ein",
  ].sort();
}
