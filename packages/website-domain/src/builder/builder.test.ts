import { describe, expect, it } from "vitest";
import type { SiteBlock, SitePage } from "@deedwell/schemas";
import { CATALOG, DEFAULT_COMPONENT, clampText, headingClass } from "./components.js";
import { repairComposition } from "./critic.js";
import { fallbackTokens } from "./designSystem.js";
import { MOTION_SCRIPT, MOTION_SCRIPT_HASH } from "./motion.js";
import { normalize } from "./pagePlanner.js";
import { DEFAULT_LANGUAGE } from "./referenceAnalyzer.js";
import { renderPage } from "./renderPage.js";
import { COMPONENTS, type ComponentName, type Section } from "./schemas.js";
import { contrastRatio, harmonizeColors, tokensToCss } from "./tokens.js";

const tokens = fallbackTokens(DEFAULT_LANGUAGE, { primaryColor: "#2b6cb0" });
const org = { name: "Riverbend Youth Alliance", legalName: "Riverbend Youth Alliance Inc.", mission: "Mentoring for young people in Riverbend County.", headquarters: "12 Main St", status: "501(c)(3) nonprofit", ein: "12-3456789", contactEmail: "hello@example.org", contactPhone: "+1 555 0100" };
const images = [{ key: "hero", path: "/images/hero.png", storageKey: "x", alt: "Young people", purpose: "hero", forPage: "home", mime: "image/png" }];
const nav = [{ title: "Home", href: "/" }, { title: "About", href: "/about/" }, { title: "Programs", href: "/programs/" }, { title: "Impact", href: "/impact/" }, { title: "Get Involved", href: "/get-involved/" }, { title: "Donate", href: "/donate/" }, { title: "Contact", href: "/contact/" }, { title: "Privacy", href: "/privacy-policy/" }];

const SAMPLE: Record<SiteBlock["kind"], SiteBlock> = {
  hero: { kind: "hero", heading: "Every young person in Riverbend deserves a mentor who shows up", tagline: "We pair 10 to 18 year olds with trained mentors for a year of weekly meetings.", ctaText: "Donate", ctaHref: "https://donate.example.org", eyebrow: "Riverbend County", secondaryText: "Our programs", secondaryHref: "/programs/" },
  text: { kind: "text", heading: "Why mentoring", body: "Paragraph one about mentoring.\n\nParagraph two about outcomes." },
  programs: { kind: "programs", heading: "Programs", items: [{ name: "Mentoring", description: "One-to-one weekly mentoring." }, { name: "Tutoring", description: "After-school tutoring." }, { name: "Summer camp", description: "STEM camp." }] },
  stats: { kind: "stats", items: [{ label: "Young people served", value: "1,240" }, { label: "Mentor matches", value: "310" }, { label: "Graduation rate", value: "94%" }] },
  cta: { kind: "cta", heading: "Help a young person finish school", buttonText: "Give now", href: "https://donate.example.org" },
  form: { kind: "form", formKey: "contact", heading: "Message us", fields: [{ key: "email", label: "Email", type: "email", required: true }, { key: "message", label: "Message", type: "textarea", required: true }] },
  contact: { kind: "contact", email: "hello@example.org", phone: "+1 555 0100", address: "12 Main St" },
  quote: { kind: "quote", quote: "My mentor was the first adult who asked what I wanted.", attribution: "A participant", role: "Age 16" },
  steps: { kind: "steps", heading: "How it works", intro: "Three steps.", items: [{ title: "Apply", body: "Fill in the form." }, { title: "Match", body: "We pair you." }, { title: "Meet", body: "Weekly." }] },
  faq: { kind: "faq", heading: "Questions", items: [{ q: "Who is eligible?", a: "Young people 10 to 18." }] },
  team: { kind: "team", heading: "Board", members: [{ name: "A. Person", role: "Chair", bio: "Bio." }] },
  logos: { kind: "logos", heading: "Partners", names: ["Riverbend Library", "County Schools"] },
  split: { kind: "split", heading: "A year of mentoring", body: "What a year looks like.", highlights: ["Weekly meetings", "Trained mentors"], ctaText: "Learn more", ctaHref: "/programs/" },
  donate: { kind: "donate", heading: "Give", body: "Your gift funds mentoring.", href: "https://donate.example.org", tiers: [{ amount: "$25", effect: "A month of materials" }, { amount: "$100", effect: "A mentor's training" }], buttonText: "Donate" },
};

const pageWith = (blocks: SiteBlock[], slug = "home"): SitePage => ({ slug, title: "Home", seoDescription: "A test", blocks });
const ctx = { site: { name: "Riverbend Youth Alliance", slug: "riverbend" }, tokens, images, organization: org, donateUrl: "https://donate.example.org", nav };

describe("design tokens", () => {
  it("emits a stylesheet from fixed scales and fixes contrast", () => {
    const { colors, adjustments } = harmonizeColors({ ...tokens.colors, foreground: "#bbbbbb", onPrimary: "#2b6cb0" });
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(colors.onPrimary, colors.primary)).toBeGreaterThanOrEqual(4.5);
    expect(adjustments.length).toBeGreaterThan(0);
    const css = tokensToCss(tokens);
    expect(css).toContain("--fs-h1:clamp(");
    expect(css).toContain("--s-10:");
    expect(css).not.toMatch(/undefined|NaN/);
  });
});

