/**
 * Campaign builds. Approving a strategy queues one build per campaign it
 * recommends; the worker turns each into a publish-ready draft — copy,
 * keywords, sitelinks, callouts — and then renders the image creatives.
 * The administrator reviews the result in the workspace and publishes it;
 * nothing here talks to Google Ads.
 *
 * Images are rendered outside any database transaction (a picture takes a
 * minute) and written back per asset, so a slow or failed render never
 * holds a connection or loses the campaign copy.
 */
import { createImageGenerator, readProviderKey, type ImageGenerator } from "@deedwell/content-domain";
import { loadMissionProfile, uuidv7, withContext } from "@deedwell/database";
import { ASSET_LIMITS, validateAsset, type ImageAspect, type StrategyContent } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { cropToAspect, decodePng, downscale, encodePng, isPng } from "../png.js";
import { generateCampaignDraft } from "./ai.js";
import { emitOrgEvent, loadAccountById, logActivity, type AccountRow } from "./store.js";

type Log = { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };

export function buildJobView(j: Record<string, any>) {
  return {
    id: j.id, strategyId: j.strategy_id, campaignIndex: j.campaign_index, campaignName: j.campaign_name, status: j.status, stage: j.stage,
    draftId: j.draft_id, error: j.error, attempts: j.attempts, startedAt: j.started_at, finishedAt: j.finished_at, createdAt: j.created_at,
  };
}

export async function listBuilds(client: PoolClient, accountId: string, opts: { strategyId?: string } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM google_ads_build_jobs WHERE account_id = $1 ${opts.strategyId ? "AND strategy_id = $2" : ""} ORDER BY created_at DESC LIMIT 100`,
    opts.strategyId ? [accountId, opts.strategyId] : [accountId]);
  return rows.map(buildJobView);
}

/** Queues builds for the strategy's campaign recommendations. With no
 *  `indexes`, every recommendation that has neither a live draft nor a
 *  pending build gets one (what "Approve strategy" does); explicit indexes
 *  always queue (what "Generate campaign" does). */
export async function enqueueBuilds(
  client: PoolClient, account: AccountRow, strategy: Record<string, any>, actorUserId: string,
  opts: { indexes?: number[]; instructions?: string } = {},
): Promise<ReturnType<typeof buildJobView>[]> {
  if (strategy.status !== "approved") throw new Error("Only an approved strategy can generate campaigns");
  const campaigns: StrategyContent["campaigns"] = strategy.content?.campaigns ?? [];
  let indexes = opts.indexes ?? campaigns.map((_c, i) => i);
  if (!opts.indexes) {
    const { rows: busy } = await client.query(
      `SELECT DISTINCT campaign_index FROM google_ads_build_jobs WHERE strategy_id = $1 AND status IN ('queued','running')
        UNION SELECT DISTINCT (model_meta->>'campaignIndex')::int FROM google_ads_drafts WHERE strategy_id = $1 AND status NOT IN ('rejected','failed')`, [strategy.id]);
    const taken = new Set(busy.map((r) => Number(r.campaign_index)));
    indexes = indexes.filter((i) => !taken.has(i));
  }
  const out: ReturnType<typeof buildJobView>[] = [];
  for (const index of indexes) {
    const campaign = campaigns[index];
    if (!campaign) throw new Error(`The strategy has no campaign recommendation #${index + 1}`);
    const id = uuidv7();
    const { rows } = await client.query(
      `INSERT INTO google_ads_build_jobs (id, tenant_id, account_id, strategy_id, campaign_index, campaign_name, instructions, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8) RETURNING *`,
      [id, account.tenant_id, account.id, strategy.id, index, campaign.name, opts.instructions ?? null, actorUserId]);
    await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "campaign_build_queued", entityType: "build_job", entityId: id, newState: "queued", summary: campaign.name, metadata: { strategyId: strategy.id, campaignIndex: index } });
    out.push(buildJobView(rows[0]));
  }
  return out;
}

/** Executes one build. Stage 1 drafts the campaign in the tenant's own
 *  transaction; stage 2 renders creatives asset by asset. */
