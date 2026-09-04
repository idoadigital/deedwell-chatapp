import sanitizeHtml from "sanitize-html";

/**
 * The designed page is model output and is served on a public origin, so it
 * is treated as untrusted HTML. This keeps the guarantees the template used
 * to give by construction: no script, no external resources, forms only to
 * this site's own endpoint, links that cannot run code. Structure and styling
 * pass through untouched — that is the whole point of letting a model design.
 */

const SVG_TAGS = [
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "symbol", "text", "tspan", "title", "desc",
];
const SVG_ATTRS = [
  "viewBox", "xmlns", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "transform", "opacity",
  "fill-opacity", "stroke-opacity", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "clip-path", "href", "preserveAspectRatio", "font-size", "font-weight", "text-anchor", "dominant-baseline",
  "aria-hidden", "focusable", "role", "class", "id", "style",
];

const ALLOWED_TAGS = [
  "html", "head", "body", "meta", "title", "style",
  "header", "nav", "main", "section", "article", "aside", "footer", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "em", "b", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "cite", "q", "code", "pre", "kbd",
  "br", "hr", "wbr", "blockquote", "figure", "figcaption", "address", "time",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "img", "picture", "source",
  "form", "fieldset", "legend", "label", "input", "textarea", "select", "option", "optgroup", "button",
  "details", "summary",
  ...SVG_TAGS,
];

const GLOBAL_ATTRS = ["class", "id", "style", "title", "lang", "dir", "role", "hidden", "tabindex", "aria-*", "data-*"];

export interface SanitizedPage {
  html: string;
  /** What was removed or rewritten, for the release's test report. */
  warnings: string[];
}

/** Strips anything in a stylesheet that could reach out of the page. */
export function sanitizeCss(css: string): { css: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = css;
  const rules: Array<[RegExp, string]> = [
    [/@import[^;]*;?/gi, "@import removed"],
    [/@font-face\s*\{[^}]*\}/gi, "@font-face removed"],
    [/expression\s*\([^)]*\)/gi, "expression() removed"],
    [/-moz-binding\s*:[^;}]*;?/gi, "-moz-binding removed"],
    [/behavior\s*:[^;}]*;?/gi, "behavior removed"],
  ];
  for (const [re, note] of rules) {
    if (re.test(out)) { warnings.push(note); out = out.replace(re, ""); }
  }
  // url() may only point at data: URIs (inline SVG backgrounds); anything
  // that would fetch from the network is dropped.
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, target: string) => {
    const t = target.trim().toLowerCase();
    if (t.startsWith("data:image/") || t.startsWith("#")) return m;
    warnings.push(`external url() removed: ${target.slice(0, 60)}`);
    return "none";
  });
  return { css: out, warnings };
}

export interface SanitizeOptions {
  /** The site's slug: every form must post to /forms/<slug>/<formKey>. */
  slug: string;
  /** The site's page URLs (e.g. "/", "/about/"): internal links are
   *  normalised onto them, so "/about" or "/about/index.html" become "/about/". */
  pageUrls?: string[];
  /** The site's pages with titles: any page no <nav> links to is added to
   *  the footer navigation, so every page stays reachable. */
  nav?: Array<{ title: string; href: string }>;
}

const escapeText = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/**
 * The header menu stays short by rule: at most `max` links in the header's
 * first <nav>. Extra links (with their <li> wrappers) are dropped; the footer
 * nav, which lists every page, is untouched.
 */
export function capHeaderNav(html: string, max = 5): string {
  const header = /<header\b[\s\S]*?<\/header>/i.exec(html);
  if (!header) return html;
  const nav = /<nav\b[\s\S]*?<\/nav>/i.exec(header[0]);
  if (!nav) return html;
  let seen = 0;
  const trimmed = nav[0].replace(/<li\b[^>]*>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/li>|<a\b[^>]*href="[^"]*"[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    seen += 1;
    return seen <= max ? m : "";
  });
  if (trimmed === nav[0]) return html;
  return html.replace(header[0], header[0].replace(nav[0], trimmed));
}

/**
 * Every page must be reachable from a navigation element. The header keeps
 * to a few links by design, so anything the designer left out of both navs
 * is appended to the footer nav (or a footer "All pages" nav is created).
 */
export function ensureNavCoverage(html: string, nav: Array<{ title: string; href: string }>): string {
  const navHtml = [...html.matchAll(/<nav\b[\s\S]*?<\/nav>/gi)].map((m) => m[0]).join("\n");
  const missing = nav.filter((n) => !navHtml.includes(`href="${n.href}"`));
  if (!missing.length) return html;
  const links = missing.map((n) => `<li><a href="${n.href}">${escapeText(n.title)}</a></li>`).join("");
  const footerNav = /<nav\b[^>]*aria-label="Footer"[^>]*>[\s\S]*?<\/nav>/i.exec(html);
  if (footerNav) {
    const patched = footerNav[0].replace(/<\/nav>$/i, `<ul class="nav-more">${links}</ul></nav>`);
    return html.replace(footerNav[0], patched);
  }
  const block = `<nav aria-label="All pages"><ul class="nav-more">${links}</ul></nav>`;
  if (/<\/footer>/i.test(html)) return html.replace(/<\/footer>/i, `${block}</footer>`);
  return html.replace(/<\/body>/i, `<footer>${block}</footer></body>`);
}

/** Links to the site's own pages in their canonical directory form. Models
 *  drop the trailing slash more often than not; the router would redirect,
 *  but the release check wants links that resolve as written. */
