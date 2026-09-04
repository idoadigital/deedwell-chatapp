import type { Screenshot } from "./critic.js";

/**
 * Optional visual QA: render the page in headless Chromium at three widths.
 * Playwright ships in the API image for browser automation; when it is not
 * available (tests, a slim image) this returns no screenshots and the critic
 * works from the markup alone.
 */
export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
];

export async function screenshotPage(html: string, opts: { enabled?: boolean } = {}): Promise<Screenshot[]> {
  const enabled = opts.enabled ?? (process.env.VISUAL_QA ?? "off") === "screenshots";
  if (!enabled) return [];
  // Resolved by name at runtime so this package does not depend on playwright.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any = null;
  try {
    const name = "playwright";
    playwright = await import(name);
  } catch {
    return [];
  }
  if (!playwright?.chromium) return [];
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const out: Screenshot[] = [];
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
      // Images and fonts are inline or absent; nothing external is fetched.
      await page.route("**/*", (route: { request: () => { url: () => string }; continue: () => void; abort: () => void }) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
      await page.setContent(html.replace(/<script>[\s\S]*?<\/script>/, ""), { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: "[data-reveal],[data-reveal='stagger']>*{opacity:1!important;transform:none!important}" });
      const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 70 });
      out.push({ width: vp.width, height: vp.height, mime: "image/jpeg", base64: buf.toString("base64") });
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}