export async function runBuildJob(deps: Deps, job: Record<string, any>, opts: { log?: Log } = {}): Promise<void> {
  const tenantId: string = job.tenant_id;
  const fail = async (message: string) => {
    await deps.adminPool.query(`UPDATE google_ads_build_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, message.slice(0, 1000)]);
    await withContext(deps.appPool, { tenantId, userId: job.requested_by }, (client) =>
      logActivity(client, { tenantId, accountId: job.account_id, customerId: null, actorUserId: job.requested_by, actorKind: "system", action: "campaign_build_failed", entityType: "build_job", entityId: job.id, previousState: "running", newState: "failed", summary: message.slice(0, 200) })).catch(() => undefined);
    emitOrgEvent(deps, tenantId, "google_ads:build_changed", { jobId: job.id, status: "failed" });
    opts.log?.error({ at: "google_ads.build_failed", jobId: job.id, message });
  };
  try {
    let draftId: string | null = job.draft_id ?? null;
    if (!draftId) {
      await deps.adminPool.query(`UPDATE google_ads_build_jobs SET status = 'running', stage = 'campaign', started_at = COALESCE(started_at, now()), attempts = attempts + 1 WHERE id = $1`, [job.id]);
      draftId = await withContext(deps.appPool, { tenantId, userId: job.requested_by }, async (client) => {
        const account = await loadAccountById(client, tenantId, job.account_id);
        if (!account) throw new Error("The Google Ads account is gone.");
        if (account.status !== "connected") throw new Error("The Google Ads account is not connected.");
        return generateCampaignDraft(deps, client, tenantId, account, job.strategy_id, job.requested_by, { campaignIndex: job.campaign_index, instructions: job.instructions ?? undefined });
      });
      await deps.adminPool.query(`UPDATE google_ads_build_jobs SET stage = 'creatives', draft_id = $2 WHERE id = $1`, [job.id, draftId]);
      emitOrgEvent(deps, tenantId, "google_ads:build_changed", { jobId: job.id, status: "running", stage: "creatives", draftId });
      emitOrgEvent(deps, tenantId, "google_ads:draft_changed", { draftId });
    } else {
      await deps.adminPool.query(`UPDATE google_ads_build_jobs SET status = 'running', stage = 'creatives', attempts = attempts + 1 WHERE id = $1`, [job.id]);
    }
    const rendered = await renderDraftCreatives(deps, tenantId, job.account_id, draftId, job.requested_by, opts.log);
    await deps.adminPool.query(`UPDATE google_ads_build_jobs SET status = 'completed', stage = NULL, error = $2, finished_at = now() WHERE id = $1`,
      [job.id, rendered.failed ? `${rendered.failed} of ${rendered.total} images could not be rendered` : null]);
    emitOrgEvent(deps, tenantId, "google_ads:build_changed", { jobId: job.id, status: "completed", draftId });
    opts.log?.info({ at: "google_ads.build_completed", jobId: job.id, draftId, images: rendered });
  } catch (err) {
    await fail((err as Error).message ?? String(err));
  }
}

/** Renders every image asset of a draft that is still a brief. Each render
 *  is its own short write, so partial progress shows in the workspace. */
export async function renderDraftCreatives(deps: Deps, tenantId: string, accountId: string, draftId: string, actorUserId: string | null, log?: Log, opts: { assetId?: string } = {}) {
  const { rows: pending } = await deps.adminPool.query(
    `SELECT id, aspect, title, content FROM google_ads_draft_assets WHERE draft_id = $1 AND kind = 'image' AND tenant_id = $2 ${opts.assetId ? "AND id = $3" : "AND status = 'draft'"} ORDER BY position`,
    opts.assetId ? [draftId, tenantId, opts.assetId] : [draftId, tenantId]);
  const stats = { total: pending.length, rendered: 0, failed: 0 };
  if (!pending.length) return stats;
  const brand = await withContext(deps.appPool, { tenantId, userId: actorUserId }, (client) => brandNotes(deps, client, tenantId));
  let generator: ImageGenerator | null = null;
  for (const asset of pending) {
    try {
      generator ??= createImageGenerator({ apiKey: await readProviderKey(deps.appPool, "openai").catch(() => null) });
      const aspect = (asset.aspect ?? "landscape") as ImageAspect;
      const image = await renderImage(generator, `${asset.content?.prompt ?? asset.title}${brand}`, aspect);
      const key = `tenants/${tenantId}/google-ads/${draftId}/${asset.id}.png`;
      await deps.storage.put(key, image.bytes);
      const issues = validateAsset({ kind: "image", aspect, title: asset.title, width: image.width, height: image.height, sizeBytes: image.bytes.length });
      await deps.adminPool.query(
        `UPDATE google_ads_draft_assets SET storage_key = $2, mime = 'image/png', size_bytes = $3, width = $4, height = $5, status = 'awaiting_approval', error = NULL,
                validation = $6, content = content || $7::jsonb, approved_by = NULL, approved_at = NULL, rejected_reason = NULL WHERE id = $1`,
        [asset.id, key, image.bytes.length, image.width, image.height, JSON.stringify({ ok: issues.every((i) => i.level !== "error"), issues }), JSON.stringify({ model: generator.model })]);
      stats.rendered++;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 400);
      await deps.adminPool.query(`UPDATE google_ads_draft_assets SET status = 'failed', error = $2 WHERE id = $1`, [asset.id, message]);
      stats.failed++;
      log?.error({ at: "google_ads.creative_failed", assetId: asset.id, message });
    }
    emitOrgEvent(deps, tenantId, "google_ads:draft_changed", { draftId, assetId: asset.id });
  }
  await withContext(deps.appPool, { tenantId, userId: actorUserId }, (client) =>
    logActivity(client, { tenantId, accountId, customerId: null, actorUserId, actorKind: "ai", action: "creatives_rendered", entityType: "draft", entityId: draftId, newState: "awaiting_approval", summary: `${stats.rendered} of ${stats.total} images rendered`, metadata: stats })).catch(() => undefined);
  return stats;
}

/** A sentence of brand direction from the Mission Profile, when it has any. */
async function brandNotes(deps: Deps, client: PoolClient, tenantId: string): Promise<string> {
  try {
    const profile = await loadMissionProfile(client, deps.storage, tenantId);
    const facts = profile.facts.filter((f) => f.key.startsWith("brand_") && f.value).map((f) => `${f.key.replace(/^brand_/, "").replace(/_/g, " ")}: ${f.value}`).slice(0, 4);
    return facts.length ? ` Brand direction — ${facts.join("; ")}.` : "";
  } catch { return ""; }
}

const STYLE = " Photographic, natural light, realistic, high detail. No text, no letters, no logos, no watermarks, no borders.";

/** Generates, centre-crops to Google's ratio and keeps the file under 5 MB. */
async function renderImage(generator: ImageGenerator, prompt: string, aspect: ImageAspect): Promise<{ bytes: Buffer; width: number; height: number }> {
  const spec = ASSET_LIMITS.image[aspect];
  const image = await generator.generate(`${prompt}${STYLE}`, aspect === "landscape" ? "1536x1024" : "1024x1024");
  if (!isPng(image.bytes)) throw new Error(`The image model returned ${image.mime}, not a PNG`);
  let img = cropToAspect(decodePng(image.bytes), spec.ratio);
  let out = encodePng(img);
  for (const side of [1200, 1000, 800, 640]) {
    if (out.length <= ASSET_LIMITS.image.maxBytes) break;
    img = downscale(img, side);
    out = encodePng(img);
  }
  return { bytes: out, width: img.width, height: img.height };
}

/** Re-renders one image with optional reviewer guidance folded into the brief. */
export async function regenerateImageAsset(deps: Deps, tenantId: string, account: AccountRow, draftId: string, assetId: string, actorUserId: string, instructions?: string) {
  const { rowCount } = await deps.adminPool.query(
    `UPDATE google_ads_draft_assets
        SET status = 'draft', error = NULL, edited_by = $4, approved_by = NULL, approved_at = NULL, rejected_reason = NULL,
            content = CASE WHEN $3::text IS NULL THEN content
                           ELSE jsonb_set(content, '{prompt}', to_jsonb(COALESCE(content->>'prompt', '') || ' Reviewer guidance: ' || $3::text)) END
      WHERE id = $1 AND draft_id = $2 AND tenant_id = $5 AND kind = 'image' AND status IN ('draft','awaiting_approval','approved','rejected','failed')`,
    [assetId, draftId, instructions?.trim() || null, actorUserId, tenantId]);
  if (!rowCount) throw new Error("Image not found or not open for changes");
  return renderDraftCreatives(deps, tenantId, account.id, draftId, actorUserId, undefined, { assetId });
}
