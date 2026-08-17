import type { SiteBlock, SitePage, SiteTheme } from "@deedwell/schemas";

/**
 * Approved-template static renderer (BRD §10.2: structured component
 * generation, never arbitrary code). Output is self-contained accessible HTML
 * with inline CSS, zero JavaScript, and all user content escaped.
 */

export interface RenderedFile {
  path: string; // relative, e.g. "index.html", "about/index.html"
  content: string;
  contentType: string;
}

export interface RenderSiteInput {
  siteName: string;
  slug: string;
  pages: SitePage[];
  theme: SiteTheme;
  /** Base for form posts; the Site Router serves forms on the site's own origin. */
  formBase?: string;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** hrefs are restricted to internal paths or http(s) — javascript: etc. are
 *  dropped. Internal directory paths are normalized to a trailing slash so
 *  model-written links like "/about-us" resolve to the real "/about-us/". */
function safeHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    const needsSlash =
      trimmed !== "/" && !trimmed.endsWith("/") &&
      !trimmed.includes("#") && !trimmed.startsWith("/forms/") &&
      !/\.[a-z0-9]+$/i.test(trimmed);
    return esc(needsSlash ? `${trimmed}/` : trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) return esc(trimmed);
  return "#";
}

// Approved palettes — contrast-validated pairs (all text/bg combos >= 4.5:1).
const PALETTES: Record<SiteTheme["palette"], { bg: string; surface: string; text: string; muted: string; accent: string; accentText: string }> = {
  forest: { bg: "#f6f8f4", surface: "#ffffff", text: "#1a2e1d", muted: "#44614a", accent: "#1e6b34", accentText: "#ffffff" },
  ocean: { bg: "#f3f7fa", surface: "#ffffff", text: "#122a3a", muted: "#3d5e75", accent: "#0b5a8a", accentText: "#ffffff" },
  slate: { bg: "#f5f6f8", surface: "#ffffff", text: "#1f2430", muted: "#4a5266", accent: "#333d55", accentText: "#ffffff" },
  sunrise: { bg: "#fdf7f2", surface: "#ffffff", text: "#3a2214", muted: "#7a4a2c", accent: "#a04716", accentText: "#ffffff" },
  plum: { bg: "#f8f5fa", surface: "#ffffff", text: "#2a1a30", muted: "#5d4066", accent: "#6d2b84", accentText: "#ffffff" },
  meadow: { bg: "#f4f8f1", surface: "#ffffff", text: "#1f2e16", muted: "#49603c", accent: "#3e6b1f", accentText: "#ffffff" },
  harvest: { bg: "#faf6ee", surface: "#ffffff", text: "#33270f", muted: "#6b5527", accent: "#7a5410", accentText: "#ffffff" },
  midnight: { bg: "#0f141c", surface: "#1a2130", text: "#e8ecf4", muted: "#a9b4c8", accent: "#7db3f0", accentText: "#0b1220" },
};

function css(theme: SiteTheme): string {
  const p = PALETTES[theme.palette];
  const heading = theme.headingFont === "serif" ? "Georgia, 'Times New Roman', serif" : "system-ui, sans-serif";
  return `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:17px;line-height:1.6;color:${p.text};background:${p.bg}}
h1,h2,h3{font-family:${heading};line-height:1.25;color:${p.text}}
a{color:${p.accent}}
.skip{position:absolute;left:-999px;top:0;background:${p.accent};color:${p.accentText};padding:8px 14px}
.skip:focus{left:8px;z-index:10}
header.site{background:${p.surface};border-bottom:1px solid #00000014}
.nav{max-width:960px;margin:0 auto;padding:14px 20px;display:flex;flex-wrap:wrap;gap:6px 20px;align-items:center}
.nav .brand{font-weight:700;font-size:19px;color:${p.text};text-decoration:none;margin-right:auto}
.nav a{text-decoration:none;color:${p.muted};padding:6px 2px}
.nav a[aria-current="page"]{color:${p.accent};font-weight:600;border-bottom:2px solid ${p.accent}}
main{max-width:960px;margin:0 auto;padding:24px 20px 60px}
.page-title{font-size:clamp(26px,4vw,36px);margin:26px 0 6px}
.hero{background:${p.surface};border-radius:14px;padding:52px 36px;margin:22px 0;text-align:center}
.hero h1{font-size:clamp(28px,5vw,44px);margin:0 0 12px}
.hero p{font-size:19px;color:${p.muted};max-width:640px;margin:0 auto 22px}
.button{display:inline-block;background:${p.accent};color:${p.accentText};padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600}
section.block{margin:34px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{background:${p.surface};border-radius:12px;padding:22px}
.card h3{margin-top:0}
.stats{display:flex;flex-wrap:wrap;gap:16px;justify-content:center}
.stat{background:${p.surface};border-radius:12px;padding:18px 30px;text-align:center;min-width:150px}
.stat .v{font-size:26px;font-weight:700;color:${p.accent}}
.stat .l{color:${p.muted};font-size:14px}
.ctaband{background:${p.accent};color:${p.accentText};border-radius:14px;padding:34px;text-align:center}
.ctaband h2{color:${p.accentText};margin-top:0}
.ctaband .button{background:${p.surface};color:${p.accent}}
form.dw{background:${p.surface};border-radius:12px;padding:26px;max-width:560px}
form.dw label{display:block;font-weight:600;margin:14px 0 4px}
form.dw input,form.dw textarea{width:100%;padding:10px;border:1px solid #00000033;border-radius:6px;font:inherit}
form.dw button{margin-top:18px;border:0;cursor:pointer}
.hp{position:absolute;left:-9999px}
footer.site{border-top:1px solid #00000014;color:${p.muted};font-size:14px;text-align:center;padding:26px 20px}
`.trim();
}

