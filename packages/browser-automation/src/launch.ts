import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright";

/**
 * How every Google-facing browser is launched. Google's sign-in refuses a
 * browser that announces itself as automated ("Couldn't sign you in — this
 * browser or app may not be secure"): the legacy headless shell's
 * "HeadlessChrome" user agent, navigator.webdriver = true, and the
 * AutomationControlled blink feature are each enough to trip it. So:
 *
 *   - run the full Chromium build in its new headless mode (channel
 *     "chromium"), which is the real browser without a window rather than
 *     the stripped-down headless shell;
 *   - turn off the AutomationControlled blink feature, which is what sets
 *     navigator.webdriver;
 *   - present an ordinary Chrome user agent, locale and timezone.
 *
 * Nothing here changes what the person types or what Google sees them do;
 * it only stops the browser itself from looking like a bot to a login page
 * a human is actually operating.
 */
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-dev-shm-usage",
];

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, channel: "chromium", args: LAUNCH_ARGS });
  } catch {
    // The full Chromium build is missing (only the headless shell installed):
    // fall back rather than fail, with the same flags.
    return chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
}

/** A context that looks like a person's Chrome: real UA (never
 *  "HeadlessChrome"), en-US, a US timezone, and the automation flag unset. */
export async function newHumanContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const version = browser.version().split(".")[0] ?? "128";
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
    ...options,
  });
  // A string, not a function: this package compiles without DOM typings.
  await context.addInitScript(`
    // navigator.webdriver is the first thing bot checks read.
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
    // A real Chrome always has window.chrome.
    if (!window.chrome) window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true });
  `);
  return context;
}
