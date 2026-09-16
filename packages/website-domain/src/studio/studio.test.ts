import { describe, expect, it } from "vitest";
import { cleanDeclarations, cleanSelector, injectOverrides, mergeOverride, overridesCss } from "./overrides.js";
import { instructionsFor } from "./domains.js";
import { fillFeeds, hasFeeds } from "./content.js";
import { patchDesignedCopy } from "./state.js";

describe("overrides layer", () => {
  it("keeps allowed properties with safe values and drops the rest", () => {
    expect(cleanDeclarations({ "font-size": "30px", color: "#123", background: "url(http://x)", "--evil": "1", width: "calc(100% - 8px)" }))
      .toEqual({ "font-size": "30px", color: "#123", width: "calc(100% - 8px)" });
  });
  it("accepts child combinators in selectors but nothing that closes a rule", () => {
    expect(cleanSelector("footer ul > li:nth-of-type(2) > a")).toBe("footer ul > li:nth-of-type(2) > a");
    expect(cleanSelector("#s0-h")).toBe("#s0-h");
    expect(cleanSelector("a{}")).toBeNull();
    expect(cleanSelector("a; body")).toBeNull();
    expect(cleanSelector("<script>")).toBeNull();
  });
  it("scopes rules to the page and viewport, later rules last", () => {
    const css = overridesCss([
      { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px" } },
      { page: "*", selector: "main img", viewport: "all", declarations: { "max-width": "100%" } },
      { page: "about", selector: "h1", viewport: "all", declarations: { color: "red" } },
    ], "home");
    expect(css).toBe("@media (max-width: 639px){#s0-h{font-size:30px !important}}\nmain img{max-width:100% !important}");
    const html = injectOverrides("<html><head><title>x</title></head><body></body></html>", css);
    expect(html).toContain('<style id="site-overrides">');
    expect(injectOverrides(html, "")).not.toContain("site-overrides");
  });
  it("merges an override for the same target property by property", () => {
    const a = mergeOverride([], { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "33px" } });
    const b = mergeOverride(a, { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px", "line-height": "1.1" } });
    expect(b).toEqual([{ page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px", "line-height": "1.1" }, note: undefined }]);
  });
});

describe("custom domain instructions", () => {
  it("gives zone-relative hosts for a subdomain", () => {
    const rows = instructionsFor("www.example.org", "deedwell-site-verification=abc");
    expect(rows.map((r) => [r.type, r.host])).toEqual([["TXT", "_deedwell.www"], ["CNAME", "www"]]);
    expect(rows[0]!.value).toBe("deedwell-site-verification=abc");
  });
  it("uses A records at the apex", () => {
    const rows = instructionsFor("example.org", "t");
    expect(rows.map((r) => [r.type, r.host])).toEqual([["TXT", "_deedwell"], ["A", "@"]]);
  });
});

import { DEFAULT_LANGUAGE, fallbackTokens, normalizeComposition } from "../builder/index.js";
import { applyOperations, renderWorkingPage, type WorkingState } from "./state.js";

function stateWith(designedHtml: string | null, brandLogoPath: string | null = null): WorkingState {
  const page = { slug: "home", title: "Home", seoDescription: "", blocks: [{ kind: "hero" as const, heading: "Clean water", tagline: "For every village", ctaText: "Donate", ctaHref: "/donate/" }, { kind: "text" as const, heading: "About", body: "We dig wells." }] };
  const language = DEFAULT_LANGUAGE;
  const composition = normalizeComposition(null, { page, images: [], donateUrl: null, language });
  return {
    site: { id: "s", slug: "org", name: "Org", tenantId: "t" },
    pages: [{ page, status: "published", orderIdx: 0, composition, designedHtml }],
    language, tokens: fallbackTokens(language, { primaryColor: null }), overrides: [], brandLogoPath, logo: "brand", images: [],
    organization: { name: "Org", logoPath: brandLogoPath, legalName: null, mission: null, headquarters: null, status: null, ein: null, contactEmail: null, contactPhone: null },
    donateUrl: null, native: true,
  };
}

describe("designed (pre-pipeline) pages", () => {
  const designed = "<!doctype html><html><head><title>Org</title></head><body><section id=\"top\"><h1 class=\"big\">Clean water</h1></section></body></html>";
  it("keeps their own markup and only takes style overrides", () => {
    const { state, changed, rejected } = applyOperations(stateWith(designed), [
      { kind: "style", page: "home", selector: "#top h1", viewport: "mobile", declarations: { "font-size": "30px" } },
      { kind: "section", page: "home", sectionId: "s0", set: { density: "airy" } },
      { kind: "copy", page: "home", blockIndex: 0, field: "heading", value: "Changed" },
    ]);
    expect([...changed]).toEqual(["home"]);
    expect(rejected).toHaveLength(2);
    expect(state.pages[0]!.page.blocks[0]).toMatchObject({ heading: "Clean water" });
    const html = renderWorkingPage(state, "home");
    expect(html).toContain('<h1 class="big">Clean water</h1>');
    expect(html).toContain('<style id="site-overrides">@media (max-width: 639px){#top h1{font-size:30px !important}}</style>');
  });
  it("re-renders pipeline pages from their plan", () => {
    const { state } = applyOperations(stateWith(null), [{ kind: "copy", page: "home", blockIndex: 0, field: "heading", value: "Changed" }]);
    expect(renderWorkingPage(state, "home")).toContain("Changed");
  });
});

describe("content feeds", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const events = [
    { slug: "annual-water-fundraiser", title: "Annual Water Fundraiser", description: "Join us.\n\nMore detail.", featured_image_key: null, starts_at: "2026-10-12T18:00:00Z", ends_at: null, location: "Kigali Convention Center", mode: "in_person", registration_url: "https://tickets.example.org", cta_label: null, organizer: null, status: "published" },
    { slug: "past-gala", title: "Past Gala", description: "Was fun.", featured_image_key: null, starts_at: "2026-01-01T18:00:00Z", ends_at: null, location: null, mode: "in_person", registration_url: null, cta_label: null, organizer: null, status: "published" },
    { slug: "secret", title: "Draft event", description: "x", featured_image_key: null, starts_at: "2026-11-01T18:00:00Z", ends_at: null, location: null, mode: "virtual", registration_url: null, cta_label: null, organizer: null, status: "draft" },
  ];
  const posts = [
    { slug: "hello", title: "Hello", excerpt: "First post", content: "Body", author: "Jane", featured_image_key: null, published_at: "2026-09-01T00:00:00Z", seo_title: null, seo_description: null },
    { slug: "later", title: "Scheduled", excerpt: "Not yet", content: "Body", author: null, featured_image_key: null, published_at: "2026-12-01T00:00:00Z", seo_title: null, seo_description: null },
  ];
  const wrap = (feed: string) => `<html><body><section id="s3"><h2>Upcoming</h2>${feed}<p class="actions"><a href="/events/">All events</a></p></section></body></html>`;

  it("features one named record and stays connected to it", () => {
    const html = fillFeeds(wrap('<div class="feed feed--feature" data-feed="events" data-limit="3" data-slug="annual-water-fundraiser"><p class="feed__empty">Upcoming events will appear here.</p></div>'), { posts, events }, now);
    expect(html).toContain("Annual Water Fundraiser");
    expect(html).toContain('href="/events/annual-water-fundraiser/"');
    expect(html).toContain("Kigali Convention Center");
    expect(html).toContain('href="https://tickets.example.org"');
    expect(html).not.toContain("feed__empty");
    expect(html).toContain('data-slug="annual-water-fundraiser"');
  });
  it("lists only upcoming published events, soonest first, within the limit", () => {
    const html = fillFeeds(wrap('<div class="feed feed--cards" data-feed="events" data-limit="3"><p class="feed__empty">Upcoming events will appear here.</p></div>'), { posts, events }, now);
    expect(html).toContain("Annual Water Fundraiser");
    expect(html).not.toContain("Past Gala");
    expect(html).not.toContain("Draft event");
  });
  it("shows the newest published posts and skips scheduled ones", () => {
    const html = fillFeeds(wrap('<div class="feed feed--cards" data-feed="posts" data-limit="3"><p class="feed__empty">New posts will appear here.</p></div>'), { posts, events }, now);
    expect(html).toContain('href="/blog/hello/"');
    expect(html).not.toContain("Scheduled");
  });
  it("keeps the quiet placeholder when nothing matches", () => {
    const src = wrap('<div class="feed feed--cards" data-feed="posts" data-limit="3" data-slug="missing"><p class="feed__empty">New posts will appear here.</p></div>');
    expect(fillFeeds(src, { posts: [], events: [] }, now)).toBe(src);
    expect(hasFeeds(src)).toBe(true);
    expect(hasFeeds("<p>plain</p>")).toBe(false);
  });
});

describe("designed pages: wording edits", () => {
  const html = '<html><body><section id="s0"><h2 class="t">What we do</h2><ul><li><h3>Wells &amp; pumps</h3><p>Clean water.</p></li><li><h3>Schools</h3><p>Books for all.</p></li></ul><a title="Schools" href="/schools/">Schools</a></section></body></html>';
  const before = { kind: "programs" as const, heading: "What we do", items: [{ name: "Wells & pumps", description: "Clean water." }, { name: "Schools", description: "Books for all." }] };
  it("replaces changed text in the markup, escaped, and leaves attributes alone", () => {
    const r = patchDesignedCopy(html, before, { ...before, heading: "Our programs", items: [{ name: "Wells & solar pumps", description: "Clean water." }, { name: "Schools", description: "Books for all." }] });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.html).toContain("<h2 class=\"t\">Our programs</h2>");
    expect(r.html).toContain("<h3>Wells &amp; solar pumps</h3>");
    expect(r.html).toContain('title="Schools"');
    expect(r.changed).toEqual(["heading", "items.0.name"]);
  });
  it("refuses a change whose current text is not on the page, and any change of shape", () => {
    const missing = patchDesignedCopy(html, { ...before, items: [{ name: "Paraphrased", description: "x" }, before.items[1]!] }, { ...before, items: [{ name: "New", description: "x" }, before.items[1]!] });
    expect("error" in missing).toBe(true);
    const added = patchDesignedCopy(html, before, { ...before, items: [...before.items, { name: "Third", description: "y" }] });
    expect("error" in added && /add or remove/.test(added.error)).toBe(true);
    const same = patchDesignedCopy(html, before, before);
    expect(same).toEqual({ html, changed: [] });
  });
});

describe("logo operation", () => {
  const designed = '<html><body><header class="site-header"><a class="brand" href="/">Org</a></header><main></main><footer><p class="brand">Org</p></footer></body></html>';
  it("puts the brand logo on a pipeline page and into a designed page's brand marks", () => {
    const r = applyOperations(stateWith(null, "/images/logo.png"), [{ kind: "logo", action: "use-brand" }]);
    expect(r.rejected).toEqual([]);
    expect(renderWorkingPage(r.state, "home")).toMatch(/<a class="brand" href="\/" aria-current="page"><img class="brand__logo" src="\/images\/logo.png" alt="Org" ?\/?><\/a>/);
    const d = applyOperations(stateWith(designed, "/images/logo.png"), [{ kind: "logo", action: "use-brand" }]);
    expect(d.rejected).toEqual([]);
    const html = renderWorkingPage(d.state, "home");
    expect(html).toContain('<a class="brand" href="/"><img class="brand__logo" src="/images/logo.png" alt="Org"></a>');
    expect(html).toContain('<p class="brand"><img class="brand__logo" src="/images/logo.png" alt="Org"></p>');
    expect(d.changed.has("home")).toBe(true);
  });
  it("refreshes an existing designed logo to the current file, and removes it on request", () => {
    const withOld = designed.replace('>Org</a>', '><img class="brand__logo" src="/images/logo.jpg" alt="Org"></a>');
    const r = applyOperations(stateWith(withOld, "/images/logo.png"), [{ kind: "logo", action: "use-brand" }]);
    expect(renderWorkingPage(r.state, "home")).toContain('src="/images/logo.png"');
    expect(renderWorkingPage(r.state, "home")).not.toContain("logo.jpg");
    const gone = applyOperations(r.state, [{ kind: "logo", action: "remove" }]);
    expect(gone.state.logo).toBe("none");
    expect(gone.state.organization.logoPath).toBeNull();
    const html = renderWorkingPage(gone.state, "home");
    expect(html).not.toContain("brand__logo");
    expect(html).toContain('<a class="brand" href="/">Org</a>');
  });
  it("replaces a wrapped or differently-tagged brand name too, but never an existing image", () => {
    const wrapped = '<header><a href="/" class="site-brand brand"><span class="brand__name">Org</span></a></header><footer><div class="brand"><svg></svg></div></footer>';
    const r = applyOperations(stateWith(wrapped, "/images/logo.png"), [{ kind: "logo", action: "use-brand" }]);
    const html = renderWorkingPage(r.state, "home");
    expect(html).toContain('<a href="/" class="site-brand brand"><img class="brand__logo" src="/images/logo.png" alt="Org"></a>');
    expect(html).toContain('<div class="brand"><svg></svg></div>');
  });
  it("falls back to the header home link that reads as the site name", () => {
    const bare = '<header class="hdr"><a href="/" class="logo-link"><strong>Org</strong></a><nav><a href="/about/">About</a></nav></header>';
    const r = applyOperations(stateWith(bare, "/images/logo.png"), [{ kind: "logo", action: "use-brand" }]);
    const html = renderWorkingPage(r.state, "home");
    expect(html).toContain('<a href="/" class="logo-link"><img class="brand__logo" src="/images/logo.png" alt="Org"></a>');
    expect(html).toContain('<a href="/about/">About</a>');
  });
  it("explains when there is no brand logo to use", () => {
    const r = applyOperations(stateWith(designed, null), [{ kind: "logo", action: "use-brand" }]);
    expect(r.rejected[0]).toMatch(/Brand Style/);
    expect(r.changed.size).toBe(0);
  });
});
