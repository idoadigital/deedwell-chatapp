/**
 * The one email layout every transactional message renders through. Brand
 * tokens mirror deedwell-v2/src/styles.css: cream page, white card, Georgia
 * headings, the light-blue brand as a *surface* with dark ink on it (the
 * blues fail contrast as text on white), --brand-ink for links.
 *
 * Table-based, inline-styled markup on purpose — Gmail, Outlook and Apple
 * Mail each strip a different subset of <style>, and a 600px single column
 * survives all of them.
 */
import type { EmailConfig } from "./config.js";

export const BRAND = {
  cream: "#faf9f5",
  white: "#ffffff",
  ink: "#101d25",
  muted: "#53616b",
  line: "#dfe3de",
  brand: "#94b0d2",
  brandOn: "#1a1a1a",
  brandInk: "#3f5c7e",
  brandTint: "#dce8f4",
  ok: "#2f7a4a",
  okSoft: "#e6f2ea",
  warn: "#92601c",
  warnSoft: "#fbf1db",
  danger: "#a33b12",
  dangerSoft: "#f8ece6",
} as const;

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type Block =
  | { type: "p"; text: string }
  | { type: "html"; html: string; text: string }
  | { type: "kv"; rows: [string, string][] }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string; by?: string }
  | { type: "code"; text: string; label?: string }
  | { type: "callout"; text: string; tone?: "info" | "ok" | "warn" | "danger" };

export interface Cta { label: string; url: string }

export interface EmailDoc {
  subject: string;
  /** First line in inbox previews; hidden in the body. */
  preheader?: string;
  /** Small caps label above the heading, e.g. "Billing", "Your website". */
  eyebrow?: string;
  heading: string;
  blocks: Block[];
  cta?: Cta;
  secondaryCta?: Cta;
  /** Small print under the button. */
  footnote?: string;
  /** Present on activity emails: renders the one-click opt-out link. */
  unsubscribeUrl?: string | null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escapes text but keeps `**bold**` and bare https links clickable. */
function rich(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(https?:\/\/[^\s<]+[^\s<.,;:)])/g, (m) => `<a href="${m}" style="color:${BRAND.brandInk};text-decoration:underline;">${m}</a>`);
  return out.replace(/\n/g, "<br>");
}

