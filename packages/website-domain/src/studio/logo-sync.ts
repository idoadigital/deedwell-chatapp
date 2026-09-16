import type { PoolClient } from "pg";
import { audit, type StorageAdapter } from "@deedwell/database";
import { loadSiteLogoFrom } from "../workflow.js";
import { assembleRelease, publishRelease } from "./releases.js";
import { applyOperations, loadWorkingState, saveWorkingState } from "./state.js";

/**
 * The generated website follows Brand Style: when the organization's logo
 * is set, replaced or cleared, every site Deedwell built gets a content
 * version with the brand mark updated on every page. A site with nothing
 * waiting to be published goes live with it at once; a site that already
 * has unpublished changes keeps them together as its preview, and the new
 * logo goes live with the next publish (the router serves the current
 * brand file meanwhile, so an existing logo image swaps immediately).
 */
export interface LogoSyncResult { siteId: string; slug: string; action: "use-brand" | "remove"; version: number | null; published: boolean; skipped?: string }

export async function syncSitesToBrandLogo(client: PoolClient, storage: StorageAdapter, tenantId: string, userId: string | null): Promise<LogoSyncResult[]> {
  const { rows: sites } = await client.query("SELECT id, slug, preview_release_id, active_release_id FROM sites WHERE tenant_id = $1 AND archived_at IS NULL AND preview_release_id IS NOT NULL ORDER BY created_at", [tenantId]);
  const logo = await loadSiteLogoFrom(client, storage);
  const action: "use-brand" | "remove" = logo ? "use-brand" : "remove";
  const out: LogoSyncResult[] = [];
  for (const site of sites) {
    try {
      const state = await loadWorkingState(client, site.id);
      const applied = applyOperations(state, [{ kind: "logo", action }]);
      if (!applied.changed.size) { out.push({ siteId: site.id, slug: site.slug, action, version: null, published: false, skipped: applied.rejected[0] ?? "nothing to change" }); continue; }
      await saveWorkingState(client, applied.state, applied.changed);
      const release = await assembleRelease({ client, storage, tenantId, siteId: site.id, kind: "content", label: logo ? "Brand logo updated" : "Brand logo removed", createdBy: userId, createdByKind: "system", logo });
      const clean = site.active_release_id && site.active_release_id === site.preview_release_id;
      if (clean) await publishRelease(client, { tenantId, siteId: site.id, releaseId: release.releaseId, userId });
      await audit(client, { tenantId, actorUser: userId, action: "site.logo_synced", entityType: "site", entityId: site.id, metadata: { action, releaseId: release.releaseId, published: Boolean(clean) } });
      out.push({ siteId: site.id, slug: site.slug, action, version: release.version, published: Boolean(clean) });
    } catch (err) {
      out.push({ siteId: site.id, slug: site.slug, action, version: null, published: false, skipped: String((err as Error).message ?? err).slice(0, 160) });
    }
  }
  return out;
}