describe("component library", () => {
  it("renders every component from a compatible block without leaking undefined", () => {
    for (const name of COMPONENTS) {
      const spec = CATALOG[name];
      for (const kind of spec.accepts) {
        const block = SAMPLE[kind];
        const page = pageWith([block, SAMPLE.stats, SAMPLE.form, SAMPLE.contact]);
        const section: Section = { id: "s1", purpose: "t", component: name, background: "default", imagePosition: "right", image: "hero", block: 0, density: "balanced", motion: "fade-up", mobile: "stack" };
        const html = spec.render({ ...ctx, page, primaryCta: { label: "Donate", href: "/donate/" } }, section, block);
        expect(html, `${name} with ${kind}`).not.toMatch(/undefined|\[object Object\]|NaN/);
      }
    }
  });
  it("steps long headings down and clamps long copy", () => {
    expect(headingClass("Short and strong", "display")).toBe("t-display");
    expect(headingClass("A heading that runs on for quite a while and would wrap onto many lines at any size", "display")).toBe("t-h2");
    expect(clampText("First sentence. Second sentence that is long enough to be cut.", 30)).toBe("First sentence.");
  });
});

describe("page rendering", () => {
  const blocks = [SAMPLE.hero, SAMPLE.stats, SAMPLE.programs, SAMPLE.quote, SAMPLE.donate, SAMPLE.faq, SAMPLE.form, SAMPLE.contact];
  const page = pageWith(blocks);
  const composition = normalize(null, { page, images, donateUrl: "https://donate.example.org", language: DEFAULT_LANGUAGE });
  const html = renderPage({ ctx, page, composition, tokens });

  it("assembles a complete, well-formed page with a five-link header and a full footer", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    const header = /<header[\s\S]*?<\/header>/.exec(html)![0];
    expect([...header.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "").filter((h) => h !== "/" && !h.startsWith("http")).length).toBeLessThanOrEqual(5);
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html)![0];
    for (const n of nav) expect(footer).toContain(`href="${n.href}"`);
    expect(footer).toContain("registered 501(c)(3) nonprofit");
    expect(footer).toContain("EIN 12-3456789");
    expect(html).toContain(`<script>${MOTION_SCRIPT}</script>`);
    expect(MOTION_SCRIPT_HASH).toMatch(/^sha256-/);
    expect(html).toContain('data-count="1,240"');
    expect(html).toContain('class="donate__amounts"');
    expect(html).toContain('action="/forms/riverbend/contact"');
    expect(html).toContain('<label for="f-email">');
  });
  it("alternates backgrounds and never repeats a component back to back", () => {
    const comps = composition.sections.map((s) => s.component);
    for (let i = 1; i < comps.length; i += 1) expect(comps[i]).not.toBe(comps[i - 1]);
    expect(composition.sections[0]!.component).toBe(DEFAULT_COMPONENT.hero);
  });
  it("corrects an invalid plan rather than failing", () => {
    const bad = { slug: "home", objective: "x", primaryCta: null, secondaryCta: null, sections: [
      { id: "a", purpose: "p", component: "FAQ", block: 0 },          // FAQ cannot present a hero
      { id: "b", purpose: "p", component: "StatisticsBand", block: 1, background: "dark" },
      { id: "c", purpose: "p", component: "ProgramCards", block: 2, background: "primary" },  // two strong bands in a row
    ] };
    const fixed = normalize(bad, { page, images, donateUrl: null, language: DEFAULT_LANGUAGE });
    expect(fixed.sections[0]!.component).toBe("EditorialHero");
    expect(fixed.sections[2]!.background).toBe("muted");
    expect(fixed.sections).toHaveLength(blocks.length);
  });
});

describe("repair pass", () => {
  it("applies targeted fixes to the composition only", () => {
    const page = pageWith([SAMPLE.hero, SAMPLE.text, SAMPLE.programs]);
    const composition = normalize(null, { page, images, donateUrl: null, language: DEFAULT_LANGUAGE });
    const { composition: fixed, applied } = repairComposition(composition, [
      { section: composition.sections[0]!.id, problem: "Hero title wraps to four lines", severity: "high", fix: "reduce-heading-scale" },
      { section: composition.sections[2]!.id, problem: "Cramped", severity: "medium", fix: "increase-spacing" },
      { section: composition.sections[1]!.id, problem: "minor", severity: "low", fix: "change-background" },
    ]);
    expect(fixed.sections[0]!.component).toBe("SplitHero");
    expect(fixed.sections[2]!.density).toBe("airy");
    expect(fixed.sections[1]!.background).toBe(composition.sections[1]!.background); // low severity ignored
    expect(applied).toHaveLength(2);
    const name: ComponentName = fixed.sections[0]!.component;
    expect(COMPONENTS).toContain(name);
  });
});
