import type { Page } from "playwright";
import { assertAllowedUrl } from "./allowlist.js";
import { assertSignedIn, clickFirst, fillField, report, settle, type FillReport } from "./fill.js";

/**
 * Google for Nonprofits enrollment + Ad Grants activation — deterministic
 * Playwright, never LLM-driven (see the design note in workflow.ts).
 *
 * Google publishes no markup contract for these pages, so every field is
 * located by several independent strategies (fill.ts) and every run returns
 * a per-field report plus a screenshot. A field Google has renamed shows up
 * as "not found" in the approval preview rather than as a silent blank —
 * the person approving sees exactly what will and won't be submitted.
 * Validation against a real account happens through that preview on the
 * first live run; nothing is submitted without a person approving it.
 */

const NONPROFITS_URL = "https://www.google.com/nonprofits/";
const NONPROFITS_SIGNUP_URL = "https://www.google.com/nonprofits/account/signup";
const AD_GRANTS_ACTIVATION_URL = "https://www.google.com/grants/";

const ENROLLMENT_FIELDS = (facts: Record<string, string>) => [
  { key: "country", label: "Country", patterns: [/country/i], value: facts.country, kind: "select" as const },
  { key: "legal_name", label: "Organization legal name", patterns: [/organi[sz]ation.*(legal )?name/i, /legal name/i, /nonprofit name/i, /^name of/i], value: facts.legal_name },
  { key: "website_url", label: "Website", patterns: [/website/i, /web ?site|url/i], value: facts.website_url },
  { key: "ein", label: "EIN / tax ID", patterns: [/\bein\b/i, /tax id|tax-id|taxpayer/i, /registration number|charity number/i], value: facts.ein },
  { key: "mission", label: "Mission", patterns: [/mission/i, /describe your organi[sz]ation|about your organi[sz]ation/i], value: facts.mission },
  { key: "primary_contact_name", label: "Contact name", patterns: [/contact name|your name|full name/i, /first name/i], value: facts.primary_contact_name },
  { key: "primary_contact_email", label: "Contact email", patterns: [/contact email|email address|^email$/i], value: facts.primary_contact_email },
  { key: "techsoup_validation_token", label: "TechSoup validation token", patterns: [/techsoup/i, /validation token|validation code/i], value: facts.techsoup_validation_token },
];

/** Lands on the enrollment form: the marketing page's call to action, or
 *  the signup URL directly. Returns notes on which route was needed. */
async function openEnrollmentForm(page: Page): Promise<string[]> {
  const notes: string[] = [];
  assertAllowedUrl(NONPROFITS_URL);
  await page.goto(NONPROFITS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page);
  assertSignedIn(page);
  const hasForm = async () => (await page.locator("form input:not([type=hidden]), form textarea, form select").count().catch(() => 0)) > 0;
  if (await hasForm()) return notes;
  if (await clickFirst(page, [/get started/i, /apply now|apply/i, /request an account|sign up|join/i], ["link", "button"])) {
    notes.push("Opened the enrollment from the Google for Nonprofits page.");
    assertSignedIn(page);
    if (await hasForm()) return notes;
  }
  assertAllowedUrl(NONPROFITS_SIGNUP_URL);
  await page.goto(NONPROFITS_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  await settle(page);
  assertSignedIn(page);
  notes.push(await hasForm() ? "Opened the enrollment signup page directly." : "Could not find an enrollment form on Google's pages; nothing was filled.");
  return notes;
}

export async function fillNonprofitsEnrollment(page: Page, facts: Record<string, string>): Promise<FillReport> {
  const notes = await openEnrollmentForm(page);
  const results = [];
  for (const spec of ENROLLMENT_FIELDS(facts)) results.push(await fillField(page, spec));
  // Google sometimes asks "Are you signing up for a nonprofit?"-style radios first.
  await clickFirst(page, [/^next$|^continue$/i], ["button"]).then((moved) => { if (moved) notes.push("Advanced past a first page of the form."); });
  return report(page, results, notes);
}

/** True when the submit button was found and clicked; false when Google's
 *  form offered no recognisable submit — the caller must not claim success. */
export async function clickSubmitEnrollment(page: Page): Promise<boolean> {
  return clickFirst(page, [/^submit$|submit application|submit request/i, /^continue$|^next$/i, /apply now/i], ["button"]);
}

export async function fillAdGrantsActivation(page: Page): Promise<FillReport> {
  assertAllowedUrl(AD_GRANTS_ACTIVATION_URL);
  await page.goto(AD_GRANTS_ACTIVATION_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page);
  assertSignedIn(page);
  const notes: string[] = [];
  if (await clickFirst(page, [/get started|activate|apply/i], ["link", "button"])) notes.push("Opened the Ad Grants activation from the Ad Grants page.");
  assertSignedIn(page);
  const accept = await fillField(page, { key: "accept_terms", label: "Accept the Ad Grants terms", patterns: [/agree|accept|policies|terms/i], kind: "checkbox" });
  return report(page, [accept], notes);
}

export async function clickActivate(page: Page): Promise<boolean> {
  return clickFirst(page, [/^activate$|activate ad grants/i, /get started|enroll|^submit$/i], ["button"]);
}

/** Read-only: does Google currently show the enrollment as pending,
 *  approved, or rejected? Never mutates anything. */
export async function readReviewStatus(
  page: Page
): Promise<{ status: "pending" | "approved" | "rejected"; reason?: string }> {
  assertAllowedUrl(NONPROFITS_URL);
  await page.goto(NONPROFITS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page);
  assertSignedIn(page);
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (/reject|declin|not approved|ineligible/.test(bodyText)) {
    return { status: "rejected", reason: "Google's account page indicates the enrollment was not approved." };
  }
  if (/approved|active|welcome back/.test(bodyText)) {
    return { status: "approved" };
  }
  return { status: "pending" };
}
