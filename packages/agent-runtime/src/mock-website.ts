import type { ModelRequest } from "./index.js";
import type {
  OrgFact,
  SiteBlock,
  SiteContentOutput,
  SitePage,
  SitePageOutput,
  SitePatchOutput,
  WebsiteBriefOutput,
} from "@deedwell/schemas";

/**
 * MOCK website-team generators (see mock-provider.ts banner). Deterministic
 * stand-ins that exercise the CMS model, renderer, checks, and approval flow.
 */

function jsonBlock<T>(request: ModelRequest, label: string, fallback: T): T {
  try {
    return JSON.parse(request.dataBlocks.find((b) => b.label === label)?.content ?? "") as T;
  } catch {
    return fallback;
  }
}

function factMap(request: ModelRequest): Map<string, string> {
  const facts = jsonBlock<OrgFact[]>(request, "org_facts", []);
  return new Map(facts.map((f) => [f.key, f.value]));
}

const PALETTES = ["forest", "ocean", "slate", "sunrise"] as const;

export function websiteBrief(request: ModelRequest): WebsiteBriefOutput {
  const facts = factMap(request);
  const input = jsonBlock<{ siteName?: string; donateUrl?: string | null }>(request, "intake", {});
  const name = input.siteName ?? facts.get("legal_name") ?? "Our Organization";
  // Deterministic palette pick keyed off the name.
  const palette = PALETTES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTES.length]!;
  const sitemap = [
    { slug: "home", title: "Home", purpose: "Welcome visitors and state the mission" },
    { slug: "about", title: "About Us", purpose: "Credibility: who we are and our track record" },
    { slug: "programs", title: "Programs", purpose: "What we do and who benefits" },
    { slug: "contact", title: "Contact", purpose: "Reach us and get involved" },
  ];
  return {
    objectives: [
      "Present a credible public face for funders and partners",
      "Explain programs clearly to the community",
      input.donateUrl ? "Convert visitors into donors" : "Convert visitors into volunteers",
    ],
    audiences: ["Community members", "Funders and grantmakers", "Volunteers and partners"],
    tone: "Warm, clear, and credible — plain language over jargon. [mock provider]",
    sitemap,
    theme: { palette, headingFont: "serif" },
  };
}

