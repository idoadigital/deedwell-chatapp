import type { OrgFact, PassportField } from "@deedwell/schemas";

/**
 * Funding Passport (BRD §8.3 Stage 1): the structured organizational profile
 * that grant work draws from. Fields live in the org_facts ledger; this
 * catalog gives them structure, sections, and completeness scoring.
 */
export const PASSPORT_FIELDS: PassportField[] = [
  // Identity
  { key: "legal_name", label: "Legal name", section: "Identity", required: true },
  { key: "trading_name", label: "Trading / public name", section: "Identity", required: false },
  { key: "entity_type", label: "Entity type", section: "Identity", required: true,
    hint: "e.g. 501(c)(3) public charity", inputType: "choice",
    choices: ["501(c)(3) public charity", "501(c)(3) private foundation", "501(c)(4)", "Fiscally sponsored project", "Government entity", "Other nonprofit"] },
  { key: "mission", label: "Mission statement", section: "Identity", required: true, inputType: "textarea" },
  { key: "year_founded", label: "Year founded", section: "Identity", required: false, inputType: "number" },
  // Registration
  { key: "registration_status", label: "Registration status", section: "Registration", required: true,
    hint: "e.g. registered and in good standing in your state" },
  { key: "ein", label: "EIN / tax ID", section: "Registration", required: false },
  { key: "sam_registration", label: "SAM.gov registration", section: "Registration", required: false,
    hint: "Required for most US federal grants", inputType: "boolean" },
  // Location & reach
  { key: "headquarters", label: "Headquarters location", section: "Location & Reach", required: true },
  { key: "service_area", label: "Service area", section: "Location & Reach", required: true,
    hint: "The geography you serve, e.g. 'King County, WA' or 'statewide Ohio'" },
  { key: "website_url", label: "Website URL", section: "Location & Reach", required: false,
    hint: "Google Ad Grants requires a live, substantial website", inputType: "text" },
  // Google Ad Grants — Google validates nonprofits through Goodstack.
  { key: "goodstack_validation_status", label: "Goodstack verification", section: "Registration", required: false,
    hint: "Google for Nonprofits verifies your organization through Goodstack during signup", inputType: "choice",
    choices: ["Verified by Goodstack", "Verification in progress", "Not started"] },
  { key: "goodstack_reference", label: "Goodstack reference", section: "Registration", required: false,
    hint: "The reference or confirmation from Goodstack, if you have one (optional)" },
  { key: "documents_status", label: "Supporting documents", section: "Registration", required: false, inputType: "choice",
    hint: "IRS determination letter, EIN confirmation, articles of incorporation, an authorized representative's ID and authorization letter, your logo",
    choices: ["Uploaded the documents", "Will provide later"] },
  { key: "google_workspace_choice", label: "Google Workspace for Nonprofits", section: "Registration", required: false, inputType: "choice",
    hint: "Optional: Google Workspace (Gmail, Drive, Docs for your team) is free for approved nonprofits",
    choices: ["Yes, set up Google Workspace", "Already have Google Workspace", "No, Ad Grants only"] },
  // Contact
  { key: "primary_contact_name", label: "Primary contact name", section: "Contact", required: false },
  { key: "primary_contact_title", label: "Primary contact title", section: "Contact", required: false },
  { key: "primary_contact_email", label: "Primary contact email", section: "Contact", required: false },
  { key: "phone", label: "Phone", section: "Contact", required: false },
  { key: "mailing_address", label: "Mailing address", section: "Contact", required: false },
  { key: "city", label: "City", section: "Contact", required: false },
  { key: "state", label: "State / province", section: "Contact", required: false },
  { key: "postal_code", label: "ZIP / postal code", section: "Contact", required: false },
  { key: "country", label: "Country", section: "Contact", required: false },
  // Finances
  { key: "annual_budget", label: "Annual budget", section: "Finances", required: true,
    hint: "Most recent fiscal year, USD", inputType: "number" },
  { key: "audit_status", label: "Most recent audit status", section: "Finances", required: false },
  { key: "fiscal_year_end", label: "Fiscal year end", section: "Finances", required: false, inputType: "date" },
  // Programs & people
  { key: "programs", label: "Primary programs", section: "Programs & People", required: true, inputType: "textarea" },
  { key: "beneficiaries", label: "Beneficiary groups", section: "Programs & People", required: true, inputType: "textarea" },
  { key: "staff_count", label: "Staff count", section: "Programs & People", required: false, inputType: "number" },
  { key: "leadership", label: "Executive leadership", section: "Programs & People", required: false },
  // Track record
  { key: "past_grants", label: "Notable past grants", section: "Track Record", required: false, inputType: "textarea" },
  { key: "impact_evidence", label: "Impact evidence highlights", section: "Track Record", required: false, inputType: "textarea" },
];

export interface PassportStatus {
  fields: Array<PassportField & { value: string | null; status: string | null }>;
  completeness: number;
  requiredMissing: string[];
}

export function passportStatus(facts: OrgFact[]): PassportStatus {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const fields = PASSPORT_FIELDS.map((field) => {
    const fact = byKey.get(field.key);
    return { ...field, value: fact?.value ?? null, status: fact?.status ?? null };
  });
  const usable = (f: (typeof fields)[number]) =>
    f.value !== null && (f.status === "verified" || f.status === "user_certified");
  const required = fields.filter((f) => f.required);
  const requiredDone = required.filter(usable).length;
  const optionalDone = fields.filter((f) => !f.required).filter(usable).length;
  const optionalCount = fields.length - required.length;
  // Required fields carry 80% of the completeness weight.
  const completeness = Math.round(
    (requiredDone / required.length) * 80 + (optionalCount ? (optionalDone / optionalCount) * 20 : 20)
  );
  return {
    fields,
    completeness,
    requiredMissing: required.filter((f) => !usable(f)).map((f) => f.key),
  };
}
