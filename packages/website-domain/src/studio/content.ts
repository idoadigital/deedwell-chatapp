import sanitizeHtml from "sanitize-html";

/**
 * Dynamic content pages — blog and events — rendered by the site router at
 * request time inside the site's own shell (its head, styles, header and
 * footer, lifted from the release's home page), so a new post never
 * regenerates the website and still looks like part of it.
 */

export interface SitePostRow { slug: string; title: string; excerpt: string; content: string; author: string | null; featured_image_key: string | null; published_at: string | Date | null; seo_title: string | null; seo_description: string | null }
export interface SiteEventRow { slug: string; title: string; description: string; featured_image_key: string | null; starts_at: string | Date; ends_at: string | Date | null; location: string | null; mode: string; registration_url: string | null; cta_label: string | null; organizer: string | null; status: string }

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export interface Shell { head: string; header: string; footer: string; script: string; title: string }

/** Lifts the shell out of a rendered page. */
export function extractShell(html: string, siteName: string): Shell {
  const head = /<head>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(siteName)}</title>`;
  const header = /<header[\s\S]*?<\/header>/i.exec(html)?.[0] ?? "";
  const footer = /<footer[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? "";
  const script = /<script>[\s\S]*?<\/script>/i.exec(html)?.[0] ?? "";
  return { head: head.replace(/<title>[\s\S]*?<\/title>/i, "").replace(/<meta name="description"[^>]*>/i, "").replace(/<meta property="og:[^>]*>/gi, "").replace(/<link rel="canonical"[^>]*>/i, ""), header, footer, script, title: siteName };
}

/** Markdown-lite → safe HTML: paragraphs, headings, lists, emphasis, links. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const inline = (t: string) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } if (list) { out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) { flush(); const lvl = h[1]!.length + 1; out.push(`<h${lvl}>${inline(h[2]!)}</h${lvl}>`); continue; }
    const li = /^[-*]\s+(.+)$/.exec(line);
    if (li) { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } (list ??= []).push(li[1]!); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) { out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`); list = null; }
    para.push(line.trim());
  }
  flush();
  return sanitizeHtml(out.join("\n"), { allowedTags: ["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "a", "br"], allowedAttributes: { a: ["href"] }, allowedSchemes: ["http", "https", "mailto"] });
}

const fmtDate = (d: string | Date | null | undefined, withTime = false) => {
  if (!d) return "";
  const date = new Date(d);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) });
};

