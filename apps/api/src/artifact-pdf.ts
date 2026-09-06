import PDFDocument from "pdfkit";

/**
 * Any artifact as a PDF. The workflows write structured content (a grant
 * section with its claims, a compliance matrix, a website brief, an export
 * package's markdown…); this turns each shape into a short document model —
 * headings, paragraphs, bullets, rows — and lays it out with pdfkit, pure JS
 * like the existing full-application export. Unknown shapes are rendered as a
 * labelled tree rather than refused, so every document in Artifacts has a PDF.
 */
export interface ArtifactPdfInput {
  title: string;
  type: string;
  orgName: string;
  createdAt?: string | Date | null;
  version?: number | null;
  content: unknown;
}

type Block =
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "li"; text: string; ordered?: boolean; n?: number }
  | { kind: "quote"; text: string }
  | { kind: "note"; text: string }
  | { kind: "row"; cells: string[]; head?: boolean }
  | { kind: "rule" };

const TYPE_LABEL: Record<string, string> = {
  grant_section: "Grant section",
  compliance_matrix: "Compliance matrix",
  export_package: "Export package",
  website_brief: "Website brief",
  budget: "Budget",
  logic_model: "Logic model",
  compliance_report: "Compliance report",
  review_report: "Review report",
  application_plan: "Application plan",
  email: "Email",
};

export function artifactTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** A deliberately small Markdown subset — the same one the dashboard reads. */
export function markdownBlocks(text: string): Block[] {
  const out: Block[] = [];
  let n = 0;
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: "p", text: para.join(" ") }); para = []; } };
  for (const raw of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); n = 0; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { flush(); const level = heading[1]!.length; out.push({ kind: level <= 1 ? "h1" : level === 2 ? "h2" : "h3", text: heading[2]! }); continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push({ kind: "rule" }); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flush(); out.push({ kind: "quote", text: quote[1]! }); continue; }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) { flush(); out.push({ kind: "li", text: bullet[1]! }); continue; }
    if (numbered) { flush(); out.push({ kind: "li", text: numbered[1]!, ordered: true, n: ++n }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const label = (k: string) => k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Last resort: the real structure, labelled, never a JSON dump. */
function structured(value: unknown, depth: number): Block[] {
  if (value === null || value === undefined) return [{ kind: "p", text: "—" }];
  if (typeof value === "string") return value.includes("\n") ? markdownBlocks(value) : [{ kind: "p", text: value }];
  if (typeof value === "number" || typeof value === "boolean") return [{ kind: "p", text: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) }];
  if (Array.isArray(value)) {
    if (!value.length) return [{ kind: "p", text: "None" }];
    return value.flatMap((v, i) => {
      if (v && typeof v === "object") return [{ kind: "h3", text: `${i + 1}.` } as Block, ...structured(v, depth + 1)];
      return [{ kind: "li", text: str(v) } as Block];
    });
  }
  const out: Block[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) continue;
    if (v && typeof v === "object") {
      out.push({ kind: depth === 0 ? "h2" : "h3", text: label(k) });
      out.push(...structured(v, depth + 1));
    } else if (typeof v === "string" && v.includes("\n")) {
      out.push({ kind: depth === 0 ? "h2" : "h3", text: label(k) });
      out.push(...markdownBlocks(v));
    } else {
      out.push({ kind: "p", text: `${label(k)}: ${typeof v === "boolean" ? (v ? "Yes" : "No") : str(v)}` });
    }
  }
  return out;
}

