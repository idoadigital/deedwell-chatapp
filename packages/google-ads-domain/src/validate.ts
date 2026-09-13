/**
 * Google Ads field rules for what Deedwell publishes. These are Google's
 * structural limits (an ad with a 31-character headline is rejected by the
 * API), enforced here so a draft can be checked long before publishing and
 * the review UI can show live counters against the same numbers.
 *
 * Ad Grants *policy* expectations are reported as warnings, never errors:
 * they are program rules Google revises, so they inform the reviewer rather
 * than block them.
 */
import type { DraftAdContent, DraftContent } from "./types.js";

export const RSA_LIMITS = {
  headline: { max: 30, min: 3, maxCount: 15 },
  description: { max: 90, min: 2, maxCount: 4 },
  path: { max: 15 },
  campaignName: { max: 255 },
  adGroupName: { max: 255 },
  keyword: { max: 80, maxWords: 10 },
  /** Google Ad Grants: $10,000/month ≈ $329/day. */
  adGrantsDailyBudgetUsd: 329,
} as const;

export interface ValidationIssue { path: string; message: string; level: "error" | "warning" }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

const MATCH_TYPES = new Set(["BROAD", "PHRASE", "EXACT"]);

export function validateUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "Landing page must be an http(s) URL.";
    return null;
  } catch {
    return "Landing page is not a valid URL.";
  }
}

export function validateAd(ad: DraftAdContent, path = "ad"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const headlines = (ad.headlines ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);
  const descriptions = (ad.descriptions ?? []).map((d) => String(d ?? "").trim()).filter(Boolean);
  if (headlines.length < RSA_LIMITS.headline.min) issues.push({ path: `${path}.headlines`, level: "error", message: `At least ${RSA_LIMITS.headline.min} headlines are required.` });
  if (headlines.length > RSA_LIMITS.headline.maxCount) issues.push({ path: `${path}.headlines`, level: "error", message: `At most ${RSA_LIMITS.headline.maxCount} headlines are allowed.` });
  headlines.forEach((h, i) => {
    if (h.length > RSA_LIMITS.headline.max) issues.push({ path: `${path}.headlines[${i}]`, level: "error", message: `Headline ${i + 1} is ${h.length} characters; the limit is ${RSA_LIMITS.headline.max}.` });
    if (/[!]{2,}|[A-Z]{6,}/.test(h)) issues.push({ path: `${path}.headlines[${i}]`, level: "warning", message: `Headline ${i + 1} may fail Google's editorial policy (excessive punctuation or capitals).` });
  });
  if (new Set(headlines.map((h) => h.toLowerCase())).size !== headlines.length) issues.push({ path: `${path}.headlines`, level: "error", message: "Headlines must be unique." });
  if (descriptions.length < RSA_LIMITS.description.min) issues.push({ path: `${path}.descriptions`, level: "error", message: `At least ${RSA_LIMITS.description.min} descriptions are required.` });
  if (descriptions.length > RSA_LIMITS.description.maxCount) issues.push({ path: `${path}.descriptions`, level: "error", message: `At most ${RSA_LIMITS.description.maxCount} descriptions are allowed.` });
  descriptions.forEach((d, i) => {
    if (d.length > RSA_LIMITS.description.max) issues.push({ path: `${path}.descriptions[${i}]`, level: "error", message: `Description ${i + 1} is ${d.length} characters; the limit is ${RSA_LIMITS.description.max}.` });
  });
  if (new Set(descriptions.map((d) => d.toLowerCase())).size !== descriptions.length) issues.push({ path: `${path}.descriptions`, level: "error", message: "Descriptions must be unique." });
  const urlProblem = validateUrl(String(ad.finalUrl ?? ""));
  if (urlProblem) issues.push({ path: `${path}.finalUrl`, level: "error", message: urlProblem });
  for (const [key, value] of [["path1", ad.path1], ["path2", ad.path2]] as const) {
    if (value && String(value).length > RSA_LIMITS.path.max) issues.push({ path: `${path}.${key}`, level: "error", message: `Display path "${key}" exceeds ${RSA_LIMITS.path.max} characters.` });
    if (value && /[\s/]/.test(String(value))) issues.push({ path: `${path}.${key}`, level: "error", message: `Display path "${key}" cannot contain spaces or slashes.` });
  }
  if (ad.path2 && !ad.path1) issues.push({ path: `${path}.path2`, level: "error", message: "Path 2 requires Path 1." });
  return issues;
}