function page(shell: Shell, args: { title: string; description: string; canonical: string; main: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
${shell.head}
<title>${esc(args.title)} — ${esc(shell.title)}</title>
<meta name="description" content="${esc(args.description)}">
<link rel="canonical" href="${esc(args.canonical)}">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
${shell.header}
<main id="main">${args.main}</main>
${shell.footer}
${shell.script}
</body>
</html>`;
}

const imageTag = (key: string | null, alt: string, cls = "") => (key ? `<figure class="media ${cls}"><img src="/images/${esc(key)}.png" alt="${esc(alt)}" loading="lazy" decoding="async"></figure>` : "");

export function renderPostList(shell: Shell, posts: SitePostRow[]): string {
  const items = posts.map((p) => `<article class="card">${imageTag(p.featured_image_key, p.title)}<div class="card__body"><p class="eyebrow">${esc(fmtDate(p.published_at))}${p.author ? ` · ${esc(p.author)}` : ""}</p><h2 class="t-h3"><a href="/blog/${esc(p.slug)}/">${esc(p.title)}</a></h2>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}</div></article>`).join("");
  const main = `<section class="hero hero--minimal" id="blog"><div class="container container--narrow hero__inner"><div class="hero__copy"><h1 class="t-h1">Blog</h1><p class="lead">News and stories from ${esc(shell.title)}.</p></div></div></section>
<section class="section" id="posts" aria-labelledby="posts-h"><div class="container"><h2 id="posts-h" class="visually-hidden">Posts</h2>${posts.length ? `<div class="cards">${items}</div>` : `<p class="lead">No posts yet — check back soon.</p>`}</div></section>`;
  return page(shell, { title: "Blog", description: `News and stories from ${shell.title}.`, canonical: "/blog/", main });
}

export function renderPost(shell: Shell, post: SitePostRow): string {
  const main = `<article class="section" id="post" aria-labelledby="post-h"><div class="container container--narrow"><p class="eyebrow"><a href="/blog/">Blog</a> · ${esc(fmtDate(post.published_at))}${post.author ? ` · ${esc(post.author)}` : ""}</p><h1 id="post-h" class="t-h1">${esc(post.title)}</h1>${post.excerpt ? `<p class="lead">${esc(post.excerpt)}</p>` : ""}${imageTag(post.featured_image_key, post.title, "media--wide")}<div class="prose">${renderMarkdown(post.content)}</div><p><a class="btn btn--secondary" href="/blog/">← All posts</a></p></div></article>`;
  return page(shell, { title: post.seo_title || post.title, description: post.seo_description || post.excerpt || post.title, canonical: `/blog/${post.slug}/`, main });
}

export function renderEventList(shell: Shell, events: SiteEventRow[], now = new Date()): string {
  const upcoming = events.filter((e) => new Date(e.ends_at ?? e.starts_at) >= now);
  const past = events.filter((e) => new Date(e.ends_at ?? e.starts_at) < now);
  const item = (e: SiteEventRow) => `<article class="card">${imageTag(e.featured_image_key, e.title)}<div class="card__body"><p class="eyebrow">${esc(fmtDate(e.starts_at, true))}${e.location ? ` · ${esc(e.location)}` : e.mode === "virtual" ? " · Online" : ""}</p><h3 class="t-h3"><a href="/events/${esc(e.slug)}/">${esc(e.title)}</a></h3>${e.status === "cancelled" ? "<p><strong>Cancelled</strong></p>" : ""}</div></article>`;
  const main = `<section class="hero hero--minimal" id="events"><div class="container container--narrow hero__inner"><div class="hero__copy"><h1 class="t-h1">Events</h1><p class="lead">Join ${esc(shell.title)} in person or online.</p></div></div></section>
<section class="section" id="upcoming" aria-labelledby="upcoming-h"><div class="container"><h2 id="upcoming-h" class="t-h2">Upcoming</h2>${upcoming.length ? `<div class="cards">${upcoming.map(item).join("")}</div>` : `<p class="lead">No upcoming events right now.</p>`}</div></section>
${past.length ? `<section class="section bg-muted" id="past" aria-labelledby="past-h"><div class="container"><h2 id="past-h" class="t-h2">Past events</h2><div class="cards">${past.slice(0, 12).map(item).join("")}</div></div></section>` : ""}`;
  return page(shell, { title: "Events", description: `Upcoming events from ${shell.title}.`, canonical: "/events/", main });
}

export function renderEvent(shell: Shell, e: SiteEventRow): string {
  const when = `${fmtDate(e.starts_at, true)}${e.ends_at ? ` – ${fmtDate(e.ends_at, true)}` : ""}`;
  const cta = e.registration_url && /^https:\/\//.test(e.registration_url) ? `<p class="actions"><a class="btn btn--primary" href="${esc(e.registration_url)}">${esc(e.cta_label || "Register")}</a></p>` : "";
  const main = `<article class="section" id="event" aria-labelledby="event-h"><div class="container container--narrow"><p class="eyebrow"><a href="/events/">Events</a> · ${esc(e.mode === "virtual" ? "Online" : e.mode === "hybrid" ? "In person and online" : "In person")}</p><h1 id="event-h" class="t-h1">${esc(e.title)}</h1>${e.status === "cancelled" ? "<p class=\"lead\"><strong>This event has been cancelled.</strong></p>" : ""}<dl class="facts"><div><dt>When</dt><dd>${esc(when)}</dd></div>${e.location ? `<div><dt>Where</dt><dd>${esc(e.location)}</dd></div>` : ""}${e.organizer ? `<div><dt>Organizer</dt><dd>${esc(e.organizer)}</dd></div>` : ""}</dl>${imageTag(e.featured_image_key, e.title, "media--wide")}<div class="prose">${renderMarkdown(e.description)}</div>${e.status === "cancelled" ? "" : cta}<p><a class="btn btn--secondary" href="/events/">← All events</a></p></div></article>`;
  return page(shell, { title: e.title, description: e.description.slice(0, 160) || e.title, canonical: `/events/${e.slug}/`, main });
}

/** Adds Blog / Events to the footer navigation of a served page when the
 *  site has that content and the page does not link to it yet. */
export function injectContentLinks(html: string, links: Array<{ href: string; title: string }>): string {
  const missing = links.filter((l) => !new RegExp(`href="${l.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html));
  if (!missing.length) return html;
  const items = missing.map((l) => `<li><a href="${esc(l.href)}">${esc(l.title)}</a></li>`).join("");
  return html.replace(/(<nav class="footer__nav"[^>]*>[\s\S]*?<ul>[\s\S]*?)(<\/ul>)/i, `$1${items}$2`);
}