export function artifactBlocks(type: string, content: unknown): Block[] {
  if (content === null || content === undefined) return [{ kind: "note", text: "This version has no stored content." }];
  if (typeof content !== "object") return structured(content, 0);
  const c = content as Record<string, any>;
  switch (type) {
    case "grant_section": {
      const out: Block[] = markdownBlocks(str(c.body));
      const claims = list(c.claims) as Array<Record<string, any>>;
      if (claims.length) {
        out.push({ kind: "h2", text: `Claims this section makes (${claims.length})` });
        for (const claim of claims) {
          const tail = [claim.support ? `[${claim.support}]` : "", claim.factKey ? `backed by ${claim.factKey}` : "", claim.source ?? ""].filter(Boolean).join(" · ");
          out.push({ kind: "li", text: `${str(claim.text ?? claim.claim ?? "Claim")}${tail ? ` — ${tail}` : ""}` });
        }
      }
      if (typeof c.wordCount === "number") out.push({ kind: "note", text: `${c.wordCount} words` });
      return out;
    }
    case "compliance_matrix": {
      const out: Block[] = c.documentSummary ? markdownBlocks(str(c.documentSummary)) : [];
      const reqs = list(c.requirements) as Array<Record<string, any>>;
      out.push({ kind: "h2", text: `Requirements (${reqs.length})` });
      if (!reqs.length) out.push({ kind: "note", text: "No requirements were extracted." });
      reqs.forEach((r, i) => {
        const tags = [r.kind ? str(r.kind).replace(/_/g, " ") : "", r.mandatory === undefined ? "" : r.mandatory ? "mandatory" : "optional", r.sourceLocation?.line ? `line ${r.sourceLocation.line}` : ""].filter(Boolean).join(" · ");
        out.push({ kind: "li", text: `${str(r.text ?? r.title ?? r.requirement ?? `Requirement ${i + 1}`)}${tags ? ` (${tags})` : ""}`, ordered: true, n: i + 1 });
        if (r.note) out.push({ kind: "quote", text: str(r.note) });
      });
      return out;
    }
    case "export_package":
      return typeof c.markdown === "string" ? markdownBlocks(c.markdown) : [{ kind: "note", text: "This package has no written content — only its stored files." }];
    case "website_brief": {
      const out: Block[] = [];
      if (list(c.objectives).length) { out.push({ kind: "h2", text: "Objectives" }); for (const o of list(c.objectives)) out.push({ kind: "li", text: str(o) }); }
      if (list(c.audiences).length) { out.push({ kind: "h2", text: "Audiences" }); out.push({ kind: "p", text: list(c.audiences).map(str).join(", ") }); }
      if (c.tone) { out.push({ kind: "h2", text: "Tone" }); out.push(...markdownBlocks(str(c.tone))); }
      const sitemap = list(c.sitemap) as Array<Record<string, any> | string>;
      if (sitemap.length) {
        out.push({ kind: "h2", text: `Sitemap (${sitemap.length} pages)` });
        sitemap.forEach((p, i) => out.push({ kind: "li", text: typeof p === "string" ? p : `${str(p.title)}${p.purpose ? ` — ${str(p.purpose)}` : ""}`, ordered: true, n: i + 1 }));
      }
      if (c.theme && typeof c.theme === "object") {
        out.push({ kind: "h2", text: "Look" });
        out.push({ kind: "p", text: [c.theme.palette ? `${c.theme.palette} palette` : "", c.theme.headingFont ? `${c.theme.headingFont} headings` : ""].filter(Boolean).join(" · ") || "—" });
      }
      return out.length ? out : structured(c, 0);
    }
    case "budget": {
      const items = list(c.items) as Array<Record<string, any>>;
      const out: Block[] = [{ kind: "row", cells: ["Category", "Description", "Activity", "Qty", "Unit cost", "Amount"], head: true }];
      for (const it of items) out.push({ kind: "row", cells: [str(it.category), str(it.description), str(it.activity), str(it.quantity), money(it.unitCost), money(it.amount ?? Number(it.quantity) * Number(it.unitCost))] });
      const total = items.reduce((s, it) => s + (Number(it.amount ?? Number(it.quantity) * Number(it.unitCost)) || 0), 0);
      out.push({ kind: "p", text: `Total: ${money(total)}` });
      if (c.narrative) { out.push({ kind: "h2", text: "Budget narrative" }); out.push(...markdownBlocks(str(c.narrative))); }
      return out;
    }
    case "logic_model": {
      const out: Block[] = [];
      for (const key of ["problem", "inputs", "activities", "outputs", "outcomes", "impact"]) {
        if (c[key] === undefined) continue;
        out.push({ kind: "h2", text: label(key) });
        if (Array.isArray(c[key])) for (const v of c[key]) out.push({ kind: "li", text: str(v) });
        else out.push(...markdownBlocks(str(c[key])));
      }
      const ind = list(c.indicators) as Array<Record<string, any>>;
      if (ind.length) {
        out.push({ kind: "h2", text: "Indicators" });
        out.push({ kind: "row", cells: ["Outcome", "Indicator", "Baseline", "Target", "Source", "Frequency"], head: true });
        for (const i of ind) out.push({ kind: "row", cells: [str(i.outcome), str(i.indicator), str(i.baseline), str(i.target), str(i.source), str(i.frequency)] });
      }
      return out;
    }
    case "compliance_report": {
      const checks = list(c.checks) as Array<Record<string, any>>;
      const out: Block[] = checks.map((ch) => ({ kind: "li", text: `${ch.pass ? "[x]" : "[ ]"} ${str(ch.name)}${ch.detail ? ` — ${str(ch.detail)}` : ""}` }));
      const rest = { ...c }; delete rest.checks;
      return [...out, ...(Object.keys(rest).length ? structured(rest, 0) : [])];
    }
    default:
      return structured(c, 0);
  }
}

