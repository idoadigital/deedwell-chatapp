import type { SiteBlock, SitePage } from "@deedwell/schemas";
import type { SiteImage } from "../images.js";
import type { Organization } from "../design.js";
import { motionPolicy } from "./motion.js";
import type { ComponentName, DesignTokens, Section } from "./schemas.js";

/**
 * The component library. Each component is a tested, responsive section
 * primitive rendered from tokens: the planner selects and configures it and
 * supplies content; nothing here is invented per site. Long content is
 * survivable by design — headings step down with length, excerpts clamp,
 * grids reflow, nothing has a fixed height.
 */

export interface RenderCtx {
  site: { name: string; slug: string };
  page: SitePage;
  tokens: DesignTokens;
  images: SiteImage[];
  organization: Organization;
  donateUrl: string | null;
  nav: Array<{ title: string; href: string }>;
  primaryCta: { label: string; href: string } | null;
}

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const safeHref = (h: string) => (/^(https?:|mailto:|tel:|\/|#)/.test(h.trim()) ? h.trim() : "#");

/** Headline size steps down with length so it never wraps into a wall. */
export function headingClass(text: string, base: "display" | "h1" | "h2"): string {
  const words = text.trim().split(/\s+/).length;
  const chars = text.trim().length;
  if (base === "display" || base === "h1") {
    if (chars > 90 || words > 14) return "t-h2";
    if (chars > 60 || words > 9) return "t-h1";
    return base === "display" ? "t-display" : "t-h1";
  }
  if (chars > 80) return "t-h3";
  return "t-h2";
}

export function clampText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end >= max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

const paras = (body: string) => body.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("");

export function btn(label: string, href: string, kind: "primary" | "secondary" | "ghost" = "primary"): string {
  return `<a class="btn btn--${kind}" href="${esc(safeHref(href))}">${esc(label)}</a>`;
}

function imageFor(ctx: RenderCtx, section: Section): SiteImage | null {
  if (section.imagePosition === "none") return null;
  if (section.image) {
    const named = ctx.images.find((i) => i.key === section.image);
    if (named) return named;
  }
  return ctx.images.find((i) => i.forPage === ctx.page.slug) ?? ctx.images.find((i) => i.key === "hero") ?? ctx.images[0] ?? null;
}

function media(img: SiteImage | null, ratio: "wide" | "portrait" | "square" | "free" = "wide", extra = ""): string {
  if (!img) return "";
  return `<figure class="media media--${ratio} ${extra}"><img src="${esc(img.path)}" alt="${esc(img.alt)}" loading="lazy" decoding="async"></figure>`;
}

function reveal(ctx: RenderCtx, section: Section): string {
  const policy = motionPolicy(ctx.tokens.motion);
  if (!policy.reveal || section.motion === "none") return "";
  if (section.motion === "stagger" && policy.stagger) return ' data-reveal="stagger"';
  if (section.motion === "image-reveal" && policy.imageReveal) return ' data-reveal="image"';
  return ' data-reveal';
}
function parallax(ctx: RenderCtx, section: Section): string {
  return section.motion === "parallax" && motionPolicy(ctx.tokens.motion).parallax ? " data-parallax" : "";
}

function shell(ctx: RenderCtx, section: Section, inner: string, opts: { narrow?: boolean; fullBleed?: boolean; extraClass?: string } = {}): string {
  const bg = section.background === "default" ? "" : ` bg-${section.background}`;
  const density = section.density === "balanced" ? "" : ` density-${section.density}`;
  const cls = `section${bg}${density}${opts.extraClass ? ` ${opts.extraClass}` : ""}`;
  const container = opts.fullBleed ? "" : `container${opts.narrow ? " container--narrow" : ""}`;
  return `<section class="${cls}" id="${esc(section.id)}" aria-labelledby="${esc(section.id)}-h"${reveal(ctx, section)}>${container ? `<div class="${container}">` : ""}${inner}${container ? "</div>" : ""}</section>`;
}

function head(section: Section, eyebrow: string | null | undefined, heading: string | null | undefined, intro?: string | null, opts: { level?: 1 | 2; align?: "left" | "center"; narrow?: boolean } = {}): string {
  const level = opts.level ?? 2;
  const h = heading ? (section.overrides?.heading ?? heading) : null;
  const e = section.overrides?.eyebrow ?? eyebrow;
  if (!h && !e && !intro) return "";
  const hc = h ? (level === 1 ? headingClass(h, "h1") : headingClass(h, "h2")) : "";
  return `<div class="section__head${opts.align === "center" ? " section__head--center" : ""}${opts.narrow === false ? "" : " section__head--measure"}">${
    e ? `<p class="eyebrow">${esc(e)}</p>` : ""
  }${h ? `<h${level} class="${hc}" id="${esc(section.id)}-h">${esc(h)}</h${level}>` : ""}${
    intro ? `<p class="lead">${esc(section.overrides?.body ?? clampText(intro, 320))}</p>` : ""
  }</div>`;
}

type B<K extends SiteBlock["kind"]> = Extract<SiteBlock, { kind: K }>;

// ---- catalog ----------------------------------------------------------------

export interface ComponentSpec {
  family: "hero" | "content" | "impact" | "programs" | "stories" | "engagement" | "media" | "other";
  accepts: SiteBlock["kind"][];
  variants: string[];
  whenToUse: string;
  render: (ctx: RenderCtx, section: Section, block: SiteBlock) => string;
}

const heroActions = (ctx: RenderCtx, b: B<"hero">) => {
  const primary = b.ctaText && b.ctaHref ? btn(b.ctaText, b.ctaHref, "primary") : ctx.primaryCta ? btn(ctx.primaryCta.label, ctx.primaryCta.href) : "";
  const secondary = b.secondaryText && b.secondaryHref ? btn(b.secondaryText, b.secondaryHref, "secondary") : "";
  return primary || secondary ? `<div class="actions">${primary}${secondary}</div>` : "";
};
const heroCopy = (ctx: RenderCtx, s: Section, b: B<"hero">, size: "display" | "h1" = "h1") =>
  `<div class="hero__copy">${b.eyebrow ? `<p class="eyebrow">${esc(s.overrides?.eyebrow ?? b.eyebrow)}</p>` : ""}<h1 class="${headingClass(s.overrides?.heading ?? b.heading, size)}" id="${esc(s.id)}-h">${esc(s.overrides?.heading ?? b.heading)}</h1>${
    b.tagline ? `<p class="lead">${esc(s.overrides?.body ?? clampText(b.tagline, 260))}</p>` : ""
  }${heroActions(ctx, b)}</div>`;

export const CATALOG: Record<ComponentName, ComponentSpec> = {
  EditorialHero: {
    family: "hero", accepts: ["hero"], variants: ["image-right", "image-below", "text-only"],
    whenToUse: "Default home hero: left-aligned editorial headline with a large photograph beside or below it.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      const img = imageFor(ctx, s);
      const v = s.variant ?? (img ? "image-right" : "text-only");
      return `<section class="hero hero--editorial hero--${v}${s.background === "dark" ? " bg-dark" : ""}" id="${esc(s.id)}"${reveal(ctx, s)}><div class="container hero__inner">${heroCopy(ctx, s, b, "display")}${v !== "text-only" ? media(img, v === "image-below" ? "wide" : "portrait", "hero__media") : ""}</div></section>`;
    },
  },
  FullBleedImageHero: {
    family: "hero", accepts: ["hero"], variants: ["overlay-dark", "overlay-gradient", "bottom-panel"],
    whenToUse: "Photographic, cinematic opening: full-width image with copy over a legible overlay.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      const img = imageFor(ctx, { ...s, imagePosition: "background" });
      const v = s.variant ?? "overlay-dark";
      return `<section class="hero hero--bleed hero--${v}" id="${esc(s.id)}"${reveal(ctx, s)}${parallax(ctx, s)}>${img ? `<div class="hero__bg"><img src="${esc(img.path)}" alt="" aria-hidden="true"></div>` : ""}<div class="hero__scrim"></div><div class="container hero__inner">${heroCopy(ctx, s, b, "display")}</div></section>`;
    },
  },
  SplitHero: {
    family: "hero", accepts: ["hero"], variants: ["image-right", "image-left"],
    whenToUse: "Balanced two-column opening; copy on one side, tall image on the other.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      const img = imageFor(ctx, s);
      const v = s.variant ?? "image-right";
      return `<section class="hero hero--split hero--${v}" id="${esc(s.id)}"${reveal(ctx, s)}><div class="container hero__inner">${heroCopy(ctx, s, b)}${media(img, "portrait", "hero__media")}</div></section>`;
    },
  },
  ImpactHero: {
    family: "hero", accepts: ["hero"], variants: ["with-metrics"],
    whenToUse: "Opening that leads with the organization's key numbers beneath the headline. Use when the page has a stats block right after the hero.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      const stats = ctx.page.blocks.find((x): x is B<"stats"> => x.kind === "stats");
      const strip = stats ? `<ul class="stats stats--strip" data-reveal="stagger">${stats.items.slice(0, 4).map((i) => `<li class="stat"><span class="stat__value" data-count="${esc(i.value)}">${esc(i.value)}</span><span class="stat__label">${esc(i.label)}</span></li>`).join("")}</ul>` : "";
      const img = imageFor(ctx, s);
      return `<section class="hero hero--impact" id="${esc(s.id)}"${reveal(ctx, s)}><div class="container hero__inner">${heroCopy(ctx, s, b, "display")}${media(img, "wide", "hero__media")}</div>${strip ? `<div class="container">${strip}</div>` : ""}</section>`;
    },
  },
  MinimalHero: {
    family: "hero", accepts: ["hero"], variants: ["left", "centered"],
    whenToUse: "Quiet, typographic opening for inner pages: headline and lead in a narrow measure, no image.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      return `<section class="hero hero--minimal${s.variant === "centered" ? " hero--centered" : ""}" id="${esc(s.id)}"${reveal(ctx, s)}><div class="container container--narrow hero__inner">${heroCopy(ctx, s, b)}</div></section>`;
    },
  },
  StoryHero: {
    family: "hero", accepts: ["hero"], variants: ["statement"],
    whenToUse: "Opening built around one human statement, image beneath. Suits About and Impact pages.",
    render: (ctx, s, block) => {
      const b = block as B<"hero">;
      const img = imageFor(ctx, s);
      return `<section class="hero hero--story" id="${esc(s.id)}"${reveal(ctx, s)}><div class="container hero__inner">${heroCopy(ctx, s, b, "display")}</div>${img ? `<div class="container">${media(img, "wide", "hero__media")}</div>` : ""}</section>`;
    },
  },

  EditorialTextSection: {
    family: "content", accepts: ["text"], variants: ["measure", "two-column"],
    whenToUse: "Prose that deserves a reading column: a story, a mission explanation.",
    render: (ctx, s, block) => {
      const b = block as B<"text">;
      const v = s.variant ?? "measure";
      return shell(ctx, s, `${head(s, null, b.heading)}<div class="prose${v === "two-column" ? " prose--columns" : ""}">${paras(s.overrides?.body ?? b.body)}</div>`, { narrow: v !== "two-column" });
    },
  },
  ProseSection: {
    family: "content", accepts: ["text", "split", "programs", "steps", "faq", "team", "logos", "contact"], variants: ["measure"],
    whenToUse: "Fallback prose presentation of any block.",
    render: (ctx, s, block) => shell(ctx, s, `${head(s, null, "heading" in block ? (block as { heading?: string | null }).heading ?? null : null)}<div class="prose">${paras(blockText(block))}</div>`, { narrow: true }),
  },
  SplitStorySection: {
    family: "content", accepts: ["split", "text"], variants: ["image-left", "image-right"],
    whenToUse: "Photograph beside copy with a short list of highlights; alternate sides down the page.",
    render: (ctx, s, block) => {
      const b = block as B<"split"> | B<"text">;
      const img = imageFor(ctx, { ...s, imagePosition: s.imagePosition === "none" ? "left" : s.imagePosition });
      const v = s.variant ?? (s.imagePosition === "right" ? "image-right" : "image-left");
      const highlights = "highlights" in b && b.highlights?.length ? `<ul class="checklist">${b.highlights.slice(0, 5).map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : "";
      const cta = "ctaText" in b && b.ctaText && b.ctaHref ? `<div class="actions">${btn(b.ctaText, b.ctaHref, "secondary")}</div>` : "";
      return shell(ctx, s, `<div class="split split--${v}">${media(img, "portrait", "split__media")}<div class="split__body">${head(s, null, b.heading, null, { narrow: false })}<div class="prose">${paras(s.overrides?.body ?? clampText(b.body, 900))}</div>${highlights}${cta}</div></div>`);
    },
  },
  ImageTextSection: {
    family: "content", accepts: ["text", "split"], variants: ["image-top", "image-side"],
    whenToUse: "Copy with a supporting image where the text leads.",
    render: (ctx, s, block) => {
      const b = block as B<"text"> | B<"split">;
      const img = imageFor(ctx, { ...s, imagePosition: s.imagePosition === "none" ? "top" : s.imagePosition });
      return shell(ctx, s, `<div class="imagetext imagetext--${s.variant ?? "image-top"}">${media(img, "wide", "imagetext__media")}<div class="imagetext__body">${head(s, null, b.heading)}<div class="prose">${paras(s.overrides?.body ?? b.body)}</div></div></div>`, { narrow: (s.variant ?? "image-top") === "image-top" });
    },
  },
  QuoteSection: {
    family: "content", accepts: ["quote"], variants: ["large", "inline"],
    whenToUse: "A single voice, given room: a beneficiary, partner or founder quote.",
    render: (ctx, s, block) => {
      const b = block as B<"quote">;
      return shell(ctx, s, `<figure class="quote quote--${s.variant ?? "large"}"><blockquote><p>${esc(clampText(b.quote, 320))}</p></blockquote>${b.attribution ? `<figcaption><strong>${esc(b.attribution)}</strong>${b.role ? `<span>${esc(b.role)}</span>` : ""}</figcaption>` : ""}</figure>`, { narrow: true });
    },
  },
  ManifestoSection: {
    family: "content", accepts: ["text", "cta"], variants: ["statement"],
    whenToUse: "One large, short statement of belief or mission on a full band. Use once per site at most.",
    render: (ctx, s, block) => {
      const text = ("body" in block && typeof block.body === "string" ? block.body : null) ?? ("heading" in block ? (block as B<"cta">).heading : "");
      const statement = clampText(s.overrides?.body ?? text, 180);
      return shell(ctx, { ...s, background: s.background === "default" ? "primary" : s.background }, `<p class="manifesto ${headingClass(statement, "h1")}" id="${esc(s.id)}-h">${esc(statement)}</p>`, { narrow: false });
    },
  },

  ImpactMetrics: {
    family: "impact", accepts: ["stats"], variants: ["row", "grid"],
    whenToUse: "Verifiable numbers with labels; counters animate into view.",
    render: (ctx, s, block) => {
      const b = block as B<"stats">;
      const items = b.items.slice(0, 6);
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, s.overrides?.eyebrow ?? null, s.overrides?.heading ?? null)}<ul class="stats stats--${items.length > 4 ? "grid" : (s.variant ?? "row")}">${items.map((i) => `<li class="stat"><span class="stat__value" data-count="${esc(i.value)}">${esc(i.value)}</span><span class="stat__label">${esc(i.label)}</span></li>`).join("")}</ul>`);
    },
  },
  StatisticsBand: {
    family: "impact", accepts: ["stats"], variants: ["dark", "primary"],
    whenToUse: "The same numbers as a full-width band in a strong colour; good as a page's midpoint.",
    render: (ctx, s, block) => {
      const b = block as B<"stats">;
      return shell(ctx, { ...s, background: s.variant === "primary" ? "primary" : "dark", motion: "stagger" }, `<ul class="stats stats--band">${b.items.slice(0, 4).map((i) => `<li class="stat"><span class="stat__value" data-count="${esc(i.value)}">${esc(i.value)}</span><span class="stat__label">${esc(i.label)}</span></li>`).join("")}</ul>`);
    },
  },
  OutcomesGrid: {
    family: "impact", accepts: ["stats", "programs"], variants: ["cards"],
    whenToUse: "Outcomes as short titled cards, when each number needs a sentence of context.",
    render: (ctx, s, block) => {
      const items = block.kind === "stats" ? block.items.map((i) => ({ title: i.value, body: i.label })) : (block as B<"programs">).items.map((i) => ({ title: i.name, body: i.description }));
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, "heading" in block ? (block as { heading?: string }).heading ?? null : null)}<div class="cards cards--outcomes">${items.slice(0, 6).map((i) => `<article class="card"><p class="stat__value">${esc(i.title)}</p><p>${esc(clampText(i.body, 160))}</p></article>`).join("")}</div>`);
    },
  },

  ProgramEditorialGrid: {
    family: "programs", accepts: ["programs"], variants: ["numbered", "ruled"],
    whenToUse: "Programs as a numbered editorial list with rules between entries — no cards.",
    render: (ctx, s, block) => {
      const b = block as B<"programs">;
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, b.heading)}<ol class="proglist proglist--${s.variant ?? "numbered"}">${b.items.slice(0, 8).map((i) => `<li class="proglist__item"><h3 class="t-h3">${esc(i.name)}</h3><p>${esc(clampText(i.description, 260))}</p></li>`).join("")}</ol>`);
    },
  },
  ProgramFeature: {
    family: "programs", accepts: ["programs"], variants: ["first-large"],
    whenToUse: "One flagship program large with an image, the rest listed beside it.",
    render: (ctx, s, block) => {
      const b = block as B<"programs">;
      const [first, ...rest] = b.items;
      const img = imageFor(ctx, { ...s, imagePosition: "left" });
      return shell(ctx, s, `${head(s, null, b.heading)}<div class="feature">${media(img, "wide", "feature__media")}<div class="feature__body"><h3 class="t-h3">${esc(first?.name ?? "")}</h3><p>${esc(clampText(first?.description ?? "", 320))}</p>${rest.length ? `<ul class="feature__rest">${rest.slice(0, 5).map((i) => `<li><strong>${esc(i.name)}</strong> ${esc(clampText(i.description, 110))}</li>`).join("")}</ul>` : ""}</div></div>`);
    },
  },
  ProgramCards: {
    family: "programs", accepts: ["programs"], variants: ["cards", "cards-with-images"],
    whenToUse: "Three to six programs of similar weight. Use sparingly; one card grid per site.",
    render: (ctx, s, block) => {
      const b = block as B<"programs">;
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, b.heading)}<div class="cards">${b.items.slice(0, 6).map((i) => `<article class="card program"><h3 class="t-h3">${esc(i.name)}</h3><p>${esc(clampText(i.description, 200))}</p></article>`).join("")}</div>`);
    },
  },
  ProgramTimeline: {
    family: "programs", accepts: ["steps", "programs"], variants: ["vertical", "horizontal"],
    whenToUse: "A process or journey in order: how to apply, what happens next.",
    render: (ctx, s, block) => {
      const items = block.kind === "steps" ? block.items : (block as B<"programs">).items.map((i) => ({ title: i.name, body: i.description }));
      const intro = block.kind === "steps" ? block.intro : null;
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, (block as { heading?: string }).heading ?? null, intro ?? null)}<ol class="steps steps--${s.variant ?? "vertical"}">${items.slice(0, 7).map((i) => `<li class="step"><h3 class="t-h3">${esc(i.title)}</h3><p>${esc(clampText(i.body, 220))}</p></li>`).join("")}</ol>`);
    },
  },

  TestimonialFeature: {
    family: "stories", accepts: ["quote"], variants: ["with-image", "plain"],
    whenToUse: "A testimonial as a feature with a photograph beside it.",
    render: (ctx, s, block) => {
      const b = block as B<"quote">;
      const img = imageFor(ctx, { ...s, imagePosition: s.imagePosition === "none" ? "left" : s.imagePosition });
      return shell(ctx, s, `<div class="testimonial">${media(img, "square", "testimonial__media")}<figure class="quote"><blockquote><p>${esc(clampText(b.quote, 300))}</p></blockquote>${b.attribution ? `<figcaption><strong>${esc(b.attribution)}</strong>${b.role ? `<span>${esc(b.role)}</span>` : ""}</figcaption>` : ""}</figure></div>`);
    },
  },
  StoryGrid: {
    family: "stories", accepts: ["programs", "team"], variants: ["three-up"],
    whenToUse: "Short stories or highlights as a three-up grid with images.",
    render: (ctx, s, block) => {
      const items = block.kind === "programs" ? block.items.map((i) => ({ title: i.name, body: i.description })) : (block as B<"team">).members.map((m) => ({ title: m.name, body: m.bio ?? m.role }));
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, (block as { heading?: string }).heading ?? null)}<div class="cards cards--stories">${items.slice(0, 6).map((i, n) => `<article class="card story">${media(ctx.images[n % Math.max(1, ctx.images.length)] ?? null, "wide")}<h3 class="t-h3">${esc(i.title)}</h3><p>${esc(clampText(i.body, 180))}</p></article>`).join("")}</div>`);
    },
  },

  DonateCTA: {
    family: "engagement", accepts: ["cta", "donate"], variants: ["band", "card"],
    whenToUse: "A single strong call to give or act, as a full band. Once per page.",
    render: (ctx, s, block) => {
      const heading = (block as { heading: string }).heading;
      const body = "body" in block ? (block as B<"donate">).body : null;
      const href = "href" in block ? block.href : (ctx.donateUrl ?? "/donate/");
      const label = "buttonText" in block ? block.buttonText : "Donate";
      return shell(ctx, { ...s, background: s.background === "default" ? "primary" : s.background }, `<div class="cta-band__inner">${head(s, null, heading, body ?? null, { narrow: false })}<div class="actions">${btn(label, href, "primary")}</div></div>`, { extraClass: "cta-band" });
    },
  },
  DonateModule: {
    family: "engagement", accepts: ["donate", "cta"], variants: ["panel"],
    whenToUse: "The donation page's working module: amounts, secure give button, trust signals, impact tiers.",
    render: (ctx, s, block) => {
      const b = block.kind === "donate" ? block : null;
      const href = b?.href ?? ctx.donateUrl;
      const tiers = b?.tiers?.slice(0, 4) ?? [];
      const amounts = tiers.length ? tiers.map((t) => t.amount) : ["$25", "$50", "$100", "$250"];
      const org = ctx.organization;
      const trust = [
        href ? "Secure, encrypted donation page" : null,
        org.status ? `${esc(org.legalName ?? org.name)} is a registered ${esc(org.status)}` : null,
        org.ein ? `EIN ${esc(org.ein)}` : null,
      ].filter(Boolean);
      const panel = href
        ? `<div class="donate__panel"><h3 class="donate__heading">Choose an amount</h3><div class="donate__amounts">${amounts.map((a, i) => `<a class="btn btn--amount${i === 2 ? " btn--featured" : ""}" href="${esc(safeHref(href))}">${esc(a)}</a>`).join("")}</div>${btn(b?.buttonText ?? "Give securely", href, "primary")}<p class="donate__note">You will complete your gift on our secure donation page. Monthly giving is available there.</p>${trust.length ? `<ul class="donate__trust">${trust.map((t) => `<li>${t}</li>`).join("")}</ul>` : ""}</div>`
        : `<form class="form donate__form" method="post" action="/forms/${esc(ctx.site.slug)}/donate"><input type="hidden" name="website" value=""><h3 class="donate__heading">Tell us you'd like to give</h3><p class="donate__note">Online giving is not set up yet. Leave your details and a member of the team will follow up.</p><div class="field"><label for="d-name">Name</label><input id="d-name" name="name" type="text" required></div><div class="field"><label for="d-email">Email</label><input id="d-email" name="email" type="email" required></div><div class="field"><label for="d-amount">Intended gift</label><input id="d-amount" name="amount" type="text" placeholder="$50"></div><button class="btn btn--primary" type="submit">Send</button></form>`;
      const impact = tiers.length ? `<ul class="donate__impact">${tiers.map((t) => `<li><strong>${esc(t.amount)}</strong><span>${esc(clampText(t.effect, 120))}</span></li>`).join("")}</ul>` : "";
      return shell(ctx, s, `${head(s, null, (block as { heading: string }).heading, b?.body ?? null)}<div class="donate">${panel}${impact}</div>`);
    },
  },
  VolunteerCTA: {
    family: "engagement", accepts: ["cta"], variants: ["band"],
    whenToUse: "A call to volunteer or join, as a band.",
    render: (ctx, s, block) => {
      const b = block as B<"cta">;
      return shell(ctx, { ...s, background: s.background === "default" ? "accent-tint" : s.background }, `<div class="cta-band__inner">${head(s, null, b.heading, null, { narrow: false })}<div class="actions">${btn(b.buttonText, b.href, "primary")}</div></div>`, { extraClass: "cta-band" });
    },
  },
  GetInvolvedSection: {
    family: "engagement", accepts: ["steps", "programs", "cta"], variants: ["three-ways"],
    whenToUse: "Ways to help side by side (give, volunteer, partner), each with an action.",
    render: (ctx, s, block) => {
      const items = block.kind === "steps" ? block.items.map((i) => ({ title: i.title, body: i.body })) : block.kind === "programs" ? block.items.map((i) => ({ title: i.name, body: i.description })) : [{ title: (block as B<"cta">).heading, body: "" }];
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, (block as { heading?: string }).heading ?? null)}<div class="ways">${items.slice(0, 3).map((i) => `<article class="way"><h3 class="t-h3">${esc(i.title)}</h3><p>${esc(clampText(i.body, 200))}</p></article>`).join("")}</div>${ctx.primaryCta ? `<div class="actions">${btn(ctx.primaryCta.label, ctx.primaryCta.href)}</div>` : ""}`);
    },
  },
  NewsletterCTA: {
    family: "engagement", accepts: ["form", "cta"], variants: ["inline"],
    whenToUse: "A one-field sign-up form on a band.",
    render: (ctx, s, block) => {
      const heading = (block as { heading: string }).heading;
      const key = block.kind === "form" ? block.formKey : "newsletter";
      return shell(ctx, { ...s, background: s.background === "default" ? "muted" : s.background }, `<div class="newsletter">${head(s, null, heading, null, { narrow: false })}<form class="form form--inline" method="post" action="/forms/${esc(ctx.site.slug)}/${esc(key)}"><input type="hidden" name="website" value=""><div class="field"><label for="nl-email">Email address</label><input id="nl-email" name="email" type="email" required placeholder="you@example.org"></div><button class="btn btn--primary" type="submit">Subscribe</button></form></div>`);
    },
  },

  FullBleedImage: {
    family: "media", accepts: ["text", "quote", "split"], variants: ["plain", "caption"],
    whenToUse: "A photograph given the whole width as a pause in the page, optionally with a caption.",
    render: (ctx, s, block) => {
      const img = imageFor(ctx, { ...s, imagePosition: "full" });
      if (!img) return CATALOG.EditorialTextSection.render(ctx, s, block.kind === "text" ? block : { kind: "text", heading: null, body: blockText(block) });
      const caption = s.variant === "caption" ? `<figcaption class="container">${esc(clampText(blockText(block), 160))}</figcaption>` : "";
      return `<section class="section section--bleed" id="${esc(s.id)}"${reveal(ctx, s)}${parallax(ctx, s)}><figure class="bleed"><img src="${esc(img.path)}" alt="${esc(img.alt)}" loading="lazy" decoding="async">${caption}</figure></section>`;
    },
  },
  ImageStrip: {
    family: "media", accepts: ["text", "logos", "programs"], variants: ["three"],
    whenToUse: "Two or three photographs in a row as a visual pause.",
    render: (ctx, s) => {
      const imgs = ctx.images.slice(0, 3);
      if (!imgs.length) return "";
      return shell(ctx, { ...s, motion: "stagger" }, `<div class="strip strip--${imgs.length}">${imgs.map((i) => media(i, "square")).join("")}</div>`, { fullBleed: false });
    },
  },

  TeamGrid: {
    family: "other", accepts: ["team"], variants: ["grid", "list"],
    whenToUse: "Board and staff with roles and short bios.",
    render: (ctx, s, block) => {
      const b = block as B<"team">;
      return shell(ctx, { ...s, motion: "stagger" }, `${head(s, null, b.heading)}<ul class="team team--${s.variant ?? "grid"}">${b.members.slice(0, 12).map((m) => `<li class="person"><h3 class="person__name">${esc(m.name)}</h3><p class="person__role">${esc(m.role)}</p>${m.bio ? `<p>${esc(clampText(m.bio, 200))}</p>` : ""}</li>`).join("")}</ul>`);
    },
  },
  PartnersStrip: {
    family: "other", accepts: ["logos"], variants: ["names"],
    whenToUse: "Funders and partners named in a quiet strip.",
    render: (ctx, s, block) => {
      const b = block as B<"logos">;
      return shell(ctx, s, `${head(s, null, b.heading)}<ul class="logos">${b.names.slice(0, 12).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
    },
  },
  FAQ: {
    family: "other", accepts: ["faq"], variants: ["accordion"],
    whenToUse: "The questions funders and families ask, as an accordion.",
    render: (ctx, s, block) => {
      const b = block as B<"faq">;
      return shell(ctx, s, `${head(s, null, b.heading)}<div class="faq">${b.items.slice(0, 10).map((i, n) => `<details class="faq__item"${n === 0 ? " open" : ""}><summary>${esc(i.q)}</summary><div class="faq__answer"><p>${esc(i.a)}</p></div></details>`).join("")}</div>`, { narrow: true });
    },
  },
  ContactSection: {
    family: "other", accepts: ["form", "contact"], variants: ["split", "stacked"],
    whenToUse: "Contact details beside a short form.",
    render: (ctx, s, block) => {
      const contact = ctx.page.blocks.find((x): x is B<"contact"> => x.kind === "contact") ?? (block.kind === "contact" ? block : null);
      const form = ctx.page.blocks.find((x): x is B<"form"> => x.kind === "form") ?? (block.kind === "form" ? block : null);
      const org = ctx.organization;
      const details = `<address class="contact__details">${org.legalName || org.name ? `<p class="contact__org">${esc(org.legalName ?? org.name)}</p>` : ""}${
        (contact?.email ?? org.contactEmail) ? `<p><a href="mailto:${esc(contact?.email ?? org.contactEmail)}">${esc(contact?.email ?? org.contactEmail)}</a></p>` : ""}${
        (contact?.phone ?? org.contactPhone) ? `<p><a href="tel:${esc((contact?.phone ?? org.contactPhone ?? "").replace(/[^+0-9]/g, ""))}">${esc(contact?.phone ?? org.contactPhone)}</a></p>` : ""}${
        (contact?.address ?? org.headquarters) ? `<p>${esc(contact?.address ?? org.headquarters)}</p>` : ""}</address>`;
      const fields = form ? form.fields.slice(0, 6).map((f) => `<div class="field"><label for="f-${esc(f.key)}">${esc(f.label)}</label>${f.type === "textarea" ? `<textarea id="f-${esc(f.key)}" name="${esc(f.key)}" rows="5"${f.required ? " required" : ""}></textarea>` : `<input id="f-${esc(f.key)}" name="${esc(f.key)}" type="${esc(f.type)}"${f.required ? " required" : ""}>`}</div>`).join("") : "";
      const formHtml = form ? `<form class="form" method="post" action="/forms/${esc(ctx.site.slug)}/${esc(form.formKey)}"><input type="hidden" name="website" value="">${fields}<button class="btn btn--primary" type="submit">Send message</button></form>` : "";
      return shell(ctx, s, `${head(s, null, (block as { heading?: string }).heading ?? "Contact")}<div class="contact contact--${s.variant ?? "split"}">${details}${formHtml}</div>`);
    },
  },
};