export function siteContent(request: ModelRequest): SiteContentOutput {
  const facts = factMap(request);
  const input = jsonBlock<{ siteName?: string; donateUrl?: string | null }>(request, "intake", {});
  const placeholders: string[] = [];
  const need = (key: string, label: string): string => {
    const value = facts.get(key);
    if (value) return value;
    placeholders.push(`Missing organizational fact "${key}" — ${label}`);
    return `[Placeholder: add your ${label}]`;
  };

  const name = input.siteName ?? facts.get("legal_name") ?? "Our Organization";
  const mission = need("mission", "mission statement");
  const programsRaw = facts.get("programs");
  if (!programsRaw) placeholders.push('Missing organizational fact "programs" — program list');
  const programItems = (programsRaw ?? "Our programs")
    .split(/;|,/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((p) => ({ name: p, description: `${p} serves ${facts.get("beneficiaries") ?? "our community"}.` }));

  const home: SitePage = {
    slug: "home",
    title: "Home",
    seoDescription: `${name} — ${mission}`.slice(0, 300),
    blocks: [
      {
        kind: "hero",
        heading: name,
        tagline: mission.slice(0, 400),
        ctaText: input.donateUrl ? "Donate" : "Get involved",
        ctaHref: input.donateUrl ?? "/contact/",
      },
      {
        kind: "stats",
        items: [
          { label: "Serving", value: facts.get("service_area")?.slice(0, 40) ?? "our community" },
          { label: "Founded", value: facts.get("year_founded")?.slice(0, 40) ?? "—" },
        ],
      },
      ...(input.donateUrl
        ? [{ kind: "cta", heading: "Support our work", buttonText: "Donate", href: input.donateUrl } as SiteBlock]
        : []),
    ],
  };
  const about: SitePage = {
    slug: "about",
    title: "About Us",
    seoDescription: `About ${name}: mission, history, and community.`.slice(0, 300),
    blocks: [
      { kind: "text", heading: "Our mission", body: mission },
      { kind: "text", heading: "Who we serve", body: need("beneficiaries", "beneficiary description") },
    ],
  };
  const programs: SitePage = {
    slug: "programs",
    title: "Programs",
    seoDescription: `Programs run by ${name}.`.slice(0, 300),
    blocks: [{ kind: "programs", heading: "What we do", items: programItems }],
  };
  const contact: SitePage = {
    slug: "contact",
    title: "Contact",
    seoDescription: `Contact ${name}.`.slice(0, 300),
    blocks: [
      { kind: "contact", email: null, phone: null, address: facts.get("headquarters") ?? null },
      {
        kind: "form",
        formKey: "contact",
        heading: "Send us a message",
        fields: [
          { key: "name", label: "Your name", type: "text", required: true },
          { key: "email", label: "Email address", type: "email", required: true },
          { key: "message", label: "Message", type: "textarea", required: true },
        ],
      },
    ],
  };
  return { pages: [home, about, programs, contact], placeholders };
}

export function sitePatch(request: ModelRequest): SitePatchOutput {
  const pages = jsonBlock<SitePage[]>(request, "pages", []);
  const instruction = request.dataBlocks.find((b) => b.label === "instruction")?.content ?? "";
  const unchanged = (reason: string): SitePatchOutput => ({
    applied: false,
    reason,
    changeSummary: "No change applied",
    pages,
  });
  if (!pages.length) return unchanged("No pages provided");

  const tagline = instruction.match(/tagline to ["“](.+?)["”]/i);
  if (tagline) {
    const next = pages.map((p) =>
      p.slug === "home"
        ? { ...p, blocks: p.blocks.map((b) => (b.kind === "hero" ? { ...b, tagline: tagline[1]! } : b)) }
        : p
    );
    return { applied: true, reason: null, changeSummary: `Updated the homepage tagline`, pages: next };
  }

  if (/volunteer form/i.test(instruction)) {
    const form: SiteBlock = {
      kind: "form",
      formKey: "volunteer",
      heading: "Volunteer with us",
      fields: [
        { key: "name", label: "Your name", type: "text", required: true },
        { key: "email", label: "Email address", type: "email", required: true },
        { key: "interests", label: "How would you like to help?", type: "textarea", required: false },
      ],
    };
    const next = pages.map((p) =>
      p.slug === "contact" ? { ...p, blocks: [...p.blocks, form] } : p
    );
    return { applied: true, reason: null, changeSummary: "Added a volunteer form to the contact page", pages: next };
  }

  const addPage = instruction.match(/add (?:a )?page (?:called |named )?["“]?([a-z][a-z ]{1,40})["”]?/i);
  if (addPage) {
    const title = addPage[1]!.trim().replace(/\b\w/g, (c) => c.toUpperCase());
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (pages.some((p) => p.slug === slug)) return unchanged(`A page named "${title}" already exists`);
    const page: SitePage = {
      slug,
      title,
      seoDescription: `${title} — more information coming soon.`,
      blocks: [{ kind: "text", heading: title, body: `[Placeholder: add content for the ${title} page]` }],
    };
    return { applied: true, reason: null, changeSummary: `Added a new "${title}" page`, pages: [...pages, page] };
  }

  const removePage = instruction.match(/remove (?:the )?page (?:called |named )?["“]?([a-z][a-z ]{1,40})["”]?/i);
  if (removePage) {
    const needle = removePage[1]!.trim().toLowerCase();
    const target = pages.find((p) => p.title.toLowerCase() === needle || p.slug === needle.replace(/ /g, "-"));
    if (!target) return unchanged(`No page named "${removePage[1]!.trim()}" exists`);
    if (target.slug === "home") return unchanged("The home page cannot be removed");
    return {
      applied: true,
      reason: null,
      changeSummary: `Removed the "${target.title}" page`,
      pages: pages.filter((p) => p.slug !== target.slug),
    };
  }

  return unchanged(
    "The mock provider only understands a few edit patterns (tagline, volunteer form, add/remove page). " +
      "A real model provider will handle free-form requests."
  );
}

/**
 * One page at a time — the mock counterpart to per-page generation.
 *
 * Rather than duplicate siteContent's fact handling (and drift from it), this
 * generates the full deterministic set and returns the one page the plan asked
 * for. A page the mock doesn't know about gets an honest placeholder page
 * instead of invented copy, matching how the real agent is instructed to behave.
 */
export function sitePage(request: ModelRequest): SitePageOutput {
  const plan = jsonBlock<{ slug?: string; title?: string; purpose?: string }>(
    request,
    "page_plan",
    {},
  );
  const slug = plan.slug ?? "home";
  const all = siteContent(request);
  const match = all.pages.find((p) => p.slug === slug);
  if (match) {
    // Report the shared placeholder list only when this page actually carries a
    // gap, so a complete page doesn't inherit another page's missing facts.
    const hasGap = JSON.stringify(match.blocks).includes("[Placeholder");
    return { page: match, placeholders: hasGap ? all.placeholders : [] };
  }
  const title = plan.title ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    page: {
      slug,
      title,
      seoDescription: `${title} — ${plan.purpose ?? "more information coming soon."}`.slice(0, 300),
      blocks: [
        {
          kind: "text",
          heading: title,
          body: `[Placeholder: add content for the ${title} page]`,
        },
      ],
    },
    placeholders: [`Page "${slug}" has no certified content yet`],
  };
}


