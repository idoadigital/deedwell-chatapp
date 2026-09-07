import type { Page } from "playwright";
import { assertAllowedUrl } from "./allowlist.js";
import { assertSignedIn, clickFirst, fillField, report, settle, type FieldResult, type FillReport } from "./fill.js";

/**
 * Builds a campaign in the Google Ads UI from an approved campaign plan, up
 * to but never including the final "Enable" click. Same selector-validation
 * caveat as nonprofits-flow.ts: written against Ads' documented campaign
 * builder structure, not validated against the live product from this
 * environment. Defensive by construction — every locator checks `.count()`
 * before acting.
 */

const ADS_NEW_CAMPAIGN_URL = "https://ads.google.com/aw/campaigns/new";

interface CampaignPlan {
  campaignName: string;
  dailyBudgetUsd: number;
  adGroups: Array<{
    name: string;
    keywords: string[];
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
  }>;
  sitelinks: Array<{ text: string; url: string }>;
  geoTargets: string[];
}

export async function buildCampaign(page: Page, plan: CampaignPlan): Promise<FillReport> {
  assertAllowedUrl(ADS_NEW_CAMPAIGN_URL);
  await page.goto(ADS_NEW_CAMPAIGN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await settle(page);
  assertSignedIn(page);
  const results: FieldResult[] = [];
  const notes: string[] = [];
  if (await clickFirst(page, [/new campaign|create campaign/i], ["button", "link"])) notes.push("Started a new campaign from the Ads overview.");

  results.push(await fillField(page, { key: "campaignName", label: "Campaign name", patterns: [/campaign name/i], value: plan.campaignName }));
  results.push(await fillField(page, { key: "dailyBudgetUsd", label: "Daily budget", patterns: [/daily budget|budget/i], value: String(plan.dailyBudgetUsd) }));

  for (const [i, geo] of plan.geoTargets.entries()) {
    const r = await fillField(page, { key: `geo${i + 1}`, label: `Location ${i + 1}`, patterns: [/location/i, /target/i], value: geo });
    if (r.status === "filled") await page.keyboard.press("Enter").catch(() => {});
    results.push(r);
  }

  for (const group of plan.adGroups) {
    const addGroup = page.getByRole("button", { name: /add ad group|new ad group/i });
    if (await addGroup.count()) await addGroup.first().click();

    const groupNameField = page.getByLabel(/ad group name/i);
    if (await groupNameField.count()) await groupNameField.last().fill(group.name);

    const keywordsField = page.getByLabel(/keywords/i);
    if (await keywordsField.count()) await keywordsField.last().fill(group.keywords.join("\n"));

    const finalUrlField = page.getByLabel(/final url/i);
    if (await finalUrlField.count()) await finalUrlField.last().fill(group.finalUrl);

    for (const headline of group.headlines) {
      const headlineField = page.getByLabel(/headline/i);
      if (await headlineField.count()) await headlineField.last().fill(headline);
    }
    for (const description of group.descriptions) {
      const descField = page.getByLabel(/description/i);
      if (await descField.count()) await descField.last().fill(description);
    }
  }

  for (const link of plan.sitelinks) {
    const addSitelink = page.getByRole("button", { name: /add sitelink/i });
    if (await addSitelink.count()) await addSitelink.first().click();
    const textField = page.getByLabel(/sitelink text/i);
    if (await textField.count()) await textField.last().fill(link.text);
    const urlField = page.getByLabel(/sitelink.*url/i);
    if (await urlField.count()) await urlField.last().fill(link.url);
  }
  results.push({ key: "adGroups", label: "Ad groups", status: plan.adGroups.length ? "unverified" : "empty", note: `${plan.adGroups.length} ad group(s) entered; verify in the Ads UI before enabling.` });
  return report(page, results, notes);
}

/** The one irrevocable click — the workflow only calls this after its own
 *  approval-gate re-verification, never inline with buildCampaign(). */
export async function clickEnableCampaign(page: Page): Promise<string | null> {
  const enable = page.getByRole("button", { name: /^enable$|publish campaign/i });
  if (await enable.count()) await enable.first().click();
  const idMatch = page.url().match(/campaignId=(\d+)/);
  return idMatch?.[1] ?? null;
}