function blockText(block: SiteBlock): string {
  switch (block.kind) {
    case "text": return block.body;
    case "split": return block.body;
    case "quote": return block.quote;
    case "programs": return block.items.map((i) => `${i.name}: ${i.description}`).join("\n\n");
    case "steps": return block.items.map((i) => `${i.title}: ${i.body}`).join("\n\n");
    case "faq": return block.items.map((i) => `${i.q} ${i.a}`).join("\n\n");
    case "team": return block.members.map((m) => `${m.name}, ${m.role}`).join("\n");
    case "logos": return block.names.join(", ");
    case "contact": return [block.email, block.phone, block.address].filter(Boolean).join("\n");
    case "cta": return block.heading;
    case "donate": return block.body ?? block.heading;
    case "hero": return block.tagline;
    case "form": return block.heading;
    case "stats": return block.items.map((i) => `${i.value} ${i.label}`).join(", ");
  }
}

/** The planner's default when it does not choose, or chooses badly. */
export const DEFAULT_COMPONENT: Record<SiteBlock["kind"], ComponentName> = {
  hero: "EditorialHero", text: "EditorialTextSection", programs: "ProgramEditorialGrid", stats: "ImpactMetrics",
  cta: "DonateCTA", form: "ContactSection", contact: "ContactSection", quote: "QuoteSection", steps: "ProgramTimeline",
  faq: "FAQ", team: "TeamGrid", logos: "PartnersStrip", split: "SplitStorySection", donate: "DonateModule",
};