function pagePath(slug: string): string {
  return slug === "home" ? "index.html" : `${slug}/index.html`;
}
export function pageUrl(slug: string): string {
  return slug === "home" ? "/" : `/${slug}/`;
}

function renderBlock(block: SiteBlock, siteSlug: string, formBase: string): string {
  switch (block.kind) {
    case "hero":
      return `<div class="hero"><h1>${esc(block.heading)}</h1><p>${esc(block.tagline)}</p>${
        block.ctaText && block.ctaHref
          ? `<a class="button" href="${safeHref(block.ctaHref)}">${esc(block.ctaText)}</a>`
          : ""
      }</div>`;
    case "text":
      return `<section class="block">${block.heading ? `<h2>${esc(block.heading)}</h2>` : ""}${block.body
        .split(/\n\n+/)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("")}</section>`;
    case "programs":
      return `<section class="block"><h2>${esc(block.heading)}</h2><div class="cards">${block.items
        .map((it) => `<div class="card"><h3>${esc(it.name)}</h3><p>${esc(it.description)}</p></div>`)
        .join("")}</div></section>`;
    case "stats":
      return `<section class="block"><div class="stats">${block.items
        .map((it) => `<div class="stat"><div class="v">${esc(it.value)}</div><div class="l">${esc(it.label)}</div></div>`)
        .join("")}</div></section>`;
    case "cta":
      return `<section class="block"><div class="ctaband"><h2>${esc(block.heading)}</h2><a class="button" href="${safeHref(block.href)}">${esc(block.buttonText)}</a></div></section>`;
    case "contact":
      return `<section class="block"><h2>Contact</h2><p>${[
        block.email ? `Email: ${esc(block.email)}` : "",
        block.phone ? `Phone: ${esc(block.phone)}` : "",
        block.address ? esc(block.address) : "",
      ]
        .filter(Boolean)
        .join("<br>") || "Reach us via the form below."}</p></section>`;
    case "form":
      return `<section class="block"><form class="dw" method="post" action="${esc(formBase)}/forms/${esc(siteSlug)}/${esc(block.formKey)}"><h2>${esc(block.heading)}</h2>${block.fields
        .map((f) => {
          const id = `${block.formKey}-${f.key}`;
          const req = f.required ? " required" : "";
          const input =
            f.type === "textarea"
              ? `<textarea id="${id}" name="${esc(f.key)}" rows="4"${req}></textarea>`
              : `<input id="${id}" name="${esc(f.key)}" type="${f.type}"${req}>`;
          return `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}`;
        })
        .join("")}<label class="hp" for="${block.formKey}-website" aria-hidden="true">Leave this field empty</label><input class="hp" id="${block.formKey}-website" name="website" type="text" tabindex="-1" autocomplete="off"><button class="button" type="submit">Send</button></form></section>`;
  }
}

export function renderSite(input: RenderSiteInput): RenderedFile[] {
  const formBase = input.formBase ?? "";
  const style = css(input.theme);
  const nav = (current: string) =>
    input.pages
      .map(
        (p) =>
          `<a href="${pageUrl(p.slug)}"${p.slug === current ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`
      )
      .join("");

  const files: RenderedFile[] = input.pages.map((page) => ({
    path: pagePath(page.slug),
    contentType: "text/html; charset=utf-8",
    content: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} — ${esc(input.siteName)}</title>
<meta name="description" content="${esc(page.seoDescription)}">
<style>${style}</style>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="site"><nav class="nav" aria-label="Main"><a class="brand" href="/">${esc(input.siteName)}</a>${nav(page.slug)}</nav></header>
<main id="main">
${page.blocks.some((b) => b.kind === "hero") ? "" : `<h1 class="page-title">${esc(page.title)}</h1>\n`}${page.blocks.map((b) => renderBlock(b, input.slug, formBase)).join("\n")}
</main>
<footer class="site">© ${esc(input.siteName)} · Built with Deedwell</footer>
</body>
</html>`,
  }));

  files.push({
    path: "sitemap.xml",
    contentType: "application/xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${input.pages.map((p) => `  <url><loc>${esc(pageUrl(p.slug))}</loc></url>`).join("\n")}
</urlset>`,
  });
  files.push({ path: "robots.txt", contentType: "text/plain", content: "User-agent: *\nAllow: /\n" });
  files.push({
    path: "404.html",
    contentType: "text/html; charset=utf-8",
    content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found — ${esc(input.siteName)}</title><meta name="description" content="Page not found."><style>${style}</style></head><body><a class="skip" href="#main">Skip to main content</a><main id="main"><div class="hero"><h1>Page not found</h1><p>That page doesn't exist here. It may have moved.</p><a class="button" href="/">Back to home</a></div></main></body></html>`,
  });
  files.push({
    path: "thanks/index.html",
    contentType: "text/html; charset=utf-8",
    content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thank you — ${esc(input.siteName)}</title><meta name="description" content="Thank you for your message."><style>${style}</style></head><body><a class="skip" href="#main">Skip to main content</a><main id="main"><div class="hero"><h1>Thank you</h1><p>Your message has been received.</p><a class="button" href="/">Back to home</a></div></main></body></html>`,
  });
  return files;
}
