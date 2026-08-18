import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { BidDimension, ExtractedRequirement, SectionClaim } from "@deedwell/schemas";
import type { FullExportInput } from "./export-full.js";

/**
 * Real DOCX generation — the structured database stays the source of truth;
 * this is a rendering of it, sharing the same FullExportInput the markdown
 * export uses so content never drifts between formats.
 */

function headingCell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] });
}
function cell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph(text)] });
}
function table(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map(headingCell) }),
      ...rows.map((r) => new TableRow({ children: r.map(cell) })),
    ],
  });
}

export async function renderFullExportDocx(input: FullExportInput): Promise<Buffer> {
  const byType = (type: string) => input.artifacts.filter((a) => a.type === type);
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({ text: input.opportunity.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      text: `Funder: ${input.opportunity.funder}` +
        (input.opportunity.number ? ` · Opportunity ${input.opportunity.number}` : ""),
    }),
    new Paragraph({ text: input.opportunity.deadline ? `Deadline: ${input.opportunity.deadline}` : "Deadline: not on record" }),
    new Paragraph({
      children: [new TextRun({
        text: "Deedwell helps prepare stronger, more compliant applications. It does not and cannot guarantee a grant award.",
        italics: true,
      })],
    })
  );

  if (input.eligibility) {
    children.push(
      new Paragraph({ text: "Eligibility", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Engine result: ${input.eligibility.overall.replace(/_/g, " ")}` })
    );
  }

  if (input.bid) {
    children.push(
      new Paragraph({ text: "Bid decision", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Score ${input.bid.total}/100 — recommendation: ${input.bid.recommendation.replace(/_/g, " ")}` }),
      new Paragraph({ text: input.bid.rationale }),
      table(
        ["Dimension", "Score", "Note"],
        input.bid.dimensions.map((d: BidDimension) => [d.label, `${d.score}/5`, d.note])
      )
    );
  }

  for (const matrix of byType("compliance_matrix")) {
    const requirements = (matrix.content.requirements ?? []) as ExtractedRequirement[];
    children.push(
      new Paragraph({ text: "Compliance matrix", heading: HeadingLevel.HEADING_1 }),
      table(
        ["#", "Must", "Kind", "Requirement", "Source"],
        requirements.map((r, i) => [String(i + 1), r.mandatory ? "Yes" : "—", r.kind, r.text.slice(0, 200), `Line ${r.sourceLocation.line}`])
      )
    );
  }

  for (const section of byType("grant_section")) {
    const claims = (section.content.claims ?? []) as SectionClaim[];
    const flagged = claims.filter((c) => c.flagged);
    children.push(
      new Paragraph({ text: String(section.title), heading: HeadingLevel.HEADING_1 }),
      ...String(section.content.body ?? "").split(/\n{2,}/).map((p) => new Paragraph(p)),
      new Paragraph({ children: [new TextRun({ text: `${Number(section.content.wordCount ?? 0)} words`, italics: true })] })
    );
    if (flagged.length) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${flagged.length} claim(s) in this section lack verified evidence:`, bold: true })],
      }));
      for (const claim of flagged) children.push(new Paragraph({ text: `[${claim.support}] ${claim.text}`, bullet: { level: 0 } }));
    }
  }

  for (const budget of byType("budget")) {
    const items = (budget.content.items ?? []) as Array<{
      category: string; description: string; activity: string; quantity: number; unitCost: number; amount: number;
    }>;
    children.push(
      new Paragraph({ text: "Budget", heading: HeadingLevel.HEADING_1 }),
      table(
        ["Category", "Description", "Activity", "Qty", "Unit cost", "Amount"],
        items.map((it) => [it.category, it.description, it.activity, String(it.quantity), `$${it.unitCost.toLocaleString()}`, `$${it.amount.toLocaleString()}`])
      ),
      new Paragraph({
        children: [new TextRun({ text: `Total: $${(input.budgetTotal ?? 0).toLocaleString()}`, bold: true })],
        alignment: AlignmentType.RIGHT,
      }),
      new Paragraph({ text: "Budget narrative", heading: HeadingLevel.HEADING_2 }),
      new Paragraph(String(budget.content.narrative ?? ""))
    );
  }

  for (const lm of byType("logic_model")) {
    const c = lm.content as {
      problem?: string; inputs?: string[]; activities?: string[]; outputs?: string[]; outcomes?: string[]; impact?: string;
      indicators?: Array<{ outcome: string; indicator: string; baseline: string; target: string; source: string; frequency: string }>;
    };
    children.push(
      new Paragraph({ text: "Logic model", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun({ text: `Problem: ${c.problem ?? ""}`, bold: true })] }),
      new Paragraph({ text: `Inputs: ${(c.inputs ?? []).join("; ")}` }),
      new Paragraph({ text: `Activities: ${(c.activities ?? []).join("; ")}` }),
      new Paragraph({ text: `Outputs: ${(c.outputs ?? []).join("; ")}` }),
      new Paragraph({ text: `Outcomes: ${(c.outcomes ?? []).join("; ")}` }),
      new Paragraph({ text: `Impact: ${c.impact ?? ""}` }),
      table(
        ["Outcome", "Indicator", "Baseline", "Target", "Source", "Frequency"],
        (c.indicators ?? []).map((i) => [i.outcome, i.indicator, i.baseline, i.target, i.source, i.frequency])
      )
    );
  }

  for (const report of byType("compliance_report")) {
    const checks = (report.content.checks ?? []) as Array<{ name: string; pass: boolean; detail: string }>;
    children.push(
      new Paragraph({ text: "Final compliance checklist", heading: HeadingLevel.HEADING_1 }),
      ...checks.map((c) => new Paragraph({ text: `${c.pass ? "✓" : "✗"} ${c.name} — ${c.detail}` }))
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
