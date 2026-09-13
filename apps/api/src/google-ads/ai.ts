/**
 * AI assistance, strictly proposal-only. Both agents see exactly one
 * organization's context (mission profile, website pages, performance
 * snapshots) and write rows an administrator then reviews. There is no code
 * path from here to a Google Ads mutation.
 */
import { runAgentTask } from "@deedwell/agent-runtime";
import { loadMissionProfile, uuidv7 } from "@deedwell/database";
import {
  adsCampaignBuilder, adsStrategist, validateAd, validateDraft, type DraftAdContent, type DraftContent,
} from "@deedwell/google-ads-domain";
import type { GoogleAdsCampaignDraftOutput, GoogleAdsStrategyOutput } from "@deedwell/schemas";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { resolveRange, derive } from "./reports.js";
import { logActivity, type AccountRow } from "./store.js";

const SITES_BASE_DOMAIN = process.env.SITES_BASE_DOMAIN ?? "deedwell.org";

export interface AdsContext {
  organization: {
    name: string; mission: string | null; websiteUrl: string | null; location: string | null;
    facts: Array<{ key: string; value: string }>; knowledge: Array<{ title: string; excerpt: string }>;
    pages: Array<{ url: string; title: string; summary: string }>;
  };
  account: { customerId: string; currencyCode: string; accountKind: string; timeZone: string | null };
  performance: { windowDays: number } & ReturnType<typeof derive>;
  campaigns: Array<{ name: string; status: string; dailyBudget: number | null; metrics: ReturnType<typeof derive> }>;
  keywords: Array<{ text: string; matchType: string | null; negative: boolean; qualityScore: number | null }>;
  pastAds: Array<{ headlines: string[]; descriptions: string[]; finalUrl: string | null; status: string }>;
}

const textOfBlocks = (blocks: unknown): string => {
  if (!Array.isArray(blocks)) return "";
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (v.length > 2 && !/^https?:/.test(v)) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(blocks);
  return out.join(" ").replace(/\s+/g, " ").slice(0, 600);
};

/** Only this organization's data. The tenant transaction plus RLS make it
 *  impossible to read another tenant's rows here even by mistake. */
export async function buildAdsContext(deps: Deps, client: PoolClient, tenantId: string, account: AccountRow): Promise<AdsContext> {
  const profile = await loadMissionProfile(client, deps.storage, tenantId);
  const fact = (key: string) => profile.facts.find((f) => f.key === key)?.value ?? null;
  const { rows: pageRows } = await client.query(
    `SELECT s.slug AS site_slug, s.status AS site_status, p.slug, p.title, p.blocks, p.seo
       FROM sites s JOIN site_pages p ON p.site_id = s.id
      WHERE s.tenant_id = $1 AND s.status IN ('published','preview') ORDER BY s.status = 'published' DESC, p.order_idx LIMIT 24`, [tenantId]);
  const websiteUrl = fact("website_url");
  const pages = pageRows.map((p) => {
    const base = websiteUrl ? websiteUrl.replace(/\/+$/, "") : `https://${p.site_slug}.${SITES_BASE_DOMAIN}`;
    const url = p.slug === "home" || p.slug === "index" || p.slug === "" ? `${base}/` : `${base}/${p.slug}`;
    return { url, title: p.title, summary: String(p.seo?.description ?? "") || textOfBlocks(p.blocks) };
  });
  const range = resolveRange({ range: "30d" });
  const { rows: totals } = await client.query(
    `SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(cost_micros),0) cost_micros,
            COALESCE(SUM(conversions),0) conversions, COALESCE(SUM(conversions_value),0) conversions_value
       FROM google_ads_metrics_daily WHERE account_id = $1 AND level = 'account' AND day BETWEEN $2 AND $3`, [account.id, range.since, range.until]);
  const t = totals[0] ?? {};
  const performance = { windowDays: 30, ...derive({ impressions: Number(t.impressions ?? 0), clicks: Number(t.clicks ?? 0), costMicros: Number(t.cost_micros ?? 0), conversions: Number(t.conversions ?? 0), conversionsValue: Number(t.conversions_value ?? 0) }) };
  const { rows: campaigns } = await client.query(
    `SELECT c.name, c.status, c.budget_micros, m.impressions, m.clicks, m.cost_micros, m.conversions, m.conversions_value
       FROM google_ads_campaigns c LEFT JOIN LATERAL (
         SELECT SUM(impressions) impressions, SUM(clicks) clicks, SUM(cost_micros) cost_micros, SUM(conversions) conversions, SUM(conversions_value) conversions_value
           FROM google_ads_metrics_daily md WHERE md.account_id = c.account_id AND md.level = 'campaign' AND md.entity_id = c.campaign_id AND md.day BETWEEN $2 AND $3) m ON true
      WHERE c.account_id = $1 AND c.status <> 'REMOVED' ORDER BY m.cost_micros DESC NULLS LAST LIMIT 20`, [account.id, range.since, range.until]);
  const { rows: keywords } = await client.query(
    `SELECT text, match_type, negative, quality_score FROM google_ads_keywords WHERE account_id = $1 ORDER BY negative, quality_score DESC NULLS LAST LIMIT 80`, [account.id]);
  const { rows: ads } = await client.query(
    `SELECT headlines, descriptions, final_urls, status FROM google_ads_ads WHERE account_id = $1 AND status <> 'REMOVED' ORDER BY synced_at DESC LIMIT 20`, [account.id]);
  return {
    organization: {
      name: profile.orgName, mission: fact("mission"), websiteUrl, location: fact("hq_location"),
      facts: profile.facts.filter((f) => !f.key.startsWith("brand_")).map((f) => ({ key: f.key, value: f.value })),
      knowledge: profile.notes.map((n) => ({ title: n.title, excerpt: n.text.slice(0, 1200) })),
      pages,
    },
    account: { customerId: account.customer_id, currencyCode: account.currency_code ?? "USD", accountKind: account.account_kind ?? "unknown", timeZone: account.time_zone ?? null },
    performance,
    campaigns: campaigns.map((c) => ({ name: c.name, status: c.status, dailyBudget: c.budget_micros != null ? Number(c.budget_micros) / 1_000_000 : null,
      metrics: derive({ impressions: Number(c.impressions ?? 0), clicks: Number(c.clicks ?? 0), costMicros: Number(c.cost_micros ?? 0), conversions: Number(c.conversions ?? 0), conversionsValue: Number(c.conversions_value ?? 0) }) })),
    keywords: keywords.map((k) => ({ text: k.text, matchType: k.match_type, negative: k.negative, qualityScore: k.quality_score })),
    pastAds: ads.map((a) => ({ headlines: a.headlines ?? [], descriptions: a.descriptions ?? [], finalUrl: a.final_urls?.[0] ?? null, status: a.status })),
  };
}

