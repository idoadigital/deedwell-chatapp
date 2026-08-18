import type { SiteBlock, SitePage, SiteTheme } from "@deedwell/schemas";
import { themeTokens } from "./theme.js";
import { BASE_CSS } from "./styles.js";

/**
 * Approved-template static renderer (BRD §10.2: structured component
 * generation, never arbitrary code). Output is self-contained accessible HTML
 * with inline CSS, zero JavaScript, and all user content escaped.
 *
 * The model chooses which blocks appear and what they say. It never chooses
 * markup, classes, or colours — this file is the only author of HTML, which is
 * what makes injection impossible by construction rather than by sanitising.
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
  /** Shown in the footer — funders check registration status. */
  registration?: string | null;
  contactEmail?: string | null;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** hrefs are restricted to internal paths, http(s), mailto and tel —
 *  javascript: etc. are dropped. Internal directory paths are normalized to a
 *  trailing slash so model-written links like "/about-us" resolve to the real
 *  "/about-us/". */
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
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(trimmed)) return esc(trimmed);
  if (/^tel:[+0-9()\s.-]+$/i.test(trimmed)) return esc(trimmed);
  return "#";
}

function paras(body: string): string {
  return body
    .split(/\n\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `<p>${esc(t)}</p>`)
    .join("");
}

function pagePath(slug: string): string {
  return slug === "home" ? "index.html" : `${slug}/index.html`;
}
export function pageUrl(slug: string): string {
  return slug === "home" ? "/" : `/${slug}/`;
}

// ---------------------------------------------------------------------------
// Section tone
// ---------------------------------------------------------------------------

type Tone = "plain" | "band" | "accent" | "deep";

/**
 * A page reads as a template when every section looks identical, so tone is
 * assigned here rather than by the model.
 *
 * Two rules, both learned from looking at the output: a section never repeats
 * the tone directly above it (two tinted bands in a row merge into one dead
 * expanse), and blocks with an inherent treatment — impact figures, asks —
 * keep it.
 */
