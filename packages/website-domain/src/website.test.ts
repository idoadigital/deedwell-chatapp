import { describe, expect, it } from "vitest";
import type { SitePage } from "@deedwell/schemas";
import { MockModelProvider } from "@deedwell/agent-runtime";
import { SitePatchOutput } from "@deedwell/schemas";
import { renderSite } from "./renderer.js";
import { blockingFailures, runSiteChecks } from "./checks.js";

const PAGES: SitePage[] = [
  {
    slug: "home",
    title: "Home",
    seoDescription: "A test site",
    blocks: [
      { kind: "hero", heading: "Test Org", tagline: "Doing good", ctaText: "Donate", ctaHref: "https://donate.example" },
    ],
  },
  {
    slug: "contact",
    title: "Contact",
    seoDescription: "Contact us",
    blocks: [
      {
        kind: "form", formKey: "contact", heading: "Message us",
        fields: [{ key: "email", label: "Email", type: "email", required: true }],
      },
    ],
  },
];

const THEME = { palette: "forest", headingFont: "serif" } as const;

describe("static site renderer (approved templates)", () => {
  it("escapes hostile content — user data can never become markup", () => {
    const hostile: SitePage[] = [
      {
        slug: "home", title: "Home", seoDescription: `"><script>alert(1)</script>`,
        blocks: [
          { kind: "hero", heading: "<script>alert(1)</script>", tagline: `<img src=x onerror=alert(1)>`, ctaText: null, ctaHref: null },
        ],
      },
    ];
    const files = renderSite({ siteName: "X", slug: "x", pages: hostile, theme: THEME });
    const html = files[0]!.content;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: hrefs", () => {
    const pages: SitePage[] = [
      {
        slug: "home", title: "Home", seoDescription: "d",
        blocks: [{ kind: "cta", heading: "Go", buttonText: "Click", href: "javascript:alert(1)" }],
      },
    ];
    const [file] = renderSite({ siteName: "X", slug: "x", pages, theme: THEME });
    expect(file!.content).not.toContain("javascript:");
    expect(file!.content).toContain('href="#"');
  });

  it("produces accessible, self-contained pages plus sitemap and robots", () => {
    const files = renderSite({ siteName: "Test Org", slug: "test", pages: PAGES, theme: THEME });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("contact/index.html");
    expect(paths).toContain("sitemap.xml");
    expect(paths).toContain("robots.txt");
    expect(paths).toContain("thanks/index.html");
    const home = files.find((f) => f.path === "index.html")!.content;
    expect(home).toContain('lang="en"');
    expect(home).toContain("Skip to main content");
    expect(home).not.toContain("<script");
    const contact = files.find((f) => f.path === "contact/index.html")!.content;
    expect(contact).toContain('action="/forms/test/contact"');
    expect(contact).toContain('name="website"'); // honeypot
  });
});

