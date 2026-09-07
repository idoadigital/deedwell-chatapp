/**
 * Where a site is reachable, derived from the same env the site-router
 * reads (never guessed by the browser). Preference order mirrors the
 * router: wildcard domain, then the dashboard origin proxying the router,
 * then the router's own origin. A partner-built site reports its own URL.
 */
export interface SiteUrlInput {
  slug: string;
  external_build_url?: string | null;
  live_version?: number | null;
  preview_version?: number | null;
}

export function siteUrls(row: SiteUrlInput, env: NodeJS.ProcessEnv = process.env): { live_url: string | null; preview_url: string | null } {
  const base = env.SITES_BASE_DOMAIN ?? null;
  const scheme = env.SITES_SCHEME ?? "https";
  const routerUrl = (env.SITES_ROUTER_URL ?? "").replace(/\/+$/, "") || null;
  const publicOrigin = (env.SITES_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "") || null;
  if (row.external_build_url) return { live_url: row.external_build_url, preview_url: null };
  if (base) {
    return {
      live_url: row.live_version ? `${scheme}://${row.slug}.${base}` : null,
      preview_url: row.preview_version ? `${scheme}://preview-${row.slug}.${base}` : null,
    };
  }
  if (publicOrigin) {
    return {
      live_url: row.live_version ? `${publicOrigin}/sites/${row.slug}/` : null,
      preview_url: row.preview_version ? `${publicOrigin}/preview/${row.slug}/` : null,
    };
  }
  if (routerUrl) {
    return {
      live_url: row.live_version ? `${routerUrl}/${row.slug}/` : null,
      preview_url: row.preview_version ? `${routerUrl}/preview/${row.slug}/` : null,
    };
  }
  return { live_url: null, preview_url: null };
}
