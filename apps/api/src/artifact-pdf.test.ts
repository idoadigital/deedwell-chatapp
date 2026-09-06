import { describe, expect, it } from "vitest";
import { artifactBlocks, markdownBlocks, renderArtifactPdf } from "./artifact-pdf.js";

describe("artifact PDF", () => {
  it("parses the markdown subset the dashboard reads", () => {
    const blocks = markdownBlocks("# Title\n\nA paragraph\nthat wraps.\n\n- one\n- two\n\n1. first\n2. second\n\n> aside\n\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "p", "li", "li", "li", "li", "quote", "rule"]);
    expect(blocks[1]).toMatchObject({ text: "A paragraph that wraps." });
    expect(blocks[5]).toMatchObject({ ordered: true, n: 2 });
  });

  it("turns a grant section into prose plus its claims", () => {
    const blocks = artifactBlocks("grant_section", { body: "## Need\n\nWe serve 400 families.", claims: [{ text: "400 families", support: "verified", factKey: "families_served" }], wordCount: 5 });
    expect(blocks.some((b) => b.kind === "h2" && b.text.startsWith("Claims"))).toBe(true);
    expect(blocks.some((b) => b.kind === "li" && b.text.includes("families_served"))).toBe(true);
    expect(blocks.at(-1)).toMatchObject({ kind: "note", text: "5 words" });
  });

  it("renders unknown shapes as a labelled tree, never a JSON dump", () => {
    const blocks = artifactBlocks("review_report", { overall_score: 82, reviews: [{ reviewer: "program", strengths: "Clear need" }] });
    expect(blocks[0]).toMatchObject({ kind: "p", text: "Overall score: 82" });
    expect(blocks.some((b) => b.kind === "h2" && b.text === "Reviews")).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain("{\"reviewer\"");
  });

  it("produces a PDF for every artifact type", async () => {
    for (const [type, content] of [
      ["grant_section", { body: "Hello **world**", claims: [] }],
      ["compliance_matrix", { documentSummary: "Summary", requirements: [{ text: "Submit by Friday", kind: "deadline", mandatory: true }] }],
      ["export_package", { markdown: "# Application\n\nBody" }],
      ["website_brief", { objectives: ["Raise funds"], audiences: ["Donors"], tone: "Warm", sitemap: [{ title: "Home", purpose: "Welcome" }] }],
      ["budget", { items: [{ category: "personnel", description: "Lead", activity: "Run", quantity: 1, unitCost: 5000, amount: 5000 }], narrative: "One person." }],
      ["logic_model", { problem: "Gap", inputs: ["Staff"], indicators: [{ outcome: "A", indicator: "B", baseline: "0", target: "1", source: "S", frequency: "Q" }] }],
      ["mystery", { anything: "goes", nested: { deep: true } }],
      ["empty", null],
    ] as const) {
      const pdf = await renderArtifactPdf({ title: `Test ${type}`, type, orgName: "Org", content });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(800);
    }
  });
});