const money = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : str(v); };

/** Inline **bold** and `code` markers become font switches; the rest are dropped. */
function writeInline(doc: PDFKit.PDFDocument, text: string, size: number, opts: PDFKit.Mixins.TextOptions = {}): void {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part.startsWith("**")) doc.font("Helvetica-Bold").fontSize(size).text(part.slice(2, -2), { ...opts, continued: !last });
    else if (part.startsWith("`")) doc.font("Courier").fontSize(size).text(part.slice(1, -1), { ...opts, continued: !last });
    else doc.font("Helvetica").fontSize(size).text(part.replace(/(\*|__|_)(?=\S)([^*_]+?)(?<=\S)\1/g, "$2"), { ...opts, continued: !last });
  });
  if (!parts.length) doc.text("", opts);
}

export function renderArtifactPdf(input: ArtifactPdfInput): Promise<Buffer> {
  const blocks = artifactBlocks(input.type, input.content);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, bufferPages: true, info: { Title: input.title, Author: input.orgName, Creator: "Deedwell" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).font("Helvetica-Bold").text(input.title);
    const when = input.createdAt ? new Date(input.createdAt) : null;
    doc.moveDown(0.2).fontSize(9.5).font("Helvetica").fillColor("#555").text(
      [input.orgName, artifactTypeLabel(input.type), input.version ? `v${input.version}` : "", when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : ""].filter(Boolean).join(" · ")
    ).fillColor("#000");
    doc.moveDown(0.8);

    for (const b of blocks) {
      switch (b.kind) {
        case "h1": doc.moveDown(0.8).font("Helvetica-Bold").fontSize(16).text(b.text).moveDown(0.3); break;
        case "h2": doc.moveDown(0.6).font("Helvetica-Bold").fontSize(13).text(b.text).moveDown(0.2); break;
        case "h3": doc.moveDown(0.4).font("Helvetica-Bold").fontSize(11).text(b.text).moveDown(0.15); break;
        case "p": writeInline(doc, b.text, 10.5, { align: "left" }); doc.moveDown(0.45); break;
        case "li": doc.font("Helvetica").fontSize(10.5).text(b.ordered ? `${b.n}.` : "•", { continued: true, indent: 10 }); writeInline(doc, ` ${b.text}`, 10.5); doc.moveDown(0.15); break;
        case "quote": doc.font("Helvetica-Oblique").fontSize(10).fillColor("#444").text(b.text, { indent: 18 }).fillColor("#000").moveDown(0.3); break;
        case "note": doc.font("Helvetica-Oblique").fontSize(9.5).fillColor("#666").text(b.text).fillColor("#000").moveDown(0.3); break;
        case "row": doc.font(b.head ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(b.cells.join("   |   ")); break;
        case "rule": doc.moveDown(0.3).moveTo(doc.x, doc.y).lineTo(doc.page.width - 54, doc.y).strokeColor("#bbb").stroke().strokeColor("#000").moveDown(0.5); break;
      }
    }
    doc.end();
  });
}
