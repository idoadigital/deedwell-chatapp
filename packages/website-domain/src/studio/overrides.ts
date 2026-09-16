import type { StyleOverride } from "@deedwell/schemas";

/**
 * The overrides layer: scoped CSS the editor and the QA repairer write on
 * top of the deterministic render. It is the smallest change mechanism the
 * site has — "make the mobile hero heading smaller" is one rule at one
 * width — and it is validated here so no model output can smuggle a URL,
 * an import or an expression into a page.
 */

/** Properties an override may set. Layout-affecting but bounded. */
export const ALLOWED_PROPERTIES = new Set([
  "font-size", "line-height", "font-weight", "letter-spacing", "text-align", "text-transform", "font-style", "text-decoration",
  "color", "background", "background-color", "border-color", "border", "border-radius", "border-width", "opacity", "box-shadow",
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "margin-inline", "margin-block",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "padding-inline", "padding-block",
  "gap", "row-gap", "column-gap", "width", "max-width", "min-width", "height", "max-height", "min-height",
  "display", "flex-direction", "flex-wrap", "align-items", "justify-content", "order", "grid-template-columns",
  "object-fit", "object-position", "aspect-ratio", "overflow", "overflow-x", "overflow-wrap", "word-break", "white-space",
  "visibility", "position", "top", "bottom", "left", "right", "z-index", "text-shadow", "filter", "transform", "transition",
]);

/** Value grammar: numbers, units, keywords, colours, simple functions with
 *  those inside. No url(), no expression(), no @, no braces or semicolons. */
const VALUE = /^[A-Za-z0-9#%.,+\-\s()\/*"'!]+$/;
const FORBIDDEN = /url\s*\(|expression|@import|javascript:|behavior|binding|\\|<|>|\{|\}|;/i;
const SELECTOR = /^[A-Za-z0-9_\-#.\s>:\[\]="'*+~,()]+$/;

export function cleanDeclarations(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const prop = k.trim().toLowerCase();
    const value = String(v).trim();
    if (!ALLOWED_PROPERTIES.has(prop)) continue;
    if (!VALUE.test(value) || FORBIDDEN.test(value) || value.length > 200) continue;
    out[prop] = value;
  }
  return out;
}

export function cleanSelector(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s || s.length > 160 || !SELECTOR.test(s) || FORBIDDEN.test(s)) return null;
  return s;
}

const MEDIA: Record<StyleOverride["viewport"], string | null> = {
  all: null,
  mobile: "(max-width: 639px)",
  tablet: "(min-width: 640px) and (max-width: 1023px)",
  desktop: "(min-width: 1024px)",
};

/** The CSS for one page's overrides (its own plus the site-wide ones), in
 *  the order they were written so a later rule wins. */
export function overridesCss(overrides: StyleOverride[], pageSlug: string): string {
  const rules: string[] = [];
  for (const o of overrides) {
    if (o.page !== "*" && o.page !== pageSlug) continue;
    const selector = cleanSelector(o.selector);
    const decls = cleanDeclarations(o.declarations);
    if (!selector || !Object.keys(decls).length) continue;
    // !important so an override beats the base stylesheet's own media rules
    // regardless of specificity — that is the point of an override.
    const body = Object.entries(decls).map(([p, v]) => `${p}:${v.replace(/\s*!important\s*$/i, "")} !important`).join(";");
    const rule = `${selector}{${body}}`;
    const media = MEDIA[o.viewport ?? "all"];
    rules.push(media ? `@media ${media}{${rule}}` : rule);
  }
  return rules.join("\n");
}

/** Adds the overrides block to a rendered page; replaces an existing one. */
export function injectOverrides(html: string, css: string): string {
  const stripped = html.replace(/<style id="site-overrides">[\s\S]*?<\/style>\n?/i, "");
  if (!css.trim()) return stripped;
  const tag = `<style id="site-overrides">${css}</style>\n`;
  return /<\/head>/i.test(stripped) ? stripped.replace(/<\/head>/i, `${tag}</head>`) : tag + stripped;
}

/** Merges a new override into the list: an override for the same page +
 *  selector + viewport replaces the old one property by property. */
export function mergeOverride(list: StyleOverride[], next: StyleOverride): StyleOverride[] {
  const idx = list.findIndex((o) => o.page === next.page && o.selector === next.selector && (o.viewport ?? "all") === (next.viewport ?? "all"));
  if (idx === -1) return [...list, next];
  const merged = { ...list[idx]!, declarations: { ...list[idx]!.declarations, ...next.declarations }, note: next.note ?? list[idx]!.note };
  return list.map((o, i) => (i === idx ? merged : o));
}
