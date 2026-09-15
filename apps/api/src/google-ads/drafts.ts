/** Draft views and the review actions (edit / approve / reject). */
import { validateAd, validateAsset, type DraftAdContent, type DraftAssetContent, type DraftContent } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import { revalidateDraft } from "./ai.js";
import { logActivity, type AccountRow } from "./store.js";

export async function listDrafts(client: PoolClient, accountId: string) {
  const { rows } = await client.query(
    `SELECT d.*, s.title AS strategy_title, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM google_ads_draft_ads a WHERE a.draft_id = d.id) AS ad_count,
            (SELECT COUNT(*) FROM google_ads_draft_ads a WHERE a.draft_id = d.id AND a.status = 'approved') AS approved_ads,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id) AS asset_count,
            (SELECT COUNT(*) FROM google_ads_draft_assets x WHERE x.draft_id = d.id AND x.kind = 'image' AND x.status = 'draft') AS images_pending
       FROM google_ads_drafts d LEFT JOIN google_ads_strategies s ON s.id = d.strategy_id LEFT JOIN users u ON u.id = d.created_by
      WHERE d.account_id = $1 ORDER BY d.created_at DESC`, [accountId]);
  return rows.map((d) => ({
    id: d.id, name: d.name, status: d.status, strategyId: d.strategy_id, strategyTitle: d.strategy_title, createdBy: d.created_by_name,
    createdAt: d.created_at, updatedAt: d.updated_at, adCount: Number(d.ad_count), approvedAds: Number(d.approved_ads),
    dailyBudget: d.content?.dailyBudgetMicros != null ? d.content.dailyBudgetMicros / 1_000_000 : null, currencyCode: d.content?.currencyCode ?? null,
    validationOk: d.validation?.ok ?? null, publishedCampaignId: d.published_campaign_id, publishJobId: d.publish_job_id,
    assetCount: Number(d.asset_count), imagesPending: Number(d.images_pending),
  }));
}

export async function loadDraft(client: PoolClient, accountId: string, draftId: string) {
  const { rows } = await client.query(
    `SELECT d.*, s.title AS strategy_title, s.content AS strategy_content, u.display_name AS created_by_name, ap.display_name AS approved_by_name
       FROM google_ads_drafts d LEFT JOIN google_ads_strategies s ON s.id = d.strategy_id
       LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users ap ON ap.id = d.approved_by
      WHERE d.id = $1 AND d.account_id = $2`, [draftId, accountId]);
  const d = rows[0];
  if (!d) return null;
  const { rows: ads } = await client.query(
    `SELECT a.*, u.display_name AS approved_by_name FROM google_ads_draft_ads a LEFT JOIN users u ON u.id = a.approved_by
      WHERE a.draft_id = $1 ORDER BY a.position`, [draftId]);
  const { rows: assets } = await client.query(
    `SELECT x.*, u.display_name AS approved_by_name FROM google_ads_draft_assets x LEFT JOIN users u ON u.id = x.approved_by
      WHERE x.draft_id = $1 ORDER BY x.kind, x.position`, [draftId]);
  const { rows: jobs } = await client.query(`SELECT * FROM google_ads_publish_jobs WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`, [draftId]);
  const { rows: builds } = await client.query(`SELECT * FROM google_ads_build_jobs WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`, [draftId]);
  return {
    id: d.id, name: d.name, status: d.status, content: d.content as DraftContent, validation: d.validation ?? {}, rationale: d.content?.rationale ?? null,
    strategy: d.strategy_id ? { id: d.strategy_id, title: d.strategy_title, content: d.strategy_content } : null,
    createdBy: d.created_by_name, approvedBy: d.approved_by_name, approvedAt: d.approved_at, rejectedReason: d.rejected_reason,
    publishedCampaignId: d.published_campaign_id, createdAt: d.created_at, updatedAt: d.updated_at, model: d.model_meta?.provider ?? null,
    ads: ads.map(adView),
    creatives: assets.map(assetView),
    creativesPending: assets.some((x) => x.kind === "image" && x.status === "draft") || Boolean(builds[0] && ["queued", "running"].includes(builds[0].status)),
    build: builds[0] ? { id: builds[0].id, status: builds[0].status, stage: builds[0].stage, error: builds[0].error } : null,
    lastJob: jobs[0] ? jobView(jobs[0]) : null,
  };
}

