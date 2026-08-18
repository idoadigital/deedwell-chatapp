import PDFDocument from "pdfkit";
import type { BidDimension, ExtractedRequirement, SectionClaim } from "@deedwell/schemas";
import type { FullExportInput } from "./export-full.js";

/** Real PDF generation — same FullExportInput as the markdown/DOCX exports,
 *  pure-JS text layout (no headless browser) so the container stays light. */
export function renderFullExportPdf(input: FullExportInput): Promise<Buffer> {
  const byType = (type: string) => input.artifacts.filter((a) => a.type === type);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const h1 = (text: string) => doc.moveDown(1).fontSize(16).font("Helvetica-Bold").text(text).moveDown(0.3);
    const h2 = (text: string) => doc.moveDown(0.5).fontSize(13).font("Helvetica-Bold").text(text).moveDown(0.2);
    const body = (text: string) => doc.fontSize(10.5).font("Helvetica").text(text, { align: "left" });
    const italic = (text: string) => doc.fontSize(9.5).font("Helvetica-Oblique").text(text);
    const row = (cells: string[], bold = false) => {
      doc.fontSize(9).font(bold ? "Helvetica-Bold" : "Helvetica").text(cells.join("   |   "));
    };

    doc.fontSize(20).font("Helvetica-Bold").text(input.opportunity.title);
    doc.fontSize(10).font("Helvetica").text(
      `Funder: ${input.opportunity.funder}` + (input.opportunity.number ? ` · Opportunity ${input.opportunity.number}` : "")
    );
    doc.text(input.opportunity.deadline ? `Deadline: ${input.opportunity.deadline}` : "Deadline: not on record");
    doc.moveDown(0.5);
    italic("Deedwell helps prepare stronger, more compliant applications. It does not and cannot guarantee a grant award.");

    if (input.eligibility) {
      h1("Eligibility");
      body(`Engine result: ${input.eligibility.overall.replace(/_/g, " ")}`);
    }

    if (input.bid) {
      h1("Bid decision");
      body(`Score ${input.bid.total}/100 — recommendation: ${input.bid.recommendation.replace(/_/g, " ")}`);
      body(input.bid.rationale);
      doc.moveDown(0.3);
      row(["Dimension", "Score", "Note"], true);
      for (const d of input.bid.dimensions as BidDimension[]) row([d.label, `${d.score}/5`, d.note]);
    }

    for (const matrix of byType("compliance_matrix")) {
      const requirements = (matrix.content.requirements ?? []) as ExtractedRequirement[];
      h1("Compliance matrix");
      row(["#", "Must", "Kind", "Requirement", "Source"], true);
      requirements.forEach((r, i) =>
        row([String(i + 1), r.mandatory ? "Yes" : "—", r.kind, r.text.slice(0, 100), `L${r.sourceLocation.line}`])
      );
    }

    for (const section of byType("grant_section")) {
      const claims = (section.content.claims ?? []) as SectionClaim[];
      const flagged = claims.filter((c) => c.flagged);
      h1(String(section.title));
      body(String(section.content.body ?? ""));
      italic(`${Number(section.content.wordCount ?? 0)} words`);
      if (flagged.length) {
        doc.moveDown(0.2).fontSize(9.5).font("Helvetica-Bold").text(`${flagged.length} claim(s) lack verified evidence:`);
        for (const claim of flagged) doc.fontSize(9).font("Helvetica").text(`• [${claim.support}] ${claim.text}`);
      }
    }

    for (const budget of byType("budget")) {
      const items = (budget.content.items ?? []) as Array<{
        category: string; description: string; activity: string; quantity: number; unitCost: number; amount: number;
      }>;
      h1("Budget");
      row(["Category", "Description", "Activity", "Qty", "Unit cost", "Amount"], true);
      for (const it of items) {
        row([it.category, it.description, it.activity, String(it.quantity), `$${it.unitCost.toLocaleString()}`, `$${it.amount.toLocaleString()}`]);
      }
      doc.moveDown(0.2).fontSize(11).font("Helvetica-Bold").text(`Total: $${(input.budgetTotal ?? 0).toLocaleString()}`, { align: "right" });
      h2("Budget narrative");
      body(String(budget.content.narrative ?? ""));
    }

    for (const lm of byType("logic_model")) {
      const c = lm.content as {
        problem?: string; inputs?: string[]; activities?: string[]; outputs?: string[]; outcomes?: string[]; impact?: string;
        indicators?: Array<{ outcome: string; indicator: string; baseline: string; target: string; source: string; frequency: string }>;
      };
      h1("Logic model");
      body(`Problem: ${c.problem ?? ""}`);
      body(`Inputs: ${(c.inputs ?? []).join("; ")}`);
      body(`Activities: ${(c.activities ?? []).join("; ")}`);
      body(`Outputs: ${(c.outputs ?? []).join("; ")}`);
      body(`Outcomes: ${(c.outcomes ?? []).join("; ")}`);
      body(`Impact: ${c.impact ?? ""}`);
      doc.moveDown(0.2);
      row(["Outcome", "Indicator", "Baseline", "Target", "Source", "Frequency"], true);
      for (const i of c.indicators ?? []) row([i.outcome, i.indicator, i.baseline, i.target, i.source, i.frequency]);
    }

    for (const report of byType("compliance_report")) {
      const checks = (report.content.checks ?? []) as Array<{ name: string; pass: boolean; detail: string }>;
      h1("Final compliance checklist");
      for (const c of checks) body(`${c.pass ? "[x]" : "[ ]"} ${c.name} — ${c.detail}`);
    }

    doc.end();
  });
}
