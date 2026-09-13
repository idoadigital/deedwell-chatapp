/**
 * Ad Grants compliance as data: the rules live in google_ads_compliance_rules
 * (an administrator enables each one and sets its threshold from Google's
 * current policy); this module only computes the metrics those rules refer
 * to and compares. A rule without a threshold reports "unconfigured".
 */
export interface ComplianceRule {
  key: string; label: string; description: string; metric: string;
  comparator: "gte" | "lte" | "gt" | "lt" | "eq"; threshold: number | null; windowDays: number;
  enabled: boolean; sourceUrl: string | null;
}

export interface ComplianceInput {
  /** Account-level totals over the rule window. */
  impressions: number; clicks: number; conversions: number;
  keywords: Array<{ text: string; status: string | null; negative: boolean; qualityScore: number | null }>;
  ads: Array<{ status: string; adGroupId: string; approvalStatus: string | null }>;
  adGroups: Array<{ adGroupId: string; status: string }>;
  lastActivityAt: Date | null;
  now?: Date;
}

export type ComplianceMetricKey =
  | "account_ctr_percent" | "conversions_total" | "low_quality_keyword_percent" | "single_word_keyword_count"
  | "days_since_activity" | "disapproved_ad_count" | "min_ads_per_ad_group";

export function computeComplianceMetrics(input: ComplianceInput): Record<ComplianceMetricKey, number | null> {
  const enabledKeywords = input.keywords.filter((k) => !k.negative && (k.status ?? "ENABLED") === "ENABLED");
  const scored = enabledKeywords.filter((k) => k.qualityScore != null);
  const lowQuality = scored.filter((k) => (k.qualityScore ?? 10) <= 2).length;
  const singleWord = enabledKeywords.filter((k) => k.text.trim().split(/\s+/).length === 1).length;
  const disapproved = input.ads.filter((a) => a.status === "ENABLED" && a.approvalStatus && a.approvalStatus !== "APPROVED").length;
  const enabledGroups = input.adGroups.filter((g) => g.status === "ENABLED");
  const adsPerGroup = enabledGroups.map((g) => input.ads.filter((a) => a.adGroupId === g.adGroupId && a.status === "ENABLED").length);
  const now = input.now ?? new Date();
  return {
    account_ctr_percent: input.impressions > 0 ? (input.clicks / input.impressions) * 100 : null,
    conversions_total: input.conversions,
    low_quality_keyword_percent: scored.length ? (lowQuality / scored.length) * 100 : null,
    single_word_keyword_count: singleWord,
    days_since_activity: input.lastActivityAt ? Math.floor((now.getTime() - input.lastActivityAt.getTime()) / 86_400_000) : null,
    disapproved_ad_count: disapproved,
    min_ads_per_ad_group: adsPerGroup.length ? Math.min(...adsPerGroup) : null,
  };
}

export interface ComplianceResult {
  key: string; label: string; description: string; metric: string; comparator: ComplianceRule["comparator"];
  threshold: number | null; value: number | null; windowDays: number; sourceUrl: string | null;
  status: "pass" | "fail" | "unknown" | "unconfigured" | "disabled";
}

export function evaluateComplianceRules(rules: ComplianceRule[], values: Record<string, number | null>): ComplianceResult[] {
  return rules.map((rule) => {
    const value = values[rule.metric] ?? null;
    let status: ComplianceResult["status"];
    if (!rule.enabled) status = "disabled";
    else if (rule.threshold == null) status = "unconfigured";
    else if (value == null) status = "unknown";
    else status = compare(value, rule.comparator, rule.threshold) ? "pass" : "fail";
    return {
      key: rule.key, label: rule.label, description: rule.description, metric: rule.metric, comparator: rule.comparator,
      threshold: rule.threshold, value, windowDays: rule.windowDays, sourceUrl: rule.sourceUrl, status,
    };
  });
}

function compare(value: number, comparator: ComplianceRule["comparator"], threshold: number): boolean {
  switch (comparator) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "eq": return value === threshold;
  }
}