export function assetView(x: Record<string, any>) {
  const c = x.content ?? {};
  return {
    id: x.id, kind: x.kind, aspect: x.aspect, position: x.position, title: x.title, status: x.status, validation: x.validation ?? {}, error: x.error,
    linkText: c.linkText ?? null, description1: c.description1 ?? null, description2: c.description2 ?? null, finalUrl: c.finalUrl ?? null,
    text: c.text ?? null, prompt: c.prompt ?? null, altText: c.altText ?? null, model: c.model ?? null,
    image: x.storage_key ? { width: x.width, height: x.height, sizeBytes: x.size_bytes, mime: x.mime, version: x.updated_at } : null,
    approvedBy: x.approved_by_name ?? null, approvedAt: x.approved_at, rejectedReason: x.rejected_reason, updatedAt: x.updated_at,
    google: x.google_asset_id ? { assetId: x.google_asset_id } : null,
  };
}

/** The shape validateAsset and the publisher read from a row. */
export function assetContent(x: Record<string, any>): DraftAssetContent & { width?: number | null; height?: number | null; sizeBytes?: number | null } {
  const c = x.content ?? {};
  return { kind: x.kind, aspect: x.aspect, title: x.title, linkText: c.linkText, description1: c.description1 ?? null, description2: c.description2 ?? null, finalUrl: c.finalUrl, text: c.text, prompt: c.prompt, altText: c.altText ?? null, width: x.width, height: x.height, sizeBytes: x.size_bytes };
}

export function adView(a: Record<string, any>) {
  return {
    id: a.id, adGroupKey: a.ad_group_key, position: a.position, title: a.title, adType: a.ad_type, headlines: a.headlines ?? [], descriptions: a.descriptions ?? [],
    finalUrl: a.final_url, path1: a.path1, path2: a.path2, rationale: a.rationale, status: a.status, validation: a.validation ?? {},
    approvedBy: a.approved_by_name ?? null, approvedAt: a.approved_at, rejectedReason: a.rejected_reason, updatedAt: a.updated_at,
    google: a.google_ad_id ? { adId: a.google_ad_id, adGroupId: a.google_ad_group_id, campaignId: a.google_campaign_id } : null,
  };
}

export function jobView(j: Record<string, any>) {
  return { id: j.id, status: j.status, attempts: j.attempts, error: j.error, result: j.result ?? {}, summary: j.summary ?? {}, startedAt: j.started_at, finishedAt: j.finished_at, createdAt: j.created_at };
}

const EDITABLE = new Set(["draft", "awaiting_approval", "approved", "rejected", "failed"]);

export async function patchDraft(client: PoolClient, account: AccountRow, draftId: string, patch: { name?: string; content?: Partial<DraftContent> }, actorUserId: string) {
  const { rows } = await client.query(`SELECT * FROM google_ads_drafts WHERE id = $1 AND account_id = $2`, [draftId, account.id]);
  const draft = rows[0];
  if (!draft) throw new Error("Draft not found");
  if (!EDITABLE.has(draft.status)) throw new Error("This draft can no longer be edited");
  const content: DraftContent = { ...(draft.content as DraftContent), ...(patch.content ?? {}) };
  // Any edit re-opens review: approval must be re-given on what will be published.
  await client.query(
    `UPDATE google_ads_drafts SET name = $2, content = $3, status = 'awaiting_approval', approved_by = NULL, approved_at = NULL, rejected_reason = NULL WHERE id = $1`,
    [draftId, patch.name ?? draft.name, JSON.stringify(content)]);
  await revalidateDraft(client, draftId, account.account_kind);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "campaign_edited", entityType: "draft", entityId: draftId, previousState: draft.status, newState: "awaiting_approval", summary: patch.name ?? draft.name });
}

export async function patchDraftAd(client: PoolClient, account: AccountRow, draftId: string, adId: string, patch: Partial<DraftAdContent> & { title?: string }, actorUserId: string) {
  const { rows } = await client.query(`SELECT a.*, d.status AS draft_status FROM google_ads_draft_ads a JOIN google_ads_drafts d ON d.id = a.draft_id WHERE a.id = $1 AND a.draft_id = $2 AND a.account_id = $3`, [adId, draftId, account.id]);
  const ad = rows[0];
  if (!ad) throw new Error("Ad not found");
  if (!EDITABLE.has(ad.draft_status)) throw new Error("This campaign can no longer be edited");
  const next: DraftAdContent = {
    adGroupKey: ad.ad_group_key, title: patch.title ?? ad.title,
    headlines: (patch.headlines ?? ad.headlines).map((h: string) => String(h).trim()).filter(Boolean),
    descriptions: (patch.descriptions ?? ad.descriptions).map((d: string) => String(d).trim()).filter(Boolean),
    finalUrl: (patch.finalUrl ?? ad.final_url).trim(), path1: patch.path1 !== undefined ? (patch.path1 || null) : ad.path1, path2: patch.path2 !== undefined ? (patch.path2 || null) : ad.path2,
  };
  const issues = validateAd(next);
  await client.query(
    `UPDATE google_ads_draft_ads SET title = $2, headlines = $3, descriptions = $4, final_url = $5, path1 = $6, path2 = $7, validation = $8,
            status = 'awaiting_approval', approved_by = NULL, approved_at = NULL, rejected_reason = NULL, edited_by = $9 WHERE id = $1`,
    [adId, next.title, JSON.stringify(next.headlines), JSON.stringify(next.descriptions), next.finalUrl, next.path1, next.path2,
      JSON.stringify({ ok: issues.every((i) => i.level !== "error"), issues }), actorUserId]);
  if (ad.draft_status === "approved") await client.query(`UPDATE google_ads_drafts SET status = 'awaiting_approval', approved_by = NULL, approved_at = NULL WHERE id = $1`, [draftId]);
  await revalidateDraft(client, draftId, account.account_kind);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "ad_edited", entityType: "draft_ad", entityId: adId, previousState: ad.status, newState: "awaiting_approval", summary: next.title });
  return { ok: issues.every((i) => i.level !== "error"), issues };
}