async function meter(client: PoolClient, tenantId: string, agentKey: string, tokens: number, purpose: string): Promise<void> {
  await client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',$3,$4)`,
    [uuidv7(), tenantId, Math.max(0, Math.round(tokens)), JSON.stringify({ agentKey, source: "google_ads", purpose })]);
}

function contextBlocks(ctx: AdsContext) {
  return [
    { label: "organization", content: JSON.stringify(ctx.organization) },
    { label: "account", content: JSON.stringify(ctx.account) },
    { label: "performance_30d", content: JSON.stringify(ctx.performance) },
    { label: "campaigns", content: JSON.stringify(ctx.campaigns) },
    { label: "keywords", content: JSON.stringify(ctx.keywords) },
    { label: "past_ads", content: JSON.stringify(ctx.pastAds) },
  ];
}

export async function generateStrategy(deps: Deps, client: PoolClient, tenantId: string, account: AccountRow, actorUserId: string, opts: { instructions?: string } = {}) {
  const ctx = await buildAdsContext(deps, client, tenantId, account);
  const { rows: prior } = await client.query(
    `SELECT title, content FROM google_ads_strategies WHERE account_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 1`, [account.id]);
  const grants = account.account_kind === "ad_grants" ? " This is a Google Ad Grants account: every recommendation must comply with Ad Grants policy." : "";
  const result = await runAgentTask<GoogleAdsStrategyOutput>(
    deps.provider, adsStrategist,
    `Propose a Google Ads strategy for ${ctx.organization.name}.${grants}${opts.instructions ? ` Administrator guidance: ${opts.instructions}` : ""}`,
    [...contextBlocks(ctx), ...(prior[0] ? [{ label: "previous_strategy", content: JSON.stringify(prior[0]) }] : [])],
  );
  await meter(client, tenantId, adsStrategist.agentKey, result.tokensEstimated, "strategy");
  const { rows: v } = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM google_ads_strategies WHERE account_id = $1`, [account.id]);
  const id = uuidv7();
  const { title, ...content } = result.output;
  await client.query(
    `INSERT INTO google_ads_strategies (id, tenant_id, account_id, version, status, title, content, model_meta, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8)`,
    [id, tenantId, account.id, Number(v[0].next), title, JSON.stringify(content),
      JSON.stringify({ provider: deps.provider.name, agentKey: adsStrategist.agentKey, tokens: result.tokensEstimated, attempts: result.attempts, instructions: opts.instructions ?? null }), actorUserId]);
  await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "ai", action: "strategy_generated", entityType: "strategy", entityId: id, newState: "draft", summary: title });
  return loadStrategy(client, id);
}

export async function loadStrategy(client: PoolClient, id: string) {
  const { rows } = await client.query(
    `SELECT s.*, c.display_name AS created_by_name, a.display_name AS approved_by_name
       FROM google_ads_strategies s LEFT JOIN users c ON c.id = s.created_by LEFT JOIN users a ON a.id = s.approved_by WHERE s.id = $1`, [id]);
  return rows[0] ? strategyView(rows[0]) : null;
}

export function strategyView(r: Record<string, any>) {
  return {
    id: r.id, version: r.version, status: r.status, title: r.title, content: r.content ?? {},
    createdBy: r.created_by_name ?? null, approvedBy: r.approved_by_name ?? null, approvedAt: r.approved_at, archivedAt: r.archived_at,
    createdAt: r.created_at, updatedAt: r.updated_at, model: r.model_meta?.provider ?? null,
  };
}

const keyFor = (name: string, index: number) => `${index + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "group"}`;

/** From an approved strategy: one campaign draft plus its ads, all awaiting
 *  approval. Validation is stored alongside so the review UI shows it. */
export async function generateCampaignDraft(
  deps: Deps, client: PoolClient, tenantId: string, account: AccountRow, strategyId: string, actorUserId: string,
  opts: { campaignIndex?: number; instructions?: string } = {},
) {
  const { rows } = await client.query(`SELECT * FROM google_ads_strategies WHERE id = $1 AND account_id = $2`, [strategyId, account.id]);
  const strategy = rows[0];
  if (!strategy) throw new Error("Strategy not found");
  if (strategy.status !== "approved") throw new Error("Only an approved strategy can generate campaigns");
  const ctx = await buildAdsContext(deps, client, tenantId, account);
  const focus = strategy.content?.campaigns?.[opts.campaignIndex ?? 0] ?? null;
  const grants = account.account_kind === "ad_grants" ? " This is a Google Ad Grants account: keep within Ad Grants policy (no single-word keywords except the brand, daily budget at most $329)." : "";
  const result = await runAgentTask<GoogleAdsCampaignDraftOutput>(
    deps.provider, adsCampaignBuilder,
    `Build the campaign${focus ? ` "${focus.name}"` : ""} from the approved strategy for ${ctx.organization.name}.${grants}${opts.instructions ? ` Administrator guidance: ${opts.instructions}` : ""}`,
    [...contextBlocks(ctx), { label: "strategy", content: JSON.stringify({ title: strategy.title, ...strategy.content }) }, ...(focus ? [{ label: "campaign_focus", content: JSON.stringify(focus) }] : [])],
  );
  await meter(client, tenantId, adsCampaignBuilder.agentKey, result.tokensEstimated, "campaign_draft");
  const out = result.output;
  const content: DraftContent = {
    objective: out.objective, channelType: "SEARCH", landingPage: out.landingPage, dailyBudgetMicros: out.dailyBudgetMicros,
    currencyCode: account.currency_code ?? "USD",
    adGroups: out.adGroups.map((g, i) => ({ key: keyFor(g.name, i), name: g.name, keywords: g.keywords, negativeKeywords: g.negativeKeywords })),
    negativeKeywords: out.negativeKeywords, geoTargets: out.geoTargets, rationale: out.rationale,
  };
  const ads: DraftAdContent[] = out.adGroups.flatMap((g, i) => g.ads.map((ad) => ({
    adGroupKey: keyFor(g.name, i), title: ad.title, headlines: ad.headlines, descriptions: ad.descriptions, finalUrl: ad.finalUrl,
    path1: ad.path1 ?? null, path2: ad.path2 ?? null, rationale: ad.rationale ?? null,
  })));
  const validation = validateDraft({ ...content, ...({ name: out.name } as object) }, ads, { accountKind: account.account_kind });
  const draftId = uuidv7();
  await client.query(
    `INSERT INTO google_ads_drafts (id, tenant_id, account_id, strategy_id, status, name, content, validation, model_meta, created_by)
     VALUES ($1,$2,$3,$4,'awaiting_approval',$5,$6,$7,$8,$9)`,
    [draftId, tenantId, account.id, strategyId, out.name, JSON.stringify(content), JSON.stringify(validation),
      JSON.stringify({ provider: deps.provider.name, agentKey: adsCampaignBuilder.agentKey, tokens: result.tokensEstimated, attempts: result.attempts, campaignIndex: opts.campaignIndex ?? 0 }), actorUserId]);
  let position = 0;
  for (const ad of ads) {
    const adValidation = validateAd(ad);
    await client.query(
      `INSERT INTO google_ads_draft_ads (id, tenant_id, account_id, draft_id, ad_group_key, position, title, headlines, descriptions, final_url, path1, path2, rationale, status, validation, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_approval',$14,$15)`,
      [uuidv7(), tenantId, account.id, draftId, ad.adGroupKey, position++, ad.title, JSON.stringify(ad.headlines), JSON.stringify(ad.descriptions), ad.finalUrl,
        ad.path1, ad.path2, ad.rationale, JSON.stringify({ ok: adValidation.every((i) => i.level !== "error"), issues: adValidation }), actorUserId]);
  }
  await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "ai", action: "campaign_generated", entityType: "draft", entityId: draftId, newState: "awaiting_approval", summary: out.name, metadata: { strategyId, ads: ads.length } });
  return draftId;
}

