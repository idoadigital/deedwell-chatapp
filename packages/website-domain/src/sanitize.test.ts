import { describe, expect, it } from "vitest";
import { extractSharedDesign, looksLikeAPage, sanitizeCss, sanitizePage } from "./sanitize.js";

const page = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;

describe("sanitizePage", () => {
  it("removes scripts, handlers, embeds and javascript: links but keeps structure and styles", () => {
    const { html, warnings } = sanitizePage(page(
      `<header><nav><a href="/about/">About</a></nav></header><main id="main"><h1 onclick="x()">Hi</h1>
       <script>alert(1)</script><iframe src="https://evil"></iframe><link rel="stylesheet" href="https://x/y.css">
       <a href="javascript:alert(1)">bad</a><a href="https://example.org" target="_blank">ok</a>
       <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#123"/></svg></main>`,
      `<style>body{color:red;background:url(https://evil/x.png)}@import url(x.css);</style>`
    ), { slug: "site" });
    expect(html).not.toMatch(/<script|<iframe|<link|onclick|javascript:/i);
    expect(html).toContain("<style>body{color:red;background:none}</style>");
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer">');
    expect(html).toContain('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#123"');
    expect(html).toContain('<a href="/about/">About</a>');
    expect(warnings).toEqual(expect.arrayContaining(["script removed", "inline event handler removed", "@import removed"]));
  });

  it("forces every form onto the site's own endpoint with the honeypot", () => {
    const { html } = sanitizePage(page(
      `<main><h1>x</h1><form action="https://evil.example/collect" method="get"><label for="e">Email</label><input id="e" name="email" type="email"></form>
       <form action="/forms/site/volunteer"><input name="n" type="file"></form></main>`
    ), { slug: "site" });
    const actions = [...html.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual(["/forms/site/contact", "/forms/site/volunteer"]);
    expect((html.match(/name="website"/g) ?? []).length).toBe(2);
    expect(html).toContain('type="text"'); // file inputs are not accepted
  });

  it("drops images that are not inline data and fills in document scaffolding", () => {
    const { html, warnings } = sanitizePage(
      `<html><head><title>T</title></head><body><main><h1>x</h1><img src="https://cdn/x.jpg" alt="a"><img src="data:image/svg+xml;base64,AAAA" alt="b"></main></body></html>`,
      { slug: "s" }
    );
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(warnings).toContain("image without an allowed src removed");
  });
});

describe("sanitizeCss", () => {
  it("keeps data URIs and fragment references", () => {
    const { css, warnings } = sanitizeCss(`.a{background:url("data:image/svg+xml,%3Csvg%3E")}.b{fill:url(#grad)}`);
    expect(css).toContain("data:image/svg+xml");
    expect(css).toContain("url(#grad)");
    expect(warnings).toEqual([]);
  });
});

describe("shared design", () => {
  it("extracts the stylesheet, header and footer for later pages", () => {
    const shared = extractSharedDesign(page(`<header><nav>n</nav></header><main><h1>x</h1></main><footer>f</footer>`, `<style>.x{}</style>`));
    expect(shared).toEqual({ styles: ".x{}", header: "<header><nav>n</nav></header>", footer: "<footer>f</footer>" });
  });

  it("recognises a real page and rejects a stub", () => {
    const full = page(`<header><nav>n</nav></header><main><h1>x</h1>${"<p>text</p>".repeat(120)}</main>`, `<style>.x{}</style>`);
    expect(looksLikeAPage(full)).toBe(true);
    expect(looksLikeAPage("<html><body><p>hi</p></body></html>")).toBe(false);
  });
});
