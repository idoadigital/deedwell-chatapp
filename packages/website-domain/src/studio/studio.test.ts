import { describe, expect, it } from "vitest";
import { cleanDeclarations, cleanSelector, injectOverrides, mergeOverride, overridesCss } from "./overrides.js";
import { instructionsFor } from "./domains.js";

describe("overrides layer", () => {
  it("keeps allowed properties with safe values and drops the rest", () => {
    expect(cleanDeclarations({ "font-size": "30px", color: "#123", background: "url(http://x)", "--evil": "1", width: "calc(100% - 8px)" }))
      .toEqual({ "font-size": "30px", color: "#123", width: "calc(100% - 8px)" });
  });
  it("accepts child combinators in selectors but nothing that closes a rule", () => {
    expect(cleanSelector("footer ul > li:nth-of-type(2) > a")).toBe("footer ul > li:nth-of-type(2) > a");
    expect(cleanSelector("#s0-h")).toBe("#s0-h");
    expect(cleanSelector("a{}")).toBeNull();
    expect(cleanSelector("a; body")).toBeNull();
    expect(cleanSelector("<script>")).toBeNull();
  });
  it("scopes rules to the page and viewport, later rules last", () => {
    const css = overridesCss([
      { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px" } },
      { page: "*", selector: "main img", viewport: "all", declarations: { "max-width": "100%" } },
      { page: "about", selector: "h1", viewport: "all", declarations: { color: "red" } },
    ], "home");
    expect(css).toBe("@media (max-width: 639px){#s0-h{font-size:30px !important}}\nmain img{max-width:100% !important}");
    const html = injectOverrides("<html><head><title>x</title></head><body></body></html>", css);
    expect(html).toContain('<style id="site-overrides">');
    expect(injectOverrides(html, "")).not.toContain("site-overrides");
  });
  it("merges an override for the same target property by property", () => {
    const a = mergeOverride([], { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "33px" } });
    const b = mergeOverride(a, { page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px", "line-height": "1.1" } });
    expect(b).toEqual([{ page: "home", selector: "#s0-h", viewport: "mobile", declarations: { "font-size": "30px", "line-height": "1.1" }, note: undefined }]);
  });
});

describe("custom domain instructions", () => {
  it("gives zone-relative hosts for a subdomain", () => {
    const rows = instructionsFor("www.example.org", "deedwell-site-verification=abc");
    expect(rows.map((r) => [r.type, r.host])).toEqual([["TXT", "_deedwell.www"], ["CNAME", "www"]]);
    expect(rows[0]!.value).toBe("deedwell-site-verification=abc");
  });
  it("uses A records at the apex", () => {
    const rows = instructionsFor("example.org", "t");
    expect(rows.map((r) => [r.type, r.host])).toEqual([["TXT", "_deedwell"], ["A", "@"]]);
  });
});
