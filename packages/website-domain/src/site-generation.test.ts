import { describe, expect, it } from "vitest";
import { ensureRequiredSections, siteGenerationDataBlocks } from "./site-generation.js";

const page = (slug: string, title: string, purpose = "") => ({ slug, title, purpose });

describe("ensureRequiredSections", () => {
  it("leaves a sitemap alone when nothing is required", () => {
    const sitemap = [page("home", "Home"), page("about", "About")];
    expect(ensureRequiredSections(sitemap, [])).toEqual(sitemap);
  });

  it("appends a page for each missing section, using the section's key as slug", () => {
    const out = ensureRequiredSections(
      [page("home", "Home"), page("programs", "Programs")],
      [
        { key: "privacy-policy", title: "Privacy Policy", description: "How data is handled." },
        { key: "financials", title: "Financials", description: "" },
      ]
    );
    expect(out.map((p) => p.slug)).toEqual(["home", "programs", "privacy-policy", "financials"]);
    expect(out[2]!.purpose).toBe("How data is handled.");
    expect(out[3]!.purpose).toMatch(/Required for grant approval/);
  });

  it("recognises a section the strategist already covered by title, slug or purpose", () => {
    const out = ensureRequiredSections(
      [
        page("home", "Home"),
        page("our-story", "Our Story"),
        page("get-involved", "Get Involved", "Volunteer sign-up and the donate button."),
      ],
      [
        { key: "about", title: "Our story", description: "" },
        { key: "donate", title: "Donate", description: "" },
        { key: "get-involved", title: "Volunteering", description: "" },
      ]
    );
    expect(out).toHaveLength(3);
  });

  it("treats a page whose slug equals the section key as covering it", () => {
    const out = ensureRequiredSections(
      [page("home", "Home"), page("contact", "Reach the team")],
      [{ key: "contact", title: "Contact us", description: "" }]
    );
    expect(out.map((p) => p.slug)).toEqual(["home", "contact"]);
  });

  it("keeps the sitemap under the cap by dropping optional pages, never required ones", () => {
    const sitemap = [
      page("home", "Home"), page("a", "A"), page("b", "B"), page("c", "C"), page("d", "D"),
      page("e", "E"), page("f", "F"), page("g", "G"), page("h", "H"), page("i", "I"),
    ];
    const out = ensureRequiredSections(sitemap, [
      { key: "privacy", title: "Privacy", description: "" },
      { key: "financials", title: "Financials", description: "" },
    ]);
    expect(out).toHaveLength(10);
    expect(out[0]!.slug).toBe("home");
    expect(out.map((p) => p.slug)).toContain("privacy");
    expect(out.map((p) => p.slug)).toContain("financials");
    expect(out.map((p) => p.slug)).not.toContain("i");
    expect(out.map((p) => p.slug)).not.toContain("h");
  });
});

describe("siteGenerationDataBlocks", () => {
  it("adds nothing when settings are empty and there is no template", () => {
    expect(siteGenerationDataBlocks({ requiredSections: [], guidance: "" }, null)).toEqual([]);
  });

  it("carries requirements as data and the reference as an image block", () => {
    const blocks = siteGenerationDataBlocks(
      { requiredSections: [{ key: "privacy", title: "Privacy", description: "" }], guidance: "Funders read the About page first." },
      { id: "t1", title: "Warm community landing", description: "Big photo hero.", mime: "image/png", bytes: Buffer.from("png") }
    );
    expect(blocks.map((b) => b.label)).toEqual(["grant_requirements", "design_reference"]);
    expect(JSON.parse(blocks[0]!.content)).toMatchObject({ guidance: "Funders read the About page first." });
    expect(blocks[1]!.image).toEqual({ mime: "image/png", base64: Buffer.from("png").toString("base64") });
    expect(blocks[1]!.content).toContain("Warm community landing");
  });
});
