import { describe, expect, it } from "vitest";
import { RequirementsExtractionOutput, SectionDraftOutput } from "@deedwell/schemas";
import { MockModelProvider } from "./mock-provider.js";

const provider = new MockModelProvider();

describe("MockModelProvider — requirements extraction", () => {
  it("separates mandatory from advisory and captures source lines + word limits", async () => {
    const doc = [
      "Some Grant Program",
      "Applicants must be a registered nonprofit.",
      "Applicants should include letters of support.",
      "The narrative must not exceed 500 words.",
    ].join("\n");
    const res = await provider.complete({
      system: "s", task: "t",
      dataBlocks: [{ label: "document", content: doc }],
      outputSchemaRef: "requirements_extraction",
    });
    const out = RequirementsExtractionOutput.parse(JSON.parse(res.text));
    const mandatory = out.requirements.filter((r) => r.mandatory);
    const advisory = out.requirements.filter((r) => !r.mandatory);
    expect(mandatory.length).toBe(2);
    expect(advisory.length).toBe(1);
    expect(mandatory[0]!.sourceLocation.line).toBe(2);
    expect(out.requirements.find((r) => r.wordLimit === 500)).toBeTruthy();
  });

  it("emits an explicit no-requirements marker instead of inventing content", async () => {
    const res = await provider.complete({
      system: "s", task: "t",
      dataBlocks: [{ label: "document", content: "A poem about rivers.\nNothing else here." }],
      outputSchemaRef: "requirements_extraction",
    });
    const out = RequirementsExtractionOutput.parse(JSON.parse(res.text));
    expect(out.requirements[0]!.text).toContain("NO REQUIREMENTS DETECTED");
  });
});

describe("MockModelProvider — section drafting", () => {
  it("always includes at least one flagged unsupported claim for the harness to catch", async () => {
    const res = await provider.complete({
      system: "s",
      task: 'Draft a grant proposal section titled "Statement of Need".',
      dataBlocks: [
        { label: "requirements", content: "[]" },
        {
          label: "org_facts",
          content: JSON.stringify([{ key: "mission", value: "Serve youth", status: "user_certified" }]),
        },
      ],
      outputSchemaRef: "section_draft",
    });
    const out = SectionDraftOutput.parse(JSON.parse(res.text));
    expect(out.title).toBe("Statement of Need");
    expect(out.claims.some((c) => c.support === "unsupported" && c.flagged)).toBe(true);
    expect(out.wordCount).toBeGreaterThan(0);
  });
});

describe("createModelProvider factory", () => {
  it("selects mock, openai, and gemini by kind; rejects unknown kinds", async () => {
    const { createModelProvider } = await import("./index.js");
    expect(createModelProvider("mock").name).toBe("mock");
    expect(() => createModelProvider("openai")).toThrow(/OPENAI_API_KEY/);
    expect(() => createModelProvider("gemini")).toThrow(/GCP_PROJECT/);
    expect(() => createModelProvider("bogus")).toThrow(/not implemented/);
  });
});

describe("GeminiProvider", () => {
  it("requires GCP_PROJECT unless a service-account key supplies project_id", async () => {
    const { GeminiProvider } = await import("./gemini-provider.js");
    expect(() => new GeminiProvider()).toThrow(/GCP_PROJECT/);
    expect(() => new GeminiProvider({ project: "some-project" })).not.toThrow();
  });
});
