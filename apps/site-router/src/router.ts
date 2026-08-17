import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import formbody from "@fastify/formbody";
import type { Pool } from "pg";
import { uuidv7, type StorageAdapter } from "@deedwell/database";
import { summarize } from "@deedwell/observability";

/**
 * Site Router (BRD §10.3): resolves Host → (tenant, site, release) and serves
 * the release's static artifact. Also receives form submissions on the site's
 * own origin. This is the PUBLIC surface for tenant websites:
 * - separate origin from the app — it never sees app cookies or tokens
 * - strict CSP; the approved templates ship zero JavaScript
 * - unknown hosts/slugs get a safe 404, never an error dump
 *
 * Host forms: <slug>.preview.<base> (preview release) and <slug>.<base>
 * (published release). Path forms: /<slug>/* serves the published release
 * (the production form behind e.g. sites.deedwell.org); /preview/:slug/* the
 * preview; /live/:slug/* is kept as an alias for previously stored links.
 */

export interface SiteRouterDeps {
  /** Platform service role: read-only site/release resolution + submission inserts. */
  adminPool: Pool;
  storage: StorageAdapter;
  baseDomain?: string; // e.g. "deedwell.app"
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  xml: "application/xml",
  txt: "text/plain; charset=utf-8",
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

// frame-ancestors previously said 'none', which blocked OUR OWN artifact-panel
// iframe — the root cause of the blank preview. Previews may be framed by the
// Deedwell app origins only; everyone else is still refused.
const FRAME_ANCESTORS =
  process.env.FRAME_ANCESTORS ??
  "'self' http://178.104.188.229:4173 http://localhost:4173 http://localhost:5173 tauri://localhost http://tauri.localhost";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors ${FRAME_ANCESTORS}`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site not found</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px 20px">
<h1>Site not found</h1><p>There is no published website at this address.</p></body></html>`;

interface ResolvedSite {
  siteId: string;
  tenantId: string;
  releasePrefix: string | null;
}

export function buildSiteRouter(deps: SiteRouterDeps): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  void app.register(formbody);
  const baseDomain = deps.baseDomain ?? process.env.SITES_BASE_DOMAIN ?? "deedwell.local";

  app.addHook("onSend", async (_req, reply) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) reply.header(header, value);
  });

  async function resolve(slug: string, mode: "preview" | "live"): Promise<ResolvedSite | null> {
    const { rows } = await deps.adminPool.query(
      `SELECT s.id, s.tenant_id, r.storage_prefix
       FROM sites s
       LEFT JOIN site_releases r
         ON r.id = CASE WHEN $2 = 'preview' THEN s.preview_release_id ELSE s.active_release_id END
       WHERE s.slug = $1`,
      [slug, mode]
    );
    if (!rows[0]) return null;
    return { siteId: rows[0].id, tenantId: rows[0].tenant_id, releasePrefix: rows[0].storage_prefix };
  }

  function hostToTarget(host: string): { slug: string; mode: "preview" | "live" } | null {
    const bare = host.split(":")[0] ?? "";
    const previewSuffix = `.preview.${baseDomain}`;
    const liveSuffix = `.${baseDomain}`;
    if (bare.endsWith(previewSuffix)) {
      return { slug: bare.slice(0, -previewSuffix.length), mode: "preview" };
    }
    if (bare.endsWith(liveSuffix)) {
      return { slug: bare.slice(0, -liveSuffix.length), mode: "live" };
    }
    return null;
  }

  async function serve(
    reply: FastifyReply,
    slug: string,
    mode: "preview" | "live",
    rest: string
  ) {
    const site = await resolve(slug, mode);
    if (!site?.releasePrefix) {
      return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_PAGE);
    }
    const clean = rest.replace(/^\/+|\/+$/g, "");
    const path = clean === "" ? "index.html" : /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}/index.html`;
    try {
      const content = await deps.storage.get(`${site.releasePrefix}/${path}`);
      const ext = path.split(".").pop() ?? "html";
      return reply
        .type(CONTENT_TYPES[ext] ?? "application/octet-stream")
        .header("cache-control", mode === "live" ? "public, max-age=60" : "no-store")
        .send(content);
    } catch {
      // Serve the site's own 404 page (real 404 status — never redirect home).
      try {
        const custom = await deps.storage.get(`${site.releasePrefix}/404.html`);
        return reply.status(404).type("text/html; charset=utf-8").send(custom);
      } catch {
        return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_PAGE);
      }
    }
  }

  app.get("/healthz", async () => ({ ok: true }));

  // Dev/test path-based access.
  app.get("/preview/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    return serve(reply, slug, "preview", "");
  });
  app.get("/preview/:slug/*", async (req, reply) => {
    const { slug, "*": rest } = req.params as { slug: string; "*": string };
    return serve(reply, slug, "preview", rest);
  });
  app.get("/live/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    return serve(reply, slug, "live", "");
  });
  app.get("/live/:slug/*", async (req, reply) => {
    const { slug, "*": rest } = req.params as { slug: string; "*": string };
    return serve(reply, slug, "live", rest);
  });

  // Form submissions (shared API with strict tenant identification — BRD §10.1).
  app.post("/forms/:slug/:formKey", async (req, reply) => {
    const { slug, formKey } = req.params as { slug: string; formKey: string };
    if (!/^[a-z0-9-]{1,40}$/.test(formKey)) return reply.status(404).send({ error: "Unknown form" });
    const site = await resolve(slug, "live") ?? await resolve(slug, "preview");
    if (!site) return reply.status(404).send({ error: "Unknown site" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Honeypot: real visitors never fill the hidden "website" field.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return reply.redirect(303, "/thanks/");
    }
    const payload: Record<string, string> = {};
    let size = 0;
    for (const [key, value] of Object.entries(body)) {
      if (key === "website" || typeof value !== "string") continue;
      if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
      const clipped = value.slice(0, 4000);
      size += clipped.length;
      if (size > 16000) break;
      payload[key] = clipped;
    }
    if (Object.keys(payload).length === 0) {
      return reply.status(400).send({ error: "Empty submission" });
    }
    await deps.adminPool.query(
      `INSERT INTO form_submissions (id, tenant_id, site_id, form_key, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidv7(), site.tenantId, site.siteId, formKey, JSON.stringify(payload)]
    );
    req.log.info({ siteId: site.siteId, formKey, summary: summarize(payload, 200) }, "form submission");
    return reply.redirect(303, "/thanks/");
  });

  // First-path segments the router owns; never valid site slugs. Kept in
  // sync with RESERVED_SITE_SLUGS in @deedwell/schemas (enforced at creation).
  const RESERVED_ROOT_SEGMENTS = new Set(["live", "preview", "forms", "healthz", "thanks"]);

  // Any other GET: host-based routing when the Host matches the base domain,
  // otherwise the bare path form /<slug>/* serving the published release.
  app.get("/*", async (req, reply) => {
    const rest = ((req.params as { "*": string })["*"] ?? "").replace(/^\/+/, "");
    const target = hostToTarget(String(req.headers.host ?? ""));
    if (target) return serve(reply, target.slug, target.mode, rest);
    const [slug, ...restParts] = rest.split("/");
    if (!slug || RESERVED_ROOT_SEGMENTS.has(slug)) {
      return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_PAGE);
    }
    // Directory URLs get the trailing slash, so the page's relative links
    // resolve inside the site instead of at the router root.
    if (!rest.endsWith("/") && !/\.[a-z0-9]+$/i.test(rest)) {
      return reply.redirect(308, `/${rest}/`);
    }
    return serve(reply, slug, "live", restParts.join("/"));
  });

  return app;
}