/** Rewrites one ad in place using the same builder, keeping everything else. */
export async function regenerateDraftAd(deps: Deps, client: PoolClient, tenantId: string, account: AccountRow, draftId: string, adId: string, actorUserId: string, instructions?: string) {
  const { rows: drafts } = await client.query(`SELECT * FROM google_ads_drafts WHERE id = $1 AND account_id = $2`, [draftId, account.id]);
  const draft = drafts[0];
  if (!draft) throw new Error("Draft not found");
  const { rows: adRows } = await client.query(`SELECT * FROM google_ads_draft_ads WHERE id = $1 AND draft_id = $2`, [adId, draftId]);
  const current = adRows[0];
  if (!current) throw new Error("Ad not found");
  const content = draft.content as DraftContent;
  const group = content.adGroups.find((g) => g.key === current.ad_group_key);
  const ctx = await buildAdsContext(deps, client, tenantId, account);
  const result = await runAgentTask<GoogleAdsCampaignDraftOutput>(
    deps.provider, adsCampaignBuilder,
    `Rewrite ONE responsive search ad for the ad group "${group?.name ?? current.ad_group_key}" of campaign "${draft.name}". Return the campaign with only that ad group and a single new ad in it.${instructions ? ` Reviewer guidance: ${instructions}` : ""}`,
    [...contextBlocks(ctx), { label: "campaign", content: JSON.stringify({ name: draft.name, ...content, adGroups: group ? [group] : content.adGroups }) },
      { label: "current_ad", content: JSON.stringify({ headlines: current.headlines, descriptions: current.descriptions, finalUrl: current.final_url }) }],
  );
  await meter(client, tenantId, adsCampaignBuilder.agentKey, result.tokensEstimated, "ad_regenerate");
  const fresh = result.output.adGroups[0]?.ads[0];
  if (!fresh) throw new Error("The model returned no ad");
  const ad: DraftAdContent = { adGroupKey: current.ad_group_key, title: fresh.title, headlines: fresh.headlines, descriptions: fresh.descriptions, finalUrl: fresh.finalUrl, path1: fresh.path1 ?? null, path2: fresh.path2 ?? null, rationale: fresh.rationale ?? null };
  const issues = validateAd(ad);
  await client.query(
    `UPDATE google_ads_draft_ads SET title = $2, headlines = $3, descriptions = $4, final_url = $5, path1 = $6, path2 = $7, rationale = $8,
            status = 'awaiting_approval', approved_by = NULL, approved_at = NULL, rejected_reason = NULL, validation = $9, edited_by = $10 WHERE id = $1`,
    [adId, ad.title, JSON.stringify(ad.headlines), JSON.stringify(ad.descriptions), ad.finalUrl, ad.path1, ad.path2, ad.rationale,
      JSON.stringify({ ok: issues.every((i) => i.level !== "error"), issues }), actorUserId]);
  await revalidateDraft(client, draft.id, account.account_kind);
  await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "ai", action: "ad_regenerated", entityType: "draft_ad", entityId: adId, newState: "awaiting_approval", summary: ad.title });
}

/** Recomputes the campaign-level validation after any edit. */
export async function revalidateDraft(client: PoolClient, draftId: string, accountKind: string): Promise<void> {
  const { rows: drafts } = await client.query(`SELECT * FROM google_ads_drafts WHERE id = $1`, [draftId]);
  const draft = drafts[0];
  if (!draft) return;
  const { rows: ads } = await client.query(`SELECT * FROM google_ads_draft_ads WHERE draft_id = $1 AND status <> 'rejected' ORDER BY position`, [draftId]);
  const validation = validateDraft({ ...(draft.content as DraftContent), ...({ name: draft.name } as object) },
    ads.map((a) => ({ adGroupKey: a.ad_group_key, title: a.title, headlines: a.headlines, descriptions: a.descriptions, finalUrl: a.final_url, path1: a.path1, path2: a.path2 })),
    { accountKind: accountKind as "unknown" | "standard" | "ad_grants" });
  await client.query(`UPDATE google_ads_drafts SET validation = $2 WHERE id = $1`, [draftId, JSON.stringify(validation)]);
}
