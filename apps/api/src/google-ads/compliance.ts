/** Loads the configurable Ad Grants rules and evaluates them for one account. */
import { computeComplianceMetrics, evaluateComplianceRules, type ComplianceRule } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { AccountRow } from "./store.js";

export async function loadComplianceRules(client: { query: PoolClient["query"] }): Promise<ComplianceRule[]> {
  const { rows } = await client.query(`SELECT * FROM google_ads_compliance_rules ORDER BY label`);
  return rows.map((r) => ({
    key: r.key, label: r.label, description: r.description, metric: r.metric, comparator: r.comparator,
    threshold: r.threshold != null ? Number(r.threshold) : null, windowDays: Number(r.window_days), enabled: Boolean(r.enabled), sourceUrl: r.source_url ?? null,
  }));
}

export async function complianceReport(client: PoolClient, account: AccountRow) {
  const rules = await loadComplianceRules(client);
  const windowDays = Math.max(7, ...rules.map((r) => r.windowDays));
  const { rows: totals } = await client.query(
    `SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(conversions),0) conversions
       FROM google_ads_metrics_daily WHERE account_id = $1 AND level = 'account' AND day >= (CURRENT_DATE - $2::int)`, [account.id, windowDays]);
  const { rows: keywords } = await client.query(`SELECT text, status, negative, quality_score FROM google_ads_keywords WHERE account_id = $1`, [account.id]);
  const { rows: ads } = await client.query(`SELECT status, ad_group_id, approval_status FROM google_ads_ads WHERE account_id = $1`, [account.id]);
  const { rows: groups } = await client.query(`SELECT ad_group_id, status FROM google_ads_ad_groups WHERE account_id = $1`, [account.id]);
  const { rows: activity } = await client.query(`SELECT MAX(created_at) AS last FROM google_ads_activity WHERE account_id = $1`, [account.id]);
  const values = computeComplianceMetrics({
    impressions: Number(totals[0]?.impressions ?? 0), clicks: Number(totals[0]?.clicks ?? 0), conversions: Number(totals[0]?.conversions ?? 0),
    keywords: keywords.map((k) => ({ text: k.text, status: k.status, negative: k.negative, qualityScore: k.quality_score })),
    ads: ads.map((a) => ({ status: a.status, adGroupId: a.ad_group_id, approvalStatus: a.approval_status })),
    adGroups: groups.map((g) => ({ adGroupId: g.ad_group_id, status: g.status })),
    lastActivityAt: activity[0]?.last ?? account.last_sync_at ?? null,
  });
  const results = evaluateComplianceRules(rules, values);
  return {
    applies: account.account_kind === "ad_grants",
    windowDays,
    results,
    summary: { pass: results.filter((r) => r.status === "pass").length, fail: results.filter((r) => r.status === "fail").length, unconfigured: results.filter((r) => r.status === "unconfigured").length },
  };
}