describe("deterministic SEO/accessibility checks", () => {
  it("passes a well-formed release and flags placeholders", () => {
    const files = renderSite({ siteName: "Test Org", slug: "test", pages: PAGES, theme: THEME });
    const checks = runSiteChecks(files, PAGES);
    expect(checks.every((c) => c.pass)).toBe(true);

    const withPlaceholder: SitePage[] = [
      { ...PAGES[0]!, blocks: [{ kind: "text", heading: null, body: "[Placeholder: add your mission]" }] },
    ];
    const files2 = renderSite({ siteName: "T", slug: "t", pages: withPlaceholder, theme: THEME });
    const checks2 = runSiteChecks(files2, withPlaceholder);
    expect(checks2.find((c) => c.name.includes("placeholder"))?.pass).toBe(false);
  });

  it("detects broken internal links", () => {
    const pages: SitePage[] = [
      {
        slug: "home", title: "Home", seoDescription: "d",
        blocks: [{ kind: "cta", heading: "Go", buttonText: "Missing", href: "/no-such-page/" }],
      },
    ];
    const files = renderSite({ siteName: "X", slug: "x", pages, theme: THEME });
    const checks = runSiteChecks(files, pages);
    expect(checks.find((c) => c.name === "Internal links resolve")?.pass).toBe(false);
  });

  it("broken links, placeholders, and missing routes are BLOCKING failures", () => {
    const pages: SitePage[] = [
      {
        slug: "home", title: "Home", seoDescription: "d",
        blocks: [
          { kind: "cta", heading: "Go", buttonText: "Missing", href: "/no-such-page/" },
          { kind: "text", heading: null, body: "[Placeholder: add your mission]" },
        ],
      },
    ];
    const files = renderSite({ siteName: "X", slug: "x", pages, theme: THEME });
    const blocking = blockingFailures(runSiteChecks(files, pages));
    expect(blocking.map((c) => c.name)).toContain("Internal links resolve");
    expect(blocking.map((c) => c.name)).toContain("No placeholder content remaining");
    // A page set claiming a page that was never rendered must block too.
    const claimed = [...pages, { slug: "ghost", title: "Ghost", seoDescription: "d", blocks: [] as SitePage["blocks"] }];
    const blocking2 = blockingFailures(runSiteChecks(files, claimed));
    expect(blocking2.some((c) => c.name === "Page route rendered" && c.page === "/ghost/")).toBe(true);
  });

  it("normalizes model-written internal links to trailing-slash form", () => {
    const pages: SitePage[] = [
      { slug: "home", title: "Home", seoDescription: "d", blocks: [
        { kind: "cta", heading: "Go", buttonText: "About", href: "/about-us" }, // no trailing slash
      ] },
      { slug: "about-us", title: "About", seoDescription: "d", blocks: [
        { kind: "text", heading: null, body: "hello" },
      ] },
    ];
    const files = renderSite({ siteName: "X", slug: "x", pages, theme: THEME });
    expect(files.find((f) => f.path === "index.html")!.content).toContain('href="/about-us/"');
    expect(blockingFailures(runSiteChecks(files, pages))).toHaveLength(0);
  });

  it("advisory failures (meta description) do not block", () => {
    const files = renderSite({ siteName: "Test Org", slug: "test", pages: PAGES, theme: THEME });
    const checks = runSiteChecks(files, PAGES).map((c) =>
      c.name === "Meta description present" ? { ...c, pass: false } : c
    );
    expect(blockingFailures(checks)).toHaveLength(0);
  });
});

describe("conversational patch (mock provider)", () => {
  const provider = new MockModelProvider();
  const patch = async (instruction: string, pages = PAGES) => {
    const res = await provider.complete({
      system: "s", task: "t",
      dataBlocks: [
        { label: "pages", content: JSON.stringify(pages) },
        { label: "instruction", content: instruction },
      ],
      outputSchemaRef: "site_patch",
    });
    return SitePatchOutput.parse(JSON.parse(res.text));
  };

  it('applies: change the tagline to "..."', async () => {
    const out = await patch('Change the tagline to "Hope grows here"');
    expect(out.applied).toBe(true);
    const hero = out.pages[0]!.blocks[0]!;
    expect(hero.kind === "hero" && hero.tagline).toBe("Hope grows here");
  });

  it("applies: add a volunteer form to the contact page", async () => {
    const out = await patch("Please add a volunteer form");
    expect(out.applied).toBe(true);
    const contact = out.pages.find((p) => p.slug === "contact")!;
    expect(contact.blocks.some((b) => b.kind === "form" && b.formKey === "volunteer")).toBe(true);
  });

  it("refuses honestly when it cannot translate the request", async () => {
    const out = await patch("Make the vibes more synergistic going forward");
    expect(out.applied).toBe(false);
    expect(out.reason).toBeTruthy();
    expect(out.pages).toEqual(PAGES); // untouched
  });

  it("refuses to remove the home page", async () => {
    const out = await patch('Remove the page "Home"');
    expect(out.applied).toBe(false);
  });
});