/** A compact description of the library for the planner's prompt. */
export function catalogForPrompt(): string {
  return (Object.entries(CATALOG) as Array<[ComponentName, ComponentSpec]>)
    .map(([name, spec]) => `${name} [${spec.family}] accepts: ${spec.accepts.join("/")}; variants: ${spec.variants.join(", ")} — ${spec.whenToUse}`)
    .join("\n");
}

// ---- header + footer ---------------------------------------------------------

export function renderHeader(ctx: RenderCtx, variant: DesignTokens["header"], hasImageHero: boolean): string {
  const pages = ctx.nav.filter((n) => n.href !== "/").slice(0, 4);
  const current = `/${ctx.page.slug === "home" ? "" : `${ctx.page.slug}/`}`;
  const link = (n: { title: string; href: string }) => `<li><a href="${esc(n.href)}"${n.href === current ? ' aria-current="page"' : ""}>${esc(n.title)}</a></li>`;
  const cta = ctx.primaryCta ?? (ctx.donateUrl ? { label: "Donate", href: ctx.donateUrl } : { label: "Contact", href: "/contact/" });
  const transparent = variant === "transparent-over-hero" && hasImageHero;
  return `<header class="site-header site-header--${variant}${transparent ? " is-transparent" : ""}"><div class="container site-header__inner"><a class="brand" href="/"${current === "/" ? ' aria-current="page"' : ""}>${esc(ctx.site.name)}</a><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="visually-hidden">Menu</span><span class="nav-toggle__bar" aria-hidden="true"></span></button><nav class="site-nav" id="site-nav" aria-label="Main"><ul>${pages.map(link).join("")}</ul>${btn(cta.label, cta.href, "primary").replace('class="btn btn--primary"', 'class="btn btn--primary site-header__cta"')}</nav></div></header>`;
}