function assignTones(kinds: ReadonlyArray<SiteBlock["kind"]>): Tone[] {
  const intrinsic = (k: SiteBlock["kind"]): Tone | null =>
    k === "stats" ? "accent" : k === "cta" || k === "donate" ? "deep" : null;

  const tones: Tone[] = [];
  let last: Tone | null = null;
  for (const kind of kinds) {
    if (kind === "hero") { tones.push("plain"); last = null; continue; }
    let tone = intrinsic(kind);
    if (tone === null) {
      // Neutral sections simply alternate against whatever preceded them.
      tone = last === "band" ? "plain" : "band";
    } else if (tone === last) {
      // Two coloured asks back to back: vary the second so the page doesn't
      // read as one undifferentiated slab.
      tone = tone === "deep" ? "accent" : "deep";
    }
    tones.push(tone);
    last = tone;
  }
  return tones;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function renderBlock(block: SiteBlock, siteSlug: string, formBase: string, tone: Tone): string {
  const shell = (inner: string) =>
    `<section class="band tone-${tone}"><div class="wrap">${inner}</div></section>`;

  switch (block.kind) {
    case "hero": {
      const primary = block.ctaText && block.ctaHref
        ? `<a class="button" href="${safeHref(block.ctaHref)}">${esc(block.ctaText)}</a>` : "";
      const secondary = block.secondaryText && block.secondaryHref
        ? `<a class="button ghost" href="${safeHref(block.secondaryHref)}">${esc(block.secondaryText)}</a>` : "";
      const actions = primary || secondary ? `<div class="actions">${primary}${secondary}</div>` : "";
      return `<section class="hero"><div class="wrap">${
        block.eyebrow ? `<p class="eyebrow">${esc(block.eyebrow)}</p>` : `<div class="hero-rule"></div>`
      }<h1>${esc(block.heading)}</h1>${
        block.tagline ? `<p class="lead">${esc(block.tagline)}</p>` : ""
      }${actions}</div></section>`;
    }

    case "text":
      return shell(
        `${block.heading ? `<div class="section-head"><h2>${esc(block.heading)}</h2></div>` : ""}<div class="prose">${paras(block.body)}</div>`
      );

    case "split": {
      const cta = block.ctaText && block.ctaHref
        ? `<div class="actions"><a class="button" href="${safeHref(block.ctaHref)}">${esc(block.ctaText)}</a></div>` : "";
      const panel = block.highlights.length
        ? `<aside class="split-panel"><ul>${block.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></aside>`
        : "";
      return shell(
        `<div class="split"><div><h2>${esc(block.heading)}</h2><div class="prose">${paras(block.body)}</div>${cta}</div>${panel}</div>`
      );
    }

    case "programs":
      return shell(
        `<div class="section-head"><h2>${esc(block.heading)}</h2></div><div class="cards">${block.items
          .map((it, i) =>
            `<article class="card"><span class="num">${String(i + 1).padStart(2, "0")}</span><h3>${esc(it.name)}</h3><p>${esc(it.description)}</p></article>`)
          .join("")}</div>`
      );

    case "stats":
      return shell(
        `<div class="stats">${block.items
          .map((it) => `<div class="stat"><span class="v">${esc(it.value)}</span><span class="l">${esc(it.label)}</span></div>`)
          .join("")}</div>`
      );

    case "quote":
      return shell(
        `<figure class="quote"><blockquote>${esc(block.quote)}</blockquote>${
          block.attribution
            ? `<figcaption><div class="who">${esc(block.attribution)}</div>${
                block.role ? `<div class="role">${esc(block.role)}</div>` : ""
              }</figcaption>`
            : ""
        }</figure>`
      );

    case "steps":
      return shell(
        `<div class="section-split"><div class="section-head"><h2>${esc(block.heading)}</h2>${
          block.intro ? `<p>${esc(block.intro)}</p>` : ""
        }</div><div class="steps">${block.items
          .map((it) => `<div class="step"><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div>`)
          .join("")}</div></div>`
      );

    case "faq":
      return shell(
        `<div class="section-split"><div class="section-head"><h2>${esc(block.heading)}</h2></div><div class="faq">${block.items
          .map((it) => `<details><summary>${esc(it.q)}</summary><p>${esc(it.a)}</p></details>`)
          .join("")}</div></div>`
      );

    case "team":
      return shell(
        `<div class="section-head"><h2>${esc(block.heading)}</h2></div><div class="team">${block.members
          .map((m) =>
            `<article class="member"><div class="name">${esc(m.name)}</div><div class="role">${esc(m.role)}</div>${
              m.bio ? `<p>${esc(m.bio)}</p>` : ""
            }</article>`)
          .join("")}</div>`
      );

    case "logos":
      return shell(
        `<div class="section-head"><h2>${esc(block.heading)}</h2></div><div class="logos">${block.names
          .map((n) => `<span>${esc(n)}</span>`)
          .join("")}</div>`
      );

    case "cta":
      return shell(
        `<div class="wrap-narrow"><h2>${esc(block.heading)}</h2><div class="actions"><a class="button" href="${safeHref(block.href)}">${esc(block.buttonText)}</a></div></div>`
      );

    case "donate": {
      const tiers = block.tiers.length
        ? `<div class="tiers">${block.tiers
            .map((t) => `<div class="tier"><span class="amt">${esc(t.amount)}</span><span class="eff">${esc(t.effect)}</span></div>`)
            .join("")}</div>`
        : "";
      return shell(
        `<div class="wrap-narrow"><h2>${esc(block.heading)}</h2>${
          block.body ? `<p class="lead">${esc(block.body)}</p>` : ""
        }${tiers}<div class="actions"><a class="button" href="${safeHref(block.href)}">${esc(block.buttonText)}</a></div></div>`
      );
    }

    case "contact": {
      const items = [
        block.email
          ? `<div class="contact-item"><div class="k">Email</div><div class="v"><a href="${safeHref(`mailto:${block.email}`)}">${esc(block.email)}</a></div></div>`
          : "",
        block.phone
          ? `<div class="contact-item"><div class="k">Phone</div><div class="v"><a href="${safeHref(`tel:${block.phone.replace(/[^+0-9]/g, "")}`)}">${esc(block.phone)}</a></div></div>`
          : "",
        block.address
          ? `<div class="contact-item"><div class="k">Address</div><div class="v"><address style="font-style:normal">${esc(block.address)}</address></div></div>`
          : "",
      ].filter(Boolean).join("");
      return shell(
        `<div class="section-head"><h2>Contact</h2></div>${
          items ? `<div class="contact-grid">${items}</div>` : `<p>Reach us using the form below.</p>`
        }`
      );
    }

    case "form":
      return shell(
        `<div class="section-head"><h2>${esc(block.heading)}</h2></div><form class="dw" method="post" action="${esc(formBase)}/forms/${esc(siteSlug)}/${esc(block.formKey)}">${block.fields
          .map((f) => {
            const id = `${block.formKey}-${f.key}`;
            const req = f.required ? " required" : "";
            const input =
              f.type === "textarea"
                ? `<textarea id="${id}" name="${esc(f.key)}" rows="5"${req}></textarea>`
                : `<input id="${id}" name="${esc(f.key)}" type="${f.type}"${req}>`;
            return `<div class="field"><label for="${id}">${esc(f.label)}${
              f.required ? ` <span class="req" aria-hidden="true">*</span>` : ""
            }</label>${input}</div>`;
          })
          .join("")}<label class="hp" for="${block.formKey}-website" aria-hidden="true">Leave this field empty</label><input class="hp" id="${block.formKey}-website" name="website" type="text" tabindex="-1" autocomplete="off"><button class="button" type="submit">Send message</button></form>`
      );
  }
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function renderSite(input: RenderSiteInput): RenderedFile[] {
  const formBase = input.formBase ?? "";
  const style = `${themeTokens(input.theme)}\n${BASE_CSS}`;

  // The primary action from the homepage hero doubles as the header CTA, so
  // the main ask follows the visitor through the site instead of living only
  // above the fold.
  const home = input.pages.find((p) => p.slug === "home");
  const heroCta = home?.blocks.find((b) => b.kind === "hero") as
    | Extract<SiteBlock, { kind: "hero" }>
    | undefined;
  const headerCta =
    heroCta?.ctaText && heroCta.ctaHref
      ? `<a class="nav-cta" href="${safeHref(heroCta.ctaHref)}">${esc(heroCta.ctaText)}</a>`
      : "";

  const nav = (current: string) =>
    `<div class="nav-links">${input.pages
      .map((p) =>
        `<a href="${pageUrl(p.slug)}"${p.slug === current ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`)
      .join("")}${headerCta}</div>`;

  const footer = `<footer class="site"><div class="wrap"><div class="foot-grid">
<div><div class="foot-brand">${esc(input.siteName)}</div>${
    input.registration ? `<p>${esc(input.registration)}</p>` : ""
  }${input.contactEmail ? `<p><a href="${safeHref(`mailto:${input.contactEmail}`)}">${esc(input.contactEmail)}</a></p>` : ""}</div>
<div><h2>Pages</h2><ul>${input.pages
    .map((p) => `<li><a href="${pageUrl(p.slug)}">${esc(p.title)}</a></li>`)
    .join("")}</ul></div>
</div><div class="foot-legal"><span>© ${esc(input.siteName)}</span><span>Built with Deedwell</span></div></div></footer>`;

  const shellPage = (title: string, description: string, body: string, canonical: string) =>
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(input.siteName)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)} — ${esc(input.siteName)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="canonical" href="${esc(canonical)}">
<style>${style}</style>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
${body}
</body>
</html>`;

  const files: RenderedFile[] = input.pages.map((page) => {
    const tones = assignTones(page.blocks.map((b) => b.kind));
    const blocks = page.blocks
      .map((b, i) => renderBlock(b, input.slug, formBase, tones[i]!))
      .join("\n");

    const hasHero = page.blocks.some((b) => b.kind === "hero");
    const intro = hasHero
      ? ""
      : `<section class="hero"><div class="wrap"><div class="hero-rule"></div><h1>${esc(page.title)}</h1>${
          page.seoDescription ? `<p class="lead">${esc(page.seoDescription)}</p>` : ""
        }</div></section>\n`;

    return {
      path: pagePath(page.slug),
      contentType: "text/html; charset=utf-8",
      content: shellPage(
        page.title,
        page.seoDescription,
        `<header class="site"><div class="wrap"><nav class="nav" aria-label="Main"><a class="brand" href="/">${esc(input.siteName)}</a>${nav(page.slug)}</nav></div></header>
<main id="main">
${intro}${blocks}
</main>
${footer}`,
        pageUrl(page.slug)
      ),
    };
  });

  const miniPage = (title: string, message: string, path: string): RenderedFile => ({
    path,
    contentType: "text/html; charset=utf-8",
    content: shellPage(
      title,
      message,
      `<header class="site"><div class="wrap"><nav class="nav" aria-label="Main"><a class="brand" href="/">${esc(input.siteName)}</a>${nav("")}</nav></div></header>
<main id="main"><section class="hero"><div class="wrap"><div class="hero-rule"></div><h1>${esc(title)}</h1><p class="lead">${esc(message)}</p><div class="actions"><a class="button" href="/">Back to home</a></div></div></section></main>
${footer}`,
      "/"
    ),
  });

  files.push({
    path: "sitemap.xml",
    contentType: "application/xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${input.pages.map((p) => `  <url><loc>${esc(pageUrl(p.slug))}</loc></url>`).join("\n")}
</urlset>`,
  });
  files.push({ path: "robots.txt", contentType: "text/plain", content: "User-agent: *\nAllow: /\n" });
  files.push(miniPage("Page not found", "That page doesn't exist here. It may have moved.", "404.html"));
  files.push(miniPage("Thank you", "Your message has been received. We'll be in touch.", "thanks/index.html"));
  return files;
}
