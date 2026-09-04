import { describe, expect, it } from "vitest";
import type { SitePage } from "@deedwell/schemas";
import { findPlaceholders, stripPlaceholderBlocks } from "./placeholders.js";

const page: SitePage = {
  slug: "impact", title: "Impact", seoDescription: "What changes",
  blocks: [
    { kind: "text", heading: "Real work", body: "Mentoring pairs meet weekly." },
    { kind: "stats", items: [{ label: "Youth served", value: "[Placeholder: Youth Served Count]" }] },
    { kind: "quote", quote: "TBD", attribution: null, role: null },
  ],
};

describe("placeholders", () => {
  it("finds markers wherever they hide in a page", () => {
    expect(findPlaceholders(page)).toEqual(["[Placeholder: Youth Served Count]", "TBD"]);
  });

  it("removes only the blocks that carry markers", () => {
    const { page: clean, removed } = stripPlaceholderBlocks(page, { title: "Impact" });
    expect(removed).toBe(2);
    expect(clean.blocks).toHaveLength(1);
    expect(findPlaceholders(clean)).toEqual([]);
  });

  it("never leaves a page empty", () => {
    const allBad: SitePage = { ...page, blocks: [page.blocks[1]!] };
    const { page: clean } = stripPlaceholderBlocks(allBad, { title: "Financial Transparency", purpose: "Where the money goes." });
    expect(clean.blocks).toEqual([{ kind: "text", heading: "Financial Transparency", body: "Where the money goes." }]);
  });

  it("leaves ordinary prose alone", () => {
    const fine: SitePage = { ...page, blocks: [page.blocks[0]!] };
    expect(findPlaceholders(fine)).toEqual([]);
  });
});