export async function decideDraftAd(client: PoolClient, account: AccountRow, draftId: string, adId: string, decision: "approve" | "reject", actorUserId: string, reason?: string) {
  const { rows } = await client.query(`SELECT * FROM google_ads_draft_ads WHERE id = $1 AND draft_id = $2 AND account_id = $3`, [adId, draftId, account.id]);
  const ad = rows[0];
  if (!ad) throw new Error("Ad not found");
  if (decision === "approve" && ad.validation?.ok === false) throw new Error("Fix the validation errors before approving this ad");
  const status = decision === "approve" ? "approved" : "rejected";
  await client.query(
    `UPDATE google_ads_draft_ads SET status = $2, approved_by = $3, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END, rejected_reason = $4 WHERE id = $1`,
    [adId, status, decision === "approve" ? actorUserId : null, decision === "reject" ? (reason ?? "Rejected by reviewer") : null]);
  await revalidateDraft(client, draftId, account.account_kind);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: decision === "approve" ? "ad_approved" : "ad_rejected", entityType: "draft_ad", entityId: adId, previousState: ad.status, newState: status, summary: ad.title });
}

/** Approving the campaign approves every ad still awaiting review (a
 *  rejected ad stays rejected and is skipped at publish). */
export async function decideDraft(client: PoolClient, account: AccountRow, draftId: string, decision: "approve" | "reject", actorUserId: string, reason?: string) {
  const { rows } = await client.query(`SELECT * FROM google_ads_drafts WHERE id = $1 AND account_id = $2`, [draftId, account.id]);
  const draft = rows[0];
  if (!draft) throw new Error("Draft not found");
  if (!EDITABLE.has(draft.status)) throw new Error("This draft is not open for a decision");
  if (decision === "approve") {
    await revalidateDraft(client, draftId, account.account_kind);
    const { rows: fresh } = await client.query(`SELECT validation FROM google_ads_drafts WHERE id = $1`, [draftId]);
    if (fresh[0]?.validation?.ok === false) throw new Error("Fix the validation errors before approving this campaign");
    const { rows: bad } = await client.query(`SELECT COUNT(*) AS n FROM google_ads_draft_ads WHERE draft_id = $1 AND status <> 'rejected' AND (validation->>'ok') = 'false'`, [draftId]);
    if (Number(bad[0]?.n ?? 0) > 0) throw new Error("Some ads still have validation errors");
    const { rows: badAssets } = await client.query(`SELECT COUNT(*) AS n FROM google_ads_draft_assets WHERE draft_id = $1 AND kind <> 'image' AND status <> 'rejected' AND (validation->>'ok') = 'false'`, [draftId]);
    if (Number(badAssets[0]?.n ?? 0) > 0) throw new Error("Some sitelinks or callouts still have validation errors");
    await client.query(`UPDATE google_ads_draft_ads SET status = 'approved', approved_by = $2, approved_at = now() WHERE draft_id = $1 AND status IN ('draft','awaiting_approval','failed')`, [draftId, actorUserId]);
    // Creatives ride along: usable ones are approved with the campaign; an
    // image that failed to render or does not meet Google's size is left
    // out (marked rejected with the reason) rather than blocking the campaign.
    await client.query(
      `UPDATE google_ads_draft_assets SET status = 'approved', approved_by = $2, approved_at = now(), error = NULL
        WHERE draft_id = $1 AND status IN ('awaiting_approval','failed') AND (validation->>'ok') IS DISTINCT FROM 'false' AND (kind <> 'image' OR storage_key IS NOT NULL)`, [draftId, actorUserId]);
    await client.query(
      `UPDATE google_ads_draft_assets SET status = 'rejected', rejected_reason = COALESCE(error, validation->'issues'->0->>'message', 'Not usable')
        WHERE draft_id = $1 AND kind = 'image' AND (status = 'draft' OR (status IN ('awaiting_approval','failed') AND ((validation->>'ok') = 'false' OR storage_key IS NULL)))`, [draftId]);
    await client.query(`UPDATE google_ads_drafts SET status = 'approved', approved_by = $2, approved_at = now(), rejected_reason = NULL WHERE id = $1`, [draftId, actorUserId]);
  } else {
    await client.query(`UPDATE google_ads_drafts SET status = 'rejected', rejected_reason = $2, approved_by = NULL, approved_at = NULL WHERE id = $1`, [draftId, reason ?? "Rejected by reviewer"]);
  }
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: decision === "approve" ? "campaign_approved" : "campaign_rejected", entityType: "draft", entityId: draftId, previousState: draft.status, newState: decision === "approve" ? "approved" : "rejected", summary: draft.name, metadata: reason ? { reason } : {} });
}

