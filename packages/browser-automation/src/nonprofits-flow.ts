import type { Page } from "playwright";
import { assertAllowedUrl } from "./allowlist.js";

/**
 * Google for Nonprofits enrollment + Ad Grants activation — deterministic
 * Playwright, never LLM-driven (see the design note in workflow.ts).
 *
 * IMPORTANT — selector completeness: the locators below target Google's
 * enrollment flow by visible label/role text, which is the most
 * change-resistant strategy available without a fixed markup contract to
 * pin to. They have NOT been validated against the live page from this
 * environment — no live browser access and no disposable Google account
 * were available while writing this. Every locator call is defensive
 * (checks `.count()` before acting, never throws on a miss) so a stale
 * selector degrades to "field left blank" rather than crashing the run, but
 * that is not a substitute for the plan's own build-order step: manual
 * validation against a disposable test account before this ever touches a
 * real one. runNonprofitsEnrollment() always screenshots its result so every
 * run leaves visual evidence a human reviewer can check before approving.
 */

const NONPROFITS_URL = "https://www.google.com/nonprofits/";
const AD_GRANTS_ACTIVATION_URL = "https://www.google.com/grants/";

async function fillByLabel(page: Page, label: string | RegExp, value: string | undefined): Promise<void> {
  if (!value) return;
  const field = page.getByLabel(label, { exact: false });
  if (await field.count()) await field.first().fill(value);
}

export async function fillNonprofitsEnrollment(page: Page, facts: Record<string, string>): Promise<void> {
  assertAllowedUrl(NONPROFITS_URL);
  await page.goto(NONPROFITS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await fillByLabel(page, /organization.*(legal )?name/i, facts.legal_name);
  await fillByLabel(page, /website/i, facts.website_url);
  await fillByLabel(page, /ein|tax id/i, facts.ein);
  await fillByLabel(page, /mission/i, facts.mission);
  await fillByLabel(page, /techsoup/i, facts.techsoup_validation_token);
}

export async function clickSubmitEnrollment(page: Page): Promise<void> {
  const submit = page.getByRole("button", { name: /submit|continue|apply now/i });
  if (await submit.count()) await submit.first().click();
}

export async function fillAdGrantsActivation(page: Page): Promise<void> {
  assertAllowedUrl(AD_GRANTS_ACTIVATION_URL);
  await page.goto(AD_GRANTS_ACTIVATION_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const accept = page.getByRole("checkbox", { name: /agree|accept|policies/i });
  if (await accept.count()) await accept.first().check();
}

export async function clickActivate(page: Page): Promise<void> {
  const activate = page.getByRole("button", { name: /activate|get started|enroll/i });
  if (await activate.count()) await activate.first().click();
}

/** Read-only: does Google currently show the enrollment as pending,
 *  approved, or rejected? Never mutates anything. */
export async function readReviewStatus(
  page: Page
): Promise<{ status: "pending" | "approved" | "rejected"; reason?: string }> {
  assertAllowedUrl(NONPROFITS_URL);
  await page.goto(NONPROFITS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (/reject|declin|not approved|ineligible/.test(bodyText)) {
    return { status: "rejected", reason: "Google's account page indicates the enrollment was not approved." };
  }
  if (/approved|active|welcome back/.test(bodyText)) {
    return { status: "approved" };
  }
  return { status: "pending" };
}
