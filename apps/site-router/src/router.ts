import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import formbody from "@fastify/formbody";
import type { Pool } from "pg";
import { uuidv7, type StorageAdapter } from "@deedwell/database";
import { summarize } from "@deedwell/observability";
import { MOTION_SCRIPT_HASH } from "@deedwell/website-domain";

/**
 * Site Router (BRD §10.3): resolves Host → (tenant, site, release) and serves
 * the release's static artifact. Also receives form submissions on the site's
 * own origin. This is the PUBLIC surface for tenant websites:
 * - separate origin from the app — it never sees app cookies or tokens
 * - strict CSP; the approved templates ship zero JavaScript
 * - unknown hosts/slugs get a safe 404, never an error dump
 *
 * Host forms: preview-<slug>.<base> (preview release; the older
 * <slug>.preview.<base> still resolves) and <slug>.<base> (published
 * release). Preview is a first-level label so one wildcard certificate for
 * *.<base> covers every site and every preview. Path forms: /<slug>/* serves the published release
 * (the production form behind e.g. sites.deedwell.org); /preview/:slug/* the
 * preview; /live/:slug/* is kept as an alias for previously stored links.
 *
 * Pages link to each other with root-relative URLs, which is right for the
 * host forms and wrong for the path forms. In path form the router rewrites
 * those links on the way out so a site served under /preview/<slug>/ stays
 * inside /preview/<slug>/. An edge proxy in front (deedwell.org/preview/…)
 * says where it mounted the site with X-Forwarded-Prefix.
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
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

// frame-ancestors previously said 'none', which blocked OUR OWN artifact-panel
// iframe — the root cause of the blank preview. Previews may be framed by the
// Deedwell app origins only; everyone else is still refused.
const FRAME_ANCESTORS =
  process.env.FRAME_ANCESTORS ??
  "'self' https://deedwell.org https://www.deedwell.org https://coworkers.deedwell.org http://localhost:4173 http://localhost:5173 tauri://localhost http://tauri.localhost";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; script-src '${MOTION_SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors ${FRAME_ANCESTORS}`,
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
  // First-path segments the router owns; never valid site slugs. Kept in
  // sync with RESERVED_SITE_SLUGS in @deedwell/schemas (enforced at creation).
  const RESERVED_ROOT_SEGMENTS = new Set(["live", "preview", "forms", "healthz", "thanks"]);

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
      const label = bare.slice(0, -liveSuffix.length);
      if (label.startsWith("preview-")) return { slug: label.slice("preview-".length), mode: "preview" };
      return { slug: label, mode: "live" };
    }
    return null;
  }

  /** The host the visitor typed. Behind an edge proxy (a Cloudflare Worker
   *  forwarding to Cloud Run) that arrives in X-Forwarded-Host, since the
   *  proxy has to address the upstream by its own name. */
  function visitorHost(headers: Record<string, unknown>): string {
    const forwarded = headers["x-forwarded-host"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof first === "string" && first.trim()) return first.split(",")[0]!.trim();
    return String(headers.host ?? "");
  }

  /** Where the site is mounted, as the visitor sees it: "" for the host
   *  forms, "/preview/<slug>" or "/<slug>" for the path forms, or whatever an
   *  edge proxy in front says it used. */
  function mountPrefix(headers: Record<string, unknown>, own: string): string {
    const forwarded = headers["x-forwarded-prefix"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof first === "string" && /^\/[A-Za-z0-9._~\/-]*$/.test(first.trim())) {
      return first.trim().replace(/\/+$/, "");
    }
    return own;
  }

  /** Root-relative links become prefix-relative. Protocol-relative ("//cdn")
   *  and absolute URLs are untouched. */
  function rewriteForPrefix(html: string, prefix: string): string {
    if (!prefix) return html;
    return html.replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${prefix}/`);
  }

  async function serve(
    reply: FastifyReply,
    slug: string,
    mode: "preview" | "live",
    rest: string,
    prefix = ""
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
      const body = ext === "html" ? rewriteForPrefix(content.toString("utf8"), prefix) : content;
      return reply
        .type(CONTENT_TYPES[ext] ?? "application/octet-stream")
        .header("cache-control", mode === "live" ? "public, max-age=60" : "no-store")
        .send(body);
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

  // Path-based access: previews always, and the published site by path for
  // deployments without a wildcard domain.
  const headersOf = (req: { headers: unknown }) => req.headers as Record<string, unknown>;
  app.get("/preview/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    // Directory URL, so the page's prefixed links resolve inside the site.
    return reply.redirect(308, `${mountPrefix(headersOf(req), `/preview/${slug}`)}/`);
  });
  app.get("/preview/:slug/*", async (req, reply) => {
    const { slug, "*": rest } = req.params as { slug: string; "*": string };
    return serve(reply, slug, "preview", rest, mountPrefix(headersOf(req), `/preview/${slug}`));
  });
  app.get("/live/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    return serve(reply, slug, "live", "", mountPrefix(headersOf(req), `/live/${slug}`));
  });
  app.get("/live/:slug/*", async (req, reply) => {
    const { slug, "*": rest } = req.params as { slug: string; "*": string };
    return serve(reply, slug, "live", rest, mountPrefix(headersOf(req), `/live/${slug}`));
  });

  // Form submissions (shared API with strict tenant identification — BRD §10.1).
  // The prefixed forms are what a rewritten page under /preview/<slug>/ or
  // /<slug>/ posts to; they land in the same handler and thank the visitor
  // inside the same mount.
  app.post("/forms/:slug/:formKey", async (req, reply) => {
    const { slug, formKey } = req.params as { slug: string; formKey: string };
    return submitForm(req, reply, slug, formKey, "");
  });
  app.post("/preview/:slug/forms/:formSlug/:formKey", async (req, reply) => {
    const { slug, formKey } = req.params as { slug: string; formKey: string };
    return submitForm(req, reply, slug, formKey, mountPrefix(headersOf(req), `/preview/${slug}`));
  });
  app.post("/:slug/forms/:formSlug/:formKey", async (req, reply) => {
    const { slug, formKey } = req.params as { slug: string; formKey: string };
    if (RESERVED_ROOT_SEGMENTS.has(slug)) return reply.status(404).send({ error: "Unknown form" });
    return submitForm(req, reply, slug, formKey, mountPrefix(headersOf(req), `/${slug}`));
  });

  async function submitForm(
    req: { body: unknown; log: { info: (o: unknown, m: string) => void } },
    reply: FastifyReply,
    slug: string,
    formKey: string,
    prefix: string
  ) {
    if (!/^[a-z0-9-]{1,40}$/.test(formKey)) return reply.status(404).send({ error: "Unknown form" });
    const site = await resolve(slug, "live") ?? await resolve(slug, "preview");
    if (!site) return reply.status(404).send({ error: "Unknown site" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Honeypot: real visitors never fill the hidden "website" field.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return reply.redirect(303, `${prefix}/thanks/`);
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
    return reply.redirect(303, `${prefix}/thanks/`);
  }

  // Any other GET: host-based routing when the Host matches the base domain,
  // otherwise the bare path form /<slug>/* serving the published release.
  app.get("/*", async (req, reply) => {
    const rest = ((req.params as { "*": string })["*"] ?? "").replace(/^\/+/, "");
    const target = hostToTarget(visitorHost(headersOf(req)));
    if (target) return serve(reply, target.slug, target.mode, rest);
    const [slug, ...restParts] = rest.split("/");
    if (!slug || RESERVED_ROOT_SEGMENTS.has(slug)) {
      return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_PAGE);
    }
    const prefix = mountPrefix(headersOf(req), `/${slug}`);
    // Directory URLs get the trailing slash, so the page's relative links
    // resolve inside the site instead of at the router root.
    if (!rest.endsWith("/") && !/\.[a-z0-9]+$/i.test(rest)) {
      return reply.redirect(308, `${prefix}/${restParts.join("/")}${restParts.length ? "/" : ""}`);
    }
    return serve(reply, slug, "live", restParts.join("/"), prefix);
  });

  return app;
}
