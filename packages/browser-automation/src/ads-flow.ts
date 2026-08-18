import type { Page } from "playwright";
import { assertAllowedUrl } from "./allowlist.js";

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

export async function buildCampaign(page: Page, plan: CampaignPlan): Promise<void> {
  assertAllowedUrl(ADS_NEW_CAMPAIGN_URL);
  await page.goto(ADS_NEW_CAMPAIGN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const nameField = page.getByLabel(/campaign name/i);
  if (await nameField.count()) await nameField.first().fill(plan.campaignName);

  const budgetField = page.getByLabel(/daily budget/i);
  if (await budgetField.count()) await budgetField.first().fill(String(plan.dailyBudgetUsd));

  for (const geo of plan.geoTargets) {
    const geoField = page.getByLabel(/location/i);
    if (await geoField.count()) {
      await geoField.first().fill(geo);
      await page.keyboard.press("Enter").catch(() => {});
    }
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
}

/** The one irrevocable click — the workflow only calls this after its own
 *  approval-gate re-verification, never inline with buildCampaign(). */
export async function clickEnableCampaign(page: Page): Promise<string | null> {
  const enable = page.getByRole("button", { name: /^enable$|publish campaign/i });
  if (await enable.count()) await enable.first().click();
  const idMatch = page.url().match(/campaignId=(\d+)/);
  return idMatch?.[1] ?? null;
}
