import { describe, expect, it } from "vitest";
import { renderEmail } from "./layout.js";
import { EMAIL_KINDS, renderTemplate } from "./templates.js";
import { SAMPLES } from "./samples.js";

const cfg = { appOrigin: "https://deedwell.org", coworkersOrigin: "https://coworkers.deedwell.org", logoUrl: "https://deedwell.org/assets/logo-black.png", supportEmail: "hello@deedwell.org" };

describe("email templates", () => {
  it.each(EMAIL_KINDS)("renders %s on brand", (kind) => {
    const doc = renderTemplate(kind, SAMPLES[kind] as never, cfg);
    expect(doc.subject.length).toBeGreaterThan(3);
    expect(doc.heading.length).toBeGreaterThan(3);
    const { html, text } = renderEmail(doc, cfg);
    expect(html).toContain(cfg.logoUrl);
    expect(html).toContain('alt="Deedwell"');
    expect(html).toContain("#94b0d2"); // brand surface
    expect(html).toContain("hello@deedwell.org");
    expect(html).toContain("/privacy");
    expect(text).toContain(doc.heading);
    if (doc.cta) { expect(html).toContain(doc.cta.url); expect(text).toContain(doc.cta.url); }
  });

  it("escapes user-supplied content", () => {
    const { html } = renderEmail(renderTemplate("support_received", SAMPLES.support_received, cfg), cfg);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("only activity emails carry an unsubscribe link", () => {
    const withUnsub = renderEmail({ ...renderTemplate("unread_digest", SAMPLES.unread_digest, cfg), unsubscribeUrl: "https://x/unsub" }, cfg);
    expect(withUnsub.html).toContain("Unsubscribe from activity emails");
    const receipt = renderEmail(renderTemplate("topup_receipt", SAMPLES.topup_receipt, cfg), cfg);
    expect(receipt.html).not.toContain("Unsubscribe");
    expect(receipt.html).toContain("$40.00");
    expect(receipt.html).toContain("5,000,000 tokens");
  });
});
