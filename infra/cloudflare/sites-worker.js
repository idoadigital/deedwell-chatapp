/**
 * Cloudflare Worker: serves generated nonprofit sites on wildcard subdomains.
 *
 * Route:  *.deedwell.org/*   (with a proxied DNS record for *.deedwell.org)
 * Upstream: the deedwell-sites Cloud Run service (SITES_ORIGIN binding).
 *
 * Cloud Run cannot map a wildcard domain and Google's edge routes by Host,
 * so the Worker addresses the upstream by its own name and passes the name
 * the visitor typed in X-Forwarded-Host. The router resolves the site from
 * that: <slug>.deedwell.org is the published release, preview-<slug> the
 * preview. Everything else about the response passes through untouched.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const visitorHost = url.hostname;
    const upstream = new URL(env.SITES_ORIGIN || "https://deedwell-sites-304514004050.us-central1.run.app");
    upstream.pathname = url.pathname;
    upstream.search = url.search;

    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", visitorHost);
    headers.set("x-forwarded-proto", "https");

    return fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  },
};