/**
 * A deliberately plain but structurally complete page, built from the same
 * blocks the copywriter produced: every rule the release checks enforce
 * (lang, title, description, one h1, nav to every page, labelled inputs,
 * honeypot, no script) is satisfied, so the pipeline can be exercised end to
 * end without a real model. Marked data-designed="mock" so tests can tell.
 */
export function siteHtml(request: ModelRequest): string {
  const page = jsonBlock<{ slug?: string; title?: string; seoDescription?: string; blocks?: Array<Record<string, unknown>> }>(
    request, "page", {}
  );
  const nav = jsonBlock<Array<{ title: string; href: string }>>(request, "site_nav", []);
  const forms = jsonBlock<Array<{ formKey: string; action: string }>>(request, "site_forms", []);
  const site = jsonBlock<{ siteName?: string }>(request, "site", {});
  const escape = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const isStyleGuide = !request.dataBlocks.some((b) => b.label === "page");
  const isPageMain = request.dataBlocks.some((b) => b.label === "site_styles");

  if (isStyleGuide) {
    // Every contract hook styled, header with five links, footer with all.
    const hooks = [
      ".container", ".btn", ".btn--primary", ".skip-link", ".site-header", ".site-nav", ".hero", ".hero__title",
      ".section", ".section__title", ".cards", ".card", ".stats", ".stat__value", ".split", ".quote", ".steps",
      ".faq", ".team", ".cta-band", ".donate", ".donate__amounts", ".contact", ".field", ".site-footer", ".footer__legal",
    ];
    const css = `:root{--accent:#2b6cb0}body{font-family:system-ui;margin:0}${hooks.map((h) => `${h}{display:block}`).join("")}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Style guide</title><style>${css}</style></head>
<body data-designed="mock"><a class="skip-link" href="#main">Skip</a>
<header class="site-header"><div class="container site-header__inner"><a class="brand" href="/">${escape(site.siteName)}</a><nav class="site-nav" aria-label="Main"><ul>${nav.slice(1, 5).map((n) => `<li><a href="${n.href}">${escape(n.title)}</a></li>`).join("")}</ul></nav></div></header>
<main id="main"><section class="hero"><div class="container"><h1 class="hero__title">Sample</h1></div></section></main>
<footer class="site-footer"><div class="container"><nav class="footer__nav" aria-label="Footer"><ul>${nav.map((n) => `<li><a href="${n.href}">${escape(n.title)}</a></li>`).join("")}</ul></nav><div class="footer__legal"><p>© ${escape(site.siteName)}</p></div></div></footer></body></html>`;
  }
  if (isPageMain) {
    const blocks = page.blocks ?? [];
    const hasHero = blocks.some((b) => b.kind === "hero");
    const sections = blocks.map((b) => {
      if (b.kind === "hero") return `<section class="hero"><div class="container hero__inner"><div class="hero__copy"><h1 class="hero__title">${escape(b.heading)}</h1><p class="hero__lead">${escape(b.tagline)}</p></div></div></section>`;
      if (b.kind === "form") {
        const action = forms.find((f) => f.formKey === b.formKey)?.action ?? "/forms/site/contact";
        const fields = ((b.fields as Array<{ key: string; label: string; type: string }>) ?? []).map((f) =>
          `<div class="field"><label for="f-${f.key}">${escape(f.label)}</label>${f.type === "textarea" ? `<textarea id="f-${f.key}" name="${f.key}"></textarea>` : `<input id="f-${f.key}" name="${f.key}" type="${f.type}">`}</div>`).join("");
        return `<section class="section"><div class="container"><h2 class="section__title">${escape(b.heading)}</h2><form class="form" method="post" action="${action}"><input type="hidden" name="website" value="">${fields}<button class="btn btn--primary" type="submit">Send</button></form></div></section>`;
      }
      return `<section class="section"><div class="container"><div class="section__head"><h2 class="section__title">${escape(b.heading ?? "Section")}</h2></div><div class="prose"><p>${escape(b.body ?? b.quote ?? JSON.stringify(b).slice(0, 120))}</p></div></div></section>`;
    });
    return `<main id="main" data-designed="mock">${hasHero ? "" : `<section class="hero"><div class="container"><h1 class="hero__title">${escape(page.title)}</h1></div></section>`}${sections.join("\n")}</main>`;
  }
  const sections = (page.blocks ?? []).map((b, i) => {
    if (b.kind === "hero") return `<section class="hero"><h1>${escape(b.heading)}</h1><p>${escape(b.tagline)}</p></section>`;
    if (b.kind === "form") {
      const action = forms.find((f) => f.formKey === b.formKey)?.action ?? `/forms/site/${escape(b.formKey)}`;
      const fields = ((b.fields as Array<{ key: string; label: string; type: string }>) ?? []).map((f) =>
        `<label for="f-${f.key}">${escape(f.label)}</label>${f.type === "textarea" ? `<textarea id="f-${f.key}" name="${f.key}"></textarea>` : `<input id="f-${f.key}" name="${f.key}" type="${f.type}">`}`
      ).join("");
      return `<section><h2>${escape(b.heading)}</h2><form method="post" action="${action}"><input type="hidden" name="website" value="">${fields}<button type="submit">Send</button></form></section>`;
    }
    const heading = typeof b.heading === "string" ? `<h2>${escape(b.heading)}</h2>` : "";
    return `<section class="block-${i}">${heading}<p>${escape(b.body ?? b.quote ?? JSON.stringify(b).slice(0, 120))}</p></section>`;
  });
  const hasHero = (page.blocks ?? []).some((b) => b.kind === "hero");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title ?? "Page")} — ${escape(site.siteName ?? "Site")}</title>
<meta name="description" content="${escape(page.seoDescription ?? page.title ?? "")}">
<style>body{font-family:system-ui;margin:0}nav a{margin-right:1rem}.hero{padding:3rem 1rem;background:#eef}</style>
</head>
<body data-designed="mock">
<a class="skip" href="#main">Skip to main content</a>
<header><nav aria-label="Main">${nav.slice(0, 5).map((n) => `<a href="${n.href}">${escape(n.title)}</a>`).join("")}</nav></header>
<main id="main">${hasHero ? "" : `<h1>${escape(page.title ?? "Page")}</h1>`}${sections.join("\n")}</main>
<footer><nav aria-label="Footer">${nav.map((n) => `<a href="${n.href}">${escape(n.title)}</a>`).join("")}</nav><p>${escape(site.siteName ?? "")}</p></footer>
</body>
</html>`;
}