function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function button(cta: Cta, primary: boolean): string {
  const bg = primary ? BRAND.brand : BRAND.white;
  const color = primary ? BRAND.brandOn : BRAND.brandInk;
  const border = primary ? BRAND.brand : BRAND.line;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 12px;"><tr><td style="border-radius:8px;background:${bg};border:1px solid ${border};">
<a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:${color};text-decoration:none;border-radius:8px;">${escapeHtml(cta.label)}</a>
</td></tr></table>`;
}

function renderBlock(b: Block): string {
  const p = (inner: string, extra = "") =>
    `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.55;color:${BRAND.ink};${extra}">${inner}</p>`;
  switch (b.type) {
    case "p": return p(rich(b.text));
    case "html": return b.html;
    case "kv":
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;border:1px solid ${BRAND.line};border-radius:8px;border-collapse:separate;">
${b.rows.map(([k, v], i) => `<tr><td style="padding:10px 14px;font-family:${SANS};font-size:14px;color:${BRAND.muted};width:38%;${i ? `border-top:1px solid ${BRAND.line};` : ""}">${escapeHtml(k)}</td><td style="padding:10px 14px;font-family:${SANS};font-size:14px;color:${BRAND.ink};font-weight:600;${i ? `border-top:1px solid ${BRAND.line};` : ""}">${rich(v)}</td></tr>`).join("\n")}
</table>`;
    case "list":
      return `<ul style="margin:0 0 16px;padding:0 0 0 22px;">${b.items.map((it) => `<li style="margin:0 0 6px;font-family:${SANS};font-size:16px;line-height:1.5;color:${BRAND.ink};">${rich(it)}</li>`).join("")}</ul>`;
    case "quote":
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td style="padding:14px 18px;background:${BRAND.cream};border-left:4px solid ${BRAND.brand};border-radius:0 8px 8px 0;font-family:${SANS};font-size:15px;line-height:1.55;color:${BRAND.ink};">${rich(b.text)}${b.by ? `<div style="margin-top:8px;font-size:13px;color:${BRAND.muted};">— ${escapeHtml(b.by)}</div>` : ""}</td></tr></table>`;
    case "code":
      return `${b.label ? `<div style="font-family:${SANS};font-size:13px;color:${BRAND.muted};margin:0 0 6px;">${escapeHtml(b.label)}</div>` : ""}<div style="margin:0 0 18px;padding:14px 18px;background:${BRAND.cream};border:1px dashed ${BRAND.brandInk};border-radius:8px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:18px;letter-spacing:1px;color:${BRAND.ink};">${escapeHtml(b.text)}</div>`;
    case "callout": {
      const tone = b.tone ?? "info";
      const [bg, fg] = tone === "ok" ? [BRAND.okSoft, BRAND.ok] : tone === "warn" ? [BRAND.warnSoft, BRAND.warn] : tone === "danger" ? [BRAND.dangerSoft, BRAND.danger] : [BRAND.brandTint, BRAND.brandInk];
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td style="padding:12px 16px;background:${bg};border-radius:8px;font-family:${SANS};font-size:15px;line-height:1.5;color:${fg};">${rich(b.text)}</td></tr></table>`;
    }
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case "p": return plain(b.text);
    case "html": return b.text;
    case "kv": return b.rows.map(([k, v]) => `${k}: ${plain(v)}`).join("\n");
    case "list": return b.items.map((it) => `• ${plain(it)}`).join("\n");
    case "quote": return `> ${plain(b.text)}${b.by ? `\n— ${b.by}` : ""}`;
    case "code": return `${b.label ? `${b.label}\n` : ""}${b.text}`;
    case "callout": return plain(b.text);
  }
}

export function renderEmail(doc: EmailDoc, cfg: Pick<EmailConfig, "appOrigin" | "logoUrl" | "supportEmail">): { html: string; text: string } {
  const year = new Date().getFullYear();
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(doc.subject)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
${doc.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${escapeHtml(doc.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>` : ""}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${BRAND.cream};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px;">
<tr><td style="padding:0 8px 20px;"><a href="${escapeHtml(cfg.appOrigin)}" style="text-decoration:none;"><img src="${escapeHtml(cfg.logoUrl)}" width="150" height="50" alt="Deedwell" style="display:block;width:150px;height:auto;border:0;"></a></td></tr>
<tr><td style="background:${BRAND.white};border:1px solid ${BRAND.line};border-radius:14px;padding:36px 36px 28px;">
${doc.eyebrow ? `<div style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND.brandInk};margin:0 0 10px;">${escapeHtml(doc.eyebrow)}</div>` : ""}
<h1 style="margin:0 0 18px;font-family:${SERIF};font-weight:400;font-size:28px;line-height:1.25;color:${BRAND.ink};">${escapeHtml(doc.heading)}</h1>
${doc.blocks.map(renderBlock).join("\n")}
${doc.cta ? `<div style="padding-top:6px;">${button(doc.cta, true)}${doc.secondaryCta ? button(doc.secondaryCta, false) : ""}</div>` : ""}
${doc.footnote ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.muted};">${rich(doc.footnote)}</p>` : ""}
</td></tr>
<tr><td style="padding:24px 8px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${BRAND.muted};">
<div><strong style="color:${BRAND.ink};">Deedwell</strong> — More impact. Less cost.</div>
<div>Atlanta, Georgia, United States · <a href="mailto:${escapeHtml(cfg.supportEmail)}" style="color:${BRAND.brandInk};">${escapeHtml(cfg.supportEmail)}</a></div>
<div style="margin-top:6px;"><a href="${escapeHtml(cfg.appOrigin)}/dashboard" style="color:${BRAND.brandInk};">Dashboard</a> · <a href="${escapeHtml(cfg.appOrigin)}/privacy" style="color:${BRAND.brandInk};">Privacy</a> · <a href="${escapeHtml(cfg.appOrigin)}/terms" style="color:${BRAND.brandInk};">Terms</a>${doc.unsubscribeUrl ? ` · <a href="${escapeHtml(doc.unsubscribeUrl)}" style="color:${BRAND.brandInk};">Unsubscribe from activity emails</a>` : ""}</div>
<div style="margin-top:6px;">© ${year} Deedwell. All rights reserved.</div>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const textLines = [
    doc.eyebrow ? doc.eyebrow.toUpperCase() : null,
    doc.heading,
    "",
    ...doc.blocks.map(blockText),
    doc.cta ? `\n${doc.cta.label}: ${doc.cta.url}` : null,
    doc.secondaryCta ? `${doc.secondaryCta.label}: ${doc.secondaryCta.url}` : null,
    doc.footnote ? `\n${plain(doc.footnote)}` : null,
    "",
    "—",
    "Deedwell — More impact. Less cost.",
    `Atlanta, Georgia, United States · ${cfg.supportEmail}`,
    `${cfg.appOrigin}/privacy · ${cfg.appOrigin}/terms`,
    doc.unsubscribeUrl ? `Unsubscribe from activity emails: ${doc.unsubscribeUrl}` : null,
  ].filter((l): l is string => l !== null);
  return { html, text: textLines.join("\n") };
}
