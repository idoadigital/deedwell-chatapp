/**
 * The only path that writes to Google Ads. An approved draft becomes a
 * publish job after an administrator confirms a summary of exactly what will
 * be created, where. The job re-verifies organization → account → customer
 * id → credential inside its own transaction, dry-runs the whole mutation
 * with validateOnly, then applies it atomically. New campaigns are created
 * PAUSED unless the administrator explicitly chose otherwise.
 *
 * Enabling a campaign or changing a budget are separate, individually
 * confirmed actions — never part of a publish, never available to the AI.
 */
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import { uuidv7, withContext } from "@deedwell/database";
import { GoogleAdsApiError, formatCustomerId, normalizeCustomerId, type DraftContent } from "@deedwell/google-ads-domain";
import type { PoolClient } from "pg";
import type { Deps } from "../bootstrap.js";
import { accessFor } from "./access.js";
import { jobView, loadDraft } from "./drafts.js";
import { emitOrgEvent, loadAccountById, logActivity, type AccountRow } from "./store.js";

export async function publishPreview(client: PoolClient, account: AccountRow, draftId: string, orgName: string) {
  const draft = await loadDraft(client, account.id, draftId);
  if (!draft) throw new Error("Draft not found");
  const ads = draft.ads.filter((a) => a.status === "approved");
  const groups = draft.content.adGroups.map((g) => ({
    key: g.key, name: g.name, keywords: g.keywords.length, negativeKeywords: g.negativeKeywords.length,
    ads: ads.filter((a) => a.adGroupKey === g.key).map((a) => ({ id: a.id, title: a.title, headlines: a.headlines, descriptions: a.descriptions, finalUrl: a.finalUrl })),
  }));
  const blockers: string[] = [];
  if (draft.status !== "approved") blockers.push("The campaign has not been approved.");
  if (draft.validation?.ok === false) blockers.push("The campaign still has validation errors.");
  for (const g of groups) if (!g.ads.length) blockers.push(`Ad group "${g.name}" has no approved ads.`);
  if (account.status !== "connected") blockers.push("The Google Ads account is not connected.");
  return {
    organization: orgName,
    account: { name: account.descriptive_name, customerId: formatCustomerId(account.customer_id), accountKind: account.account_kind },
    campaign: {
      id: draft.id, name: draft.name, objective: draft.content.objective, channelType: draft.content.channelType,
      dailyBudget: draft.content.dailyBudgetMicros / 1_000_000, currencyCode: draft.content.currencyCode, geoTargets: draft.content.geoTargets,
      negativeKeywords: draft.content.negativeKeywords.length, initialStatus: "PAUSED",
    },
    adGroups: groups,
    landingUrls: [...new Set(ads.map((a) => a.finalUrl))],
    blockers,
    validation: draft.validation,
  };
}

