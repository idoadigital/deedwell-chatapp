import type { SitePage } from "@deedwell/schemas";
import { pageUrl, type RenderedFile } from "./renderer.js";

/**
 * Deterministic SEO & accessibility review of a built release (the reviewer
 * "agent" is rules code — model output never certifies its own quality).
 */

export interface SiteCheck {
  name: string;
  page: string | null;
  pass: boolean;
  detail: string;
  /** blocking failures prevent the publish gate; advisory ones become warnings. */
  severity: "blocking" | "advisory";
}

/** Blocking check failures — a release with any of these must not reach the
 *  publish approval (spec §8: a broken site cannot be marked complete). */
export function blockingFailures(checks: SiteCheck[]): SiteCheck[] {
  return checks.filter((c) => !c.pass && c.severity === "blocking");
}

export function runSiteChecks(files: RenderedFile[], pages: SitePage[]): SiteCheck[] {
  const checks: SiteCheck[] = [];
  const validUrls = new Set([...pages.map((p) => pageUrl(p.slug)), "/thanks/"]);
  const htmlFiles = files.filter((f) => f.contentType.startsWith("text/html"));

  // Route completeness: every page in the approved set must have a rendered
  // file — a site where only the homepage exists must never pass (spec §8).
  const filePaths = new Set(files.map((f) => f.path));
  for (const p of pages) {
    const expected = p.slug === "home" ? "index.html" : `${p.slug}/index.html`;
    checks.push({
      name: "Page route rendered",
      page: pageUrl(p.slug),
      pass: filePaths.has(expected),
      detail: filePaths.has(expected) ? "Rendered" : `Missing file ${expected} for page "${p.title}"`,
      severity: "blocking",
    });
  }
  const slugCounts = new Map<string, number>();
  for (const p of pages) slugCounts.set(p.slug, (slugCounts.get(p.slug) ?? 0) + 1);
  const dupSlugs = [...slugCounts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  checks.push({
    name: "Page slugs unique",
    page: null,
    pass: dupSlugs.length === 0,
    detail: dupSlugs.length ? `Duplicate slugs overwrite each other: ${dupSlugs.join(", ")}` : "All slugs unique",
    severity: "blocking",
  });
  checks.push({
    name: "Custom 404 page present",
    page: null,
    pass: filePaths.has("404.html"),
    detail: "Missing files must show the site's own 404 page",
    severity: "blocking",
  });
  checks.push({
    name: "Form thank-you page present",
    page: null,
    pass: filePaths.has("thanks/index.html"),
    detail: "Form submissions redirect to /thanks/",
    severity: pages.some((p) => p.blocks.some((b) => b.kind === "form" || b.kind === "contact")) ? "blocking" : "advisory",
  });
  checks.push({
    name: "robots.txt present",
    page: null,
    pass: filePaths.has("robots.txt"),
    detail: "Crawler policy file",
    severity: "advisory",
  });

  for (const file of htmlFiles) {
    const page = file.path.replace(/index\.html$/, "") || "/";
    const html = file.content;

    checks.push({
      name: "Title tag present",
      page,
      pass: /<title>[^<]{3,}<\/title>/.test(html),
      detail: "Every page needs a descriptive <title>",
      severity: "advisory",
    });
    checks.push({
      name: "Meta description present",
      page,
      pass: /<meta name="description" content="[^"]{3,}"/.test(html),
      detail: "Search engines and previews use the description",
      severity: "advisory",
    });
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    checks.push({
      name: "Exactly one h1",
      page,
      pass: h1Count === 1,
      detail: h1Count === 1 ? "OK" : `${h1Count} h1 elements found`,
      severity: "advisory",
    });
    checks.push({
      name: "Language attribute set",
      page,
      pass: /<html lang="/.test(html),
      detail: "Screen readers need the document language",
      severity: "advisory",
    });

    const inputs = [...html.matchAll(/<(?:input|textarea)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
    const labels = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!));
    const unlabeled = inputs.filter((id) => !labels.has(id));
    checks.push({
      name: "Form inputs labeled",
      page,
      pass: unlabeled.length === 0,
      detail: unlabeled.length ? `Unlabeled inputs: ${unlabeled.join(", ")}` : "All inputs have labels",
      severity: "blocking",
    });

    const internalLinks = [...html.matchAll(/href="(\/[^"]*)"/g)]
      .map((m) => m[1]!)
      .filter((href) => !href.startsWith("/forms/") && href !== "/#main" && !href.startsWith("/#"));
    const broken = internalLinks.filter((href) => !validUrls.has(href));
    checks.push({
      name: "Internal links resolve",
      page,
      pass: broken.length === 0,
      detail: broken.length ? `Broken: ${broken.join(", ")}` : "All internal links resolve",
      severity: "blocking",
    });

    // Navigation must reach every page — orphan pages fail (spec §8).
    // Utility pages (/thanks/) intentionally have no nav.
    if (file.path.endsWith("index.html") && validUrls.has(page) && page !== "/thanks/") {
      // Header and footer navs together must reach every page: the header
      // keeps to a few primary links, the footer lists them all.
      const navHtml = [...html.matchAll(/<nav[\s\S]*?<\/nav>/g)].map((m) => m[0]).join("\n");
      const navMissing = pages
        .map((p) => pageUrl(p.slug))
        .filter((url) => !navHtml.includes(`href="${url}"`));
      checks.push({
        name: "Navigation links every page",
        page,
        pass: navMissing.length === 0,
        detail: navMissing.length ? `Nav missing: ${navMissing.join(", ")}` : "All pages reachable from nav",
        severity: "blocking",
      });
    }

    // Forms must post to this site's own form endpoint.
    const formActions = [...html.matchAll(/<form[^>]*\baction="([^"]*)"/g)].map((m) => m[1]!);
    const badActions = formActions.filter((a) => !/\/forms\/[a-z0-9-]+\/[a-z0-9-]+$/.test(a));
    if (formActions.length) {
      checks.push({
        name: "Form actions valid",
        page,
        pass: badActions.length === 0,
        detail: badActions.length ? `Invalid form action(s): ${badActions.join(", ")}` : "All forms post to the site's endpoint",
        severity: "blocking",
      });
    }

    // Basic image accessibility: every <img> needs a non-empty src and alt.
    const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    const badImgs = imgs.filter((tag) => !/\bsrc="[^"]+"/.test(tag) || !/\balt="/.test(tag));
    if (imgs.length) {
      checks.push({
        name: "Images have src and alt",
        page,
        pass: badImgs.length === 0,
        detail: badImgs.length ? `${badImgs.length} image(s) missing src or alt` : "All images have src and alt",
        severity: "blocking",
      });
    }

    checks.push({
      name: "No script tags (static template policy)",
      page,
      pass: !/<script/i.test(html),
      detail: "Approved templates ship zero JavaScript",
      severity: "blocking",
    });
  }

  const placeholderPages = pages.filter((p) =>
    JSON.stringify(p.blocks).includes("[Placeholder:")
  );
  checks.push({
    name: "No placeholder content remaining",
    page: null,
    pass: placeholderPages.length === 0,
    detail: placeholderPages.length
      ? `Placeholders on: ${placeholderPages.map((p) => p.slug).join(", ")} — fill missing facts before publishing`
      : "No placeholders",
    severity: "blocking",
  });
  checks.push({
    name: "Sitemap generated",
    page: null,
    pass: files.some((f) => f.path === "sitemap.xml"),
    detail: "sitemap.xml is part of the release",
    severity: "advisory",
  });
  return checks;
}