export function normalizeInternalLinks(html: string, pageUrls: string[]): string {
  const valid = new Set(pageUrls);
  return html.replace(/\bhref="(\/[^"#?]*)([#?][^"]*)?"/g, (m, path: string, tail: string | undefined) => {
    if (path.startsWith("/forms/")) return m;
    let p = path.replace(/\/index\.html$/, "/");
    if (!p.endsWith("/")) p = `${p}/`;
    if (p === "//") p = "/";
    return valid.has(p) ? `href="${p}${tail ?? ""}"` : m;
  });
}

export function sanitizePage(input: string, opts: SanitizeOptions): SanitizedPage {
  const warnings: string[] = [];
  if (/<script\b/i.test(input)) warnings.push("script removed");
  if (/<(iframe|object|embed|link|base)\b/i.test(input)) warnings.push("embedded or external element removed");
  if (/\bon[a-z]+\s*=/i.test(input)) warnings.push("inline event handler removed");

  // Stylesheets are cleaned separately, then put back through the allowlist.
  const styled = input.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    const cleaned = sanitizeCss(css);
    warnings.push(...cleaned.warnings);
    return `<style>${cleaned.css}</style>`;
  });

  let html = sanitizeHtml(styled, {
    allowedTags: ALLOWED_TAGS,
    // <style> is the reason this file exists; its content was cleaned above.
    allowVulnerableTags: true,
    allowedAttributes: {
      "*": GLOBAL_ATTRS,
      html: ["lang"],
      meta: ["charset", "name", "content", "property"],
      a: ["href", "target", "rel", "download"],
      img: ["src", "alt", "width", "height", "loading", "decoding"],
      source: ["srcset", "type", "media"],
      form: ["action", "method", "novalidate"],
      input: ["type", "name", "value", "placeholder", "required", "autocomplete", "min", "max", "step", "pattern", "checked", "inputmode"],
      textarea: ["name", "rows", "cols", "placeholder", "required", "autocomplete", "maxlength"],
      select: ["name", "required", "multiple"],
      option: ["value", "selected"],
      button: ["type", "name", "value"],
      label: ["for"],
      time: ["datetime"],
      th: ["scope", "colspan", "rowspan"],
      td: ["colspan", "rowspan"],
      col: ["span"],
      details: ["open"],
      abbr: ["title"],
      q: ["cite"],
      ...Object.fromEntries(SVG_TAGS.map((t) => [t, SVG_ATTRS])),
    },
    allowedSchemes: ["https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data"], source: ["data"], use: [], a: ["https", "mailto", "tel"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "srcset"],
    allowProtocolRelative: false,
    // Root-relative links (/about/) are the site's own; keep them.
    parser: { lowerCaseAttributeNames: false },
    transformTags: {
      a: (tag, attribs) => {
        const out = { ...attribs };
        if (out.target === "_blank") out.rel = "noopener noreferrer";
        return { tagName: tag, attribs: out };
      },
      input: (tag, attribs) => {
        const out = { ...attribs };
        const type = (out.type ?? "text").toLowerCase();
        if (!["text", "email", "tel", "url", "number", "hidden", "checkbox", "radio", "date", "submit"].includes(type)) out.type = "text";
        return { tagName: tag, attribs: out };
      },
    },
    exclusiveFilter: (frame) => {
      // An <img> that lost its src to the scheme rule would fail the release
      // check anyway; drop it whole rather than ship a broken image.
      if (frame.tag === "img" && !frame.attribs.src) { warnings.push("image without an allowed src removed"); return true; }
      return false;
    },
  });

  // Every form posts to this site's own endpoint with the honeypot field the
  // router expects — whatever the model wrote.
  html = html.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi, (_m, attrs: string, inner: string) => {
    const action = /\baction="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    const key = /\/forms\/[a-z0-9-]+\/([a-z0-9-]{1,40})\/?$/i.exec(action)?.[1]?.toLowerCase() ?? "contact";
    const rest = attrs.replace(/\s*(action|method)="[^"]*"/gi, "");
    // One honeypot per form, ours, whatever the model wrote.
    const body = inner.replace(/<input\b[^>]*\bname="website"[^>]*>/gi, "");
    return `<form method="post" action="/forms/${opts.slug}/${key}"${rest}><input type="hidden" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true">${body}</form>`;
  });

  if (opts.pageUrls?.length) html = normalizeInternalLinks(html, opts.pageUrls);
  if (opts.nav?.length) html = ensureNavCoverage(capHeaderNav(html), opts.nav);

  // Document scaffolding the checks and browsers rely on.
  if (!/<html\b[^>]*\blang=/i.test(html)) html = html.replace(/<html\b/i, '<html lang="en"');
  if (!/<meta charset=/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (m) => `${m}<meta charset="utf-8">`);
  if (!/<meta name="viewport"/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}<meta name="viewport" content="width=device-width, initial-scale=1">`);
  }
  if (!/^\s*<!doctype html>/i.test(html)) html = `<!doctype html>\n${html}`;

  return { html, warnings: [...new Set(warnings)] };
}

/** The pieces later pages must reuse so the site reads as one design. */
export function extractSharedDesign(html: string): { styles: string; header: string; footer: string } | null {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!.trim()).join("\n");
  const header = /<header\b[\s\S]*?<\/header>/i.exec(html)?.[0] ?? "";
  const footer = /<footer\b[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? "";
  if (!styles || !header) return null;
  return { styles, header, footer };
}

/** A designed page is usable when it has the bones a page needs. Anything
 *  less falls back to the template rather than shipping a broken page. */
export function looksLikeAPage(html: string): boolean {
  return (
    html.length > 700 &&
    /<main\b/i.test(html) &&
    (html.match(/<h1[\s>]/gi) ?? []).length === 1 &&
    /<nav\b/i.test(html) &&
    /<style\b/i.test(html)
  );
}