const ASSET_OPEN = new Set(["draft", "awaiting_approval", "approved", "rejected", "failed"]);

export async function decideDraftAsset(client: PoolClient, account: AccountRow, draftId: string, assetId: string, decision: "approve" | "reject", actorUserId: string, reason?: string) {
  const { rows } = await client.query(`SELECT x.*, d.status AS draft_status FROM google_ads_draft_assets x JOIN google_ads_drafts d ON d.id = x.draft_id WHERE x.id = $1 AND x.draft_id = $2 AND x.account_id = $3`, [assetId, draftId, account.id]);
  const asset = rows[0];
  if (!asset) throw new Error("Creative not found");
  if (!ASSET_OPEN.has(asset.status) || !EDITABLE.has(asset.draft_status)) throw new Error("This creative is not open for a decision");
  if (decision === "approve") {
    if (asset.kind === "image" && !asset.storage_key) throw new Error("This image has not been rendered yet");
    if (asset.validation?.ok === false) throw new Error("Fix the validation errors before approving this creative");
  }
  const status = decision === "approve" ? "approved" : "rejected";
  await client.query(
    `UPDATE google_ads_draft_assets SET status = $2, approved_by = $3, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END, rejected_reason = $4 WHERE id = $1`,
    [assetId, status, decision === "approve" ? actorUserId : null, decision === "reject" ? reason ?? "Rejected by reviewer" : null]);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: decision === "approve" ? "creative_approved" : "creative_rejected", entityType: "draft_asset", entityId: assetId, previousState: asset.status, newState: status, summary: asset.title, metadata: { kind: asset.kind, ...(reason ? { reason } : {}) } });
}

/** Edits a sitelink or callout (images are regenerated, not edited). */
export async function patchDraftAsset(client: PoolClient, account: AccountRow, draftId: string, assetId: string, patch: { title?: string; linkText?: string; description1?: string | null; description2?: string | null; finalUrl?: string; text?: string; altText?: string | null }, actorUserId: string) {
  const { rows } = await client.query(`SELECT x.*, d.status AS draft_status FROM google_ads_draft_assets x JOIN google_ads_drafts d ON d.id = x.draft_id WHERE x.id = $1 AND x.draft_id = $2 AND x.account_id = $3`, [assetId, draftId, account.id]);
  const asset = rows[0];
  if (!asset) throw new Error("Creative not found");
  if (!ASSET_OPEN.has(asset.status) || !EDITABLE.has(asset.draft_status)) throw new Error("This creative is not open for editing");
  const content = { ...(asset.content ?? {}) };
  for (const key of ["linkText", "description1", "description2", "finalUrl", "text", "altText"] as const) if (patch[key] !== undefined) content[key] = patch[key];
  const title = patch.title ?? (asset.kind === "sitelink" && patch.linkText ? patch.linkText : asset.kind === "callout" && patch.text ? patch.text : asset.title);
  const issues = asset.kind === "image" ? [] : validateAsset({ kind: asset.kind, aspect: asset.aspect, title, ...content });
  const validation = { ok: issues.every((i) => i.level !== "error"), issues };
  await client.query(
    `UPDATE google_ads_draft_assets SET title = $2, content = $3, validation = $4, status = CASE WHEN status = 'draft' THEN 'draft' ELSE 'awaiting_approval' END,
            approved_by = NULL, approved_at = NULL, rejected_reason = NULL, edited_by = $5 WHERE id = $1`,
    [assetId, title, JSON.stringify(content), JSON.stringify(validation), actorUserId]);
  if (asset.draft_status === "approved") await client.query(`UPDATE google_ads_drafts SET status = 'awaiting_approval', approved_by = NULL, approved_at = NULL WHERE id = $1`, [draftId]);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "creative_edited", entityType: "draft_asset", entityId: assetId, previousState: asset.status, newState: "awaiting_approval", summary: title, metadata: { kind: asset.kind } });
  return validation;
}