export function validateKeywordText(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t) return "Keyword is empty.";
  if (t.length > RSA_LIMITS.keyword.max) return `Keyword exceeds ${RSA_LIMITS.keyword.max} characters.`;
  if (t.split(/\s+/).length > RSA_LIMITS.keyword.maxWords) return `Keyword exceeds ${RSA_LIMITS.keyword.maxWords} words.`;
  if (/[!@%^*()=\{\}~;:'<>?,]/.test(t)) return "Keyword contains characters Google does not allow.";
  return null;
}

export function validateDraft(
  content: DraftContent,
  ads: DraftAdContent[],
  opts: { accountKind?: "unknown" | "standard" | "ad_grants" } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const name = String((content as unknown as { name?: string }).name ?? "");
  if (name.length > RSA_LIMITS.campaignName.max) issues.push({ path: "name", level: "error", message: "Campaign name is too long." });
  if (!(content.dailyBudgetMicros > 0)) issues.push({ path: "dailyBudgetMicros", level: "error", message: "A positive daily budget is required." });
  if (content.dailyBudgetMicros % 10_000 !== 0) issues.push({ path: "dailyBudgetMicros", level: "warning", message: "Google rounds budgets to the nearest cent." });
  const landing = validateUrl(content.landingPage ?? "");
  if (landing) issues.push({ path: "landingPage", level: "error", message: landing });
  if (!content.adGroups?.length) issues.push({ path: "adGroups", level: "error", message: "At least one ad group is required." });

  const keys = new Set<string>();
  content.adGroups?.forEach((g, gi) => {
    if (!g.key) issues.push({ path: `adGroups[${gi}].key`, level: "error", message: "Ad group key is missing." });
    if (keys.has(g.key)) issues.push({ path: `adGroups[${gi}].key`, level: "error", message: "Ad group keys must be unique." });
    keys.add(g.key);
    if (!g.name?.trim()) issues.push({ path: `adGroups[${gi}].name`, level: "error", message: "Ad group name is required." });
    if (g.name && g.name.length > RSA_LIMITS.adGroupName.max) issues.push({ path: `adGroups[${gi}].name`, level: "error", message: "Ad group name is too long." });
    if (!g.keywords?.length) issues.push({ path: `adGroups[${gi}].keywords`, level: "error", message: `Ad group "${g.name}" has no keywords.` });
    g.keywords?.forEach((k, ki) => {
      const problem = validateKeywordText(k.text);
      if (problem) issues.push({ path: `adGroups[${gi}].keywords[${ki}]`, level: "error", message: problem });
      if (!MATCH_TYPES.has(k.matchType)) issues.push({ path: `adGroups[${gi}].keywords[${ki}].matchType`, level: "error", message: "Match type must be BROAD, PHRASE or EXACT." });
      if (opts.accountKind === "ad_grants" && String(k.text).trim().split(/\s+/).length === 1) {
        issues.push({ path: `adGroups[${gi}].keywords[${ki}]`, level: "warning", message: `"${k.text}" is a single-word keyword; Ad Grants policy restricts these to brand names and permitted exceptions.` });
      }
    });
    g.negativeKeywords?.forEach((k, ki) => {
      const problem = validateKeywordText(k);
      if (problem) issues.push({ path: `adGroups[${gi}].negativeKeywords[${ki}]`, level: "error", message: problem });
    });
    const groupAds = ads.filter((a) => a.adGroupKey === g.key);
    if (!groupAds.length) issues.push({ path: `adGroups[${gi}]`, level: "error", message: `Ad group "${g.name}" has no ads.` });
    if (opts.accountKind === "ad_grants" && groupAds.length < 2) issues.push({ path: `adGroups[${gi}]`, level: "warning", message: `Ad Grants policy expects at least two ads in "${g.name}".` });
  });
  content.negativeKeywords?.forEach((k, ki) => {
    const problem = validateKeywordText(k);
    if (problem) issues.push({ path: `negativeKeywords[${ki}]`, level: "error", message: problem });
  });
  ads.forEach((ad, ai) => {
    if (!keys.has(ad.adGroupKey)) issues.push({ path: `ads[${ai}].adGroupKey`, level: "error", message: `Ad "${ad.title}" points at an ad group that does not exist.` });
    issues.push(...validateAd(ad, `ads[${ai}]`));
  });
  if (opts.accountKind === "ad_grants") {
    if ((content.adGroups?.length ?? 0) < 2) issues.push({ path: "adGroups", level: "warning", message: "Ad Grants policy expects at least two ad groups per campaign." });
    const dailyUsd = content.dailyBudgetMicros / 1_000_000;
    if (content.currencyCode === "USD" && dailyUsd > RSA_LIMITS.adGrantsDailyBudgetUsd) {
      issues.push({ path: "dailyBudgetMicros", level: "warning", message: `Daily budget exceeds the Ad Grants cap of $${RSA_LIMITS.adGrantsDailyBudgetUsd}.` });
    }
  }
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  return { ok: errors.length === 0, errors, warnings };
}