/** Records the confirmed intent and queues the job. */
export async function requestPublish(
  deps: Deps, client: PoolClient, account: AccountRow, draftId: string, actorUserId: string,
  input: { confirmName: string; enableOnPublish: boolean }, orgName: string,
): Promise<ReturnType<typeof jobView>> {
  const preview = await publishPreview(client, account, draftId, orgName);
  if (preview.blockers.length) throw new Error(preview.blockers.join(" "));
  if (input.confirmName.trim().toLowerCase() !== preview.campaign.name.trim().toLowerCase()) throw new Error("The confirmation does not match the campaign name.");
  // Prove the credential resolves now, so a queued job never sits on a dead token.
  await accessFor(deps, client, account, actorUserId);
  const id = uuidv7();
  const summary = { ...preview, enableOnPublish: input.enableOnPublish, customerIdRaw: account.customer_id, tenantId: account.tenant_id, requestedBy: actorUserId };
  await client.query(
    `INSERT INTO google_ads_publish_jobs (id, tenant_id, account_id, draft_id, summary, status, requested_by) VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
    [id, account.tenant_id, account.id, draftId, JSON.stringify(summary), actorUserId]);
  await client.query(`UPDATE google_ads_drafts SET status = 'publishing', publish_job_id = $2 WHERE id = $1`, [draftId, id]);
  await client.query(`UPDATE google_ads_draft_ads SET status = 'publishing' WHERE draft_id = $1 AND status = 'approved'`, [draftId]);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "publish_requested", entityType: "publish_job", entityId: id, previousState: "approved", newState: "publishing", summary: preview.campaign.name, metadata: { enableOnPublish: input.enableOnPublish } });
  const { rows } = await client.query(`SELECT * FROM google_ads_publish_jobs WHERE id = $1`, [id]);
  return jobView(rows[0]);
}

const TEMP = { budget: -1, campaign: -2 };

/** Executes one job. Called by the worker with the claimed row. */
export async function runPublishJob(deps: Deps, job: Record<string, any>, opts: { log?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void } } = {}): Promise<void> {
  const tenantId: string = job.tenant_id;
  await withContext(deps.appPool, { tenantId, userId: job.requested_by }, async (client) => {
    const fail = async (message: string, detail: unknown = null) => {
      await client.query(`UPDATE google_ads_publish_jobs SET status = 'failed', error = $2, result = $3, finished_at = now() WHERE id = $1`, [job.id, message, JSON.stringify({ detail })]);
      await client.query(`UPDATE google_ads_drafts SET status = 'failed' WHERE id = $1`, [job.draft_id]);
      await client.query(`UPDATE google_ads_draft_ads SET status = 'failed' WHERE draft_id = $1 AND status = 'publishing'`, [job.draft_id]);
      await logActivity(client, { tenantId, accountId: job.account_id, customerId: job.summary?.customerIdRaw ?? null, actorUserId: job.requested_by, actorKind: "system", action: "publish_failed", entityType: "publish_job", entityId: job.id, previousState: "publishing", newState: "failed", summary: message });
      emitOrgEvent(deps, tenantId, "google_ads:publish_failed", { jobId: job.id, draftId: job.draft_id });
      opts.log?.error({ at: "google_ads.publish_failed", jobId: job.id, message, detail });
    };
    try {
      const account = await loadAccountById(client, tenantId, job.account_id);
      if (!account || account.status !== "connected") return fail("The Google Ads account is no longer connected.");
      // Every identity re-checked against what the administrator confirmed.
      if (normalizeCustomerId(account.customer_id) !== normalizeCustomerId(String(job.summary?.customerIdRaw ?? ""))) return fail("The confirmed customer id no longer matches the organization's account.");
      if (job.summary?.tenantId !== tenantId) return fail("Organization mismatch.");
      const draft = await loadDraft(client, account.id, job.draft_id);
      if (!draft || draft.status !== "publishing") return fail("The draft is not in a publishable state.");
      const ads = draft.ads.filter((a) => a.status === "publishing");
      if (!ads.length) return fail("No approved ads to publish.");

      const access = await accessFor(deps, client, account, job.requested_by);
      const cid = access.customerId;
      const cust = `customers/${cid}`;
      const content = draft.content as DraftContent;
      const enable = Boolean(job.summary?.enableOnPublish);

      const ops: Array<Record<string, unknown>> = [];
      ops.push({ campaignBudgetOperation: { create: { resourceName: `${cust}/campaignBudgets/${TEMP.budget}`, name: `${draft.name} budget ${Date.now()}`, amountMicros: String(content.dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } } });
      const campaign: Record<string, unknown> = {
        resourceName: `${cust}/campaigns/${TEMP.campaign}`, name: draft.name, status: enable ? "ENABLED" : "PAUSED",
        advertisingChannelType: "SEARCH", campaignBudget: `${cust}/campaignBudgets/${TEMP.budget}`,
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
        containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      };
      if (account.account_kind === "ad_grants") campaign.maximizeConversions = {};
      else campaign.manualCpc = { enhancedCpcEnabled: false };
      ops.push({ campaignOperation: { create: campaign } });
      for (const text of content.negativeKeywords ?? []) {
        ops.push({ campaignCriterionOperation: { create: { campaign: `${cust}/campaigns/${TEMP.campaign}`, negative: true, keyword: { text, matchType: "BROAD" } } } });
      }
      const geo = await resolveGeoTargets(access.client, cid, content.geoTargets ?? []);
      for (const resource of geo.resolved) ops.push({ campaignCriterionOperation: { create: { campaign: `${cust}/campaigns/${TEMP.campaign}`, location: { geoTargetConstant: resource } } } });

      let temp = -10;
      const groupTemp = new Map<string, number>();
      const adIndex: Array<{ adId: string; opIndex: number; groupKey: string }> = [];
      for (const g of content.adGroups) {
        const id = temp--;
        groupTemp.set(g.key, id);
        const adGroup: Record<string, unknown> = { resourceName: `${cust}/adGroups/${id}`, name: g.name, status: "ENABLED", campaign: `${cust}/campaigns/${TEMP.campaign}`, type: "SEARCH_STANDARD" };
        if (account.account_kind !== "ad_grants") adGroup.cpcBidMicros = String(g.cpcBidMicros ?? 1_000_000);
        ops.push({ adGroupOperation: { create: adGroup } });
        for (const k of g.keywords) ops.push({ adGroupCriterionOperation: { create: { adGroup: `${cust}/adGroups/${id}`, status: "ENABLED", keyword: { text: k.text, matchType: k.matchType } } } });
        for (const text of g.negativeKeywords ?? []) ops.push({ adGroupCriterionOperation: { create: { adGroup: `${cust}/adGroups/${id}`, negative: true, keyword: { text, matchType: "BROAD" } } } });
        for (const ad of ads.filter((a) => a.adGroupKey === g.key)) {
          adIndex.push({ adId: ad.id, opIndex: ops.length, groupKey: g.key });
          ops.push({ adGroupAdOperation: { create: {
            adGroup: `${cust}/adGroups/${id}`, status: enable ? "ENABLED" : "PAUSED",
            ad: {
              name: ad.title, finalUrls: [ad.finalUrl],
              responsiveSearchAd: {
                headlines: ad.headlines.map((text: string) => ({ text })), descriptions: ad.descriptions.map((text: string) => ({ text })),
                ...(ad.path1 ? { path1: ad.path1 } : {}), ...(ad.path2 ? { path2: ad.path2 } : {}),
              },
            },
          } } });
        }
      }

      await client.query(`UPDATE google_ads_publish_jobs SET status = 'running', started_at = now(), attempts = attempts + 1 WHERE id = $1`, [job.id]);
      await access.client.mutateAll(cid, ops, { validateOnly: true });
      const responses = await access.client.mutateAll(cid, ops);

      const nameOf = (r: Record<string, any> | undefined, key: string): string | null => r?.[key]?.resourceName ? String(r[key].resourceName).split("/").pop() ?? null : null;
      const campaignId = nameOf(responses[1], "campaignResult");
      const groupIds = new Map<string, string | null>();
      ops.forEach((op, i) => {
        if (op.adGroupOperation) {
          const created = (op.adGroupOperation as { create: { name: string; resourceName: string } }).create;
          const key = content.adGroups.find((g) => `${cust}/adGroups/${groupTemp.get(g.key)}` === created.resourceName)?.key;
          if (key) groupIds.set(key, nameOf(responses[i], "adGroupResult"));
        }
      });
      for (const entry of adIndex) {
        const googleAdId = nameOf(responses[entry.opIndex], "adGroupAdResult");
        await client.query(
          `UPDATE google_ads_draft_ads SET status = 'published', google_ad_id = $2, google_ad_group_id = $3, google_campaign_id = $4 WHERE id = $1`,
          [entry.adId, googleAdId, groupIds.get(entry.groupKey) ?? null, campaignId]);
      }
      await client.query(`UPDATE google_ads_drafts SET status = 'published', published_campaign_id = $2 WHERE id = $1`, [job.draft_id, campaignId]);
      if (campaignId) {
        await client.query(
          `INSERT INTO google_ads_campaigns (id, tenant_id, account_id, campaign_id, name, status, advertising_channel_type, bidding_strategy_type, budget_micros, draft_id, raw)
           VALUES ($1,$2,$3,$4,$5,$6,'SEARCH',$7,$8,$9,'{}')
           ON CONFLICT (account_id, campaign_id) DO UPDATE SET draft_id = EXCLUDED.draft_id, status = EXCLUDED.status, name = EXCLUDED.name`,
          [uuidv7(), tenantId, account.id, campaignId, draft.name, enable ? "ENABLED" : "PAUSED", account.account_kind === "ad_grants" ? "MAXIMIZE_CONVERSIONS" : "MANUAL_CPC", content.dailyBudgetMicros, job.draft_id]);
      }
      const result = { campaignId, adGroups: Object.fromEntries(groupIds), ads: adIndex.length, geoUnresolved: geo.unresolved, via: access.via };
      await client.query(`UPDATE google_ads_publish_jobs SET status = 'completed', result = $2, finished_at = now(), error = NULL WHERE id = $1`, [job.id, JSON.stringify(result)]);
      await logActivity(client, { tenantId, accountId: account.id, customerId: account.customer_id, actorUserId: job.requested_by, actorKind: "admin", action: "campaign_published", entityType: "campaign", entityId: campaignId, previousState: "publishing", newState: enable ? "ENABLED" : "PAUSED", summary: draft.name, metadata: result });
      await emailOrgAdmins(client, tenantId, "google_ads_published", { orgName: await orgNameOf(client, tenantId), campaignName: draft.name, adCount: adIndex.length, paused: !enable }, { dedupe: `google_ads_published:${job.id}` }).catch(() => 0);
      emitOrgEvent(deps, tenantId, "google_ads:published", { jobId: job.id, draftId: job.draft_id, campaignId });
      opts.log?.info({ at: "google_ads.published", jobId: job.id, campaignId, ads: adIndex.length });
    } catch (err) {
      const message = err instanceof GoogleAdsApiError ? `Google Ads rejected the publish: ${err.message}` : (err as Error).message;
      await fail(message, err instanceof GoogleAdsApiError ? err.details : null);
    }
  });
}

async function resolveGeoTargets(api: { searchStream<T>(cid: string, q: string): Promise<T[]> }, cid: string, names: string[]): Promise<{ resolved: string[]; unresolved: string[] }> {
  const resolved: string[] = []; const unresolved: string[] = [];
  for (const name of names.slice(0, 20)) {
    const safe = name.replace(/'/g, "\\'");
    try {
      const rows = await api.searchStream<{ geoTargetConstant: { resourceName: string } }>(cid,
        `SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.target_type FROM geo_target_constant
          WHERE geo_target_constant.name = '${safe}' AND geo_target_constant.status = 'ENABLED' LIMIT 1`);
      const r = rows[0]?.geoTargetConstant?.resourceName;
      if (r) resolved.push(r); else unresolved.push(name);
    } catch { unresolved.push(name); }
  }
  return { resolved, unresolved };
}

/** Pause / enable a campaign. Individually confirmed by an administrator. */
export async function setCampaignStatus(deps: Deps, client: PoolClient, account: AccountRow, campaignId: string, status: "ENABLED" | "PAUSED", actorUserId: string) {
  const { rows } = await client.query(`SELECT * FROM google_ads_campaigns WHERE account_id = $1 AND campaign_id = $2`, [account.id, campaignId]);
  const current = rows[0];
  if (!current) throw new Error("Campaign not found");
  const access = await accessFor(deps, client, account, actorUserId);
  await access.client.mutate(access.customerId, "campaigns", [{ update: { resourceName: `customers/${access.customerId}/campaigns/${campaignId}`, status }, updateMask: "status" }]);
  await client.query(`UPDATE google_ads_campaigns SET status = $3 WHERE account_id = $1 AND campaign_id = $2`, [account.id, campaignId, status]);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: status === "ENABLED" ? "campaign_enabled" : "campaign_paused", entityType: "campaign", entityId: campaignId, previousState: current.status, newState: status, summary: current.name });
  emitOrgEvent(deps, account.tenant_id, "google_ads:campaign_changed", { campaignId });
}

/** Change a campaign's daily budget. Individually confirmed by an administrator. */
export async function setCampaignBudget(deps: Deps, client: PoolClient, account: AccountRow, campaignId: string, dailyBudgetMicros: number, actorUserId: string) {
  const { rows } = await client.query(`SELECT * FROM google_ads_campaigns WHERE account_id = $1 AND campaign_id = $2`, [account.id, campaignId]);
  const current = rows[0];
  if (!current) throw new Error("Campaign not found");
  if (!current.budget_resource) throw new Error("This campaign's budget is not known yet — sync the account first");
  const access = await accessFor(deps, client, account, actorUserId);
  await access.client.mutate(access.customerId, "campaignBudgets", [{ update: { resourceName: current.budget_resource, amountMicros: String(dailyBudgetMicros) }, updateMask: "amount_micros" }]);
  await client.query(`UPDATE google_ads_campaigns SET budget_micros = $3 WHERE account_id = $1 AND campaign_id = $2`, [account.id, campaignId, dailyBudgetMicros]);
  await logActivity(client, { tenantId: account.tenant_id, accountId: account.id, customerId: account.customer_id, actorUserId, actorKind: "admin", action: "budget_changed", entityType: "campaign", entityId: campaignId, previousState: current.budget_micros != null ? String(Number(current.budget_micros) / 1_000_000) : null, newState: String(dailyBudgetMicros / 1_000_000), summary: current.name });
  emitOrgEvent(deps, account.tenant_id, "google_ads:campaign_changed", { campaignId });
}