export function renderFooter(ctx: RenderCtx): string {
  const org = ctx.organization;
  const year = new Date().getFullYear();
  const legal = [
    org.status ? `${esc(org.legalName ?? org.name)} is a registered ${esc(org.status)}.` : "",
    org.ein ? `EIN ${esc(org.ein)}.` : "",
  ].filter(Boolean).join(" ");
  return `<footer class="site-footer"><div class="container"><div class="footer__grid"><div class="footer__about"><p class="brand">${esc(ctx.site.name)}</p>${org.mission ? `<p>${esc(clampText(org.mission, 200))}</p>` : ""}</div><nav class="footer__nav" aria-label="Footer"><h2 class="footer__heading">Pages</h2><ul>${ctx.nav.map((n) => `<li><a href="${esc(n.href)}">${esc(n.title)}</a></li>`).join("")}</ul></nav><div class="footer__contact"><h2 class="footer__heading">Contact</h2><address>${org.contactEmail ? `<p><a href="mailto:${esc(org.contactEmail)}">${esc(org.contactEmail)}</a></p>` : ""}${org.contactPhone ? `<p><a href="tel:${esc(org.contactPhone.replace(/[^+0-9]/g, ""))}">${esc(org.contactPhone)}</a></p>` : ""}${org.headquarters ? `<p>${esc(org.headquarters)}</p>` : ""}</address></div></div><div class="footer__legal">${legal ? `<p class="footer__status">${legal}</p>` : ""}<p>© ${year} ${esc(org.legalName ?? org.name)}. <a href="/privacy-policy/">Privacy policy</a></p></div></div></footer>`;
}
