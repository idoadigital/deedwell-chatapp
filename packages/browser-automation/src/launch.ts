import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright";

/**
 * How every Google-facing browser is launched. Google's sign-in refuses a
 * browser that looks automated ("Couldn't sign you in — this browser or app
 * may not be secure"). Headless mode is the strongest tell it has — even
 * the new headless mode with the automation flags scrubbed — so the
 * preferred path is a real, windowed Google Chrome drawn onto a virtual X
 * display (Xvfb) that nobody looks at: to Google it is an ordinary Chrome
 * with a screen. The order tried:
 *
 *   1. headful Google Chrome (channel "chrome") on Xvfb,
 *   2. headful Chromium on Xvfb,
 *   3. new-headless Chromium (channel "chromium"),
 *   4. the default headless shell.
 *
 * GOOGLE_BROWSER_MODE=headless skips the Xvfb path (tests, laptops without
 * X). Nothing here changes what the person types or what Google sees them
 * do; it only stops the browser itself from looking like a bot.
 */
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-dev-shm-usage",
  "--window-size=1280,800",
  "--window-position=0,0",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
];

const DISPLAY = process.env.GOOGLE_BROWSER_DISPLAY ?? ":99";
let xvfb: ChildProcess | null = null;
let xvfbReady: Promise<boolean> | null = null;

/** Starts Xvfb once per process (idempotent), resolves false when it is not
 *  installed or fails to come up. Tied to the process: it dies with us. */
async function ensureDisplay(): Promise<boolean> {
  if (process.env.GOOGLE_BROWSER_MODE === "headless") return false;
  if (process.env.DISPLAY) return true;
  if (xvfbReady) return xvfbReady;
  xvfbReady = new Promise<boolean>((resolve) => {
    const bin = ["/usr/bin/Xvfb", "/usr/local/bin/Xvfb"].find((p) => existsSync(p));
    if (!bin) return resolve(false);
    try {
      xvfb = spawn(bin, [DISPLAY, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], { stdio: "ignore" });
    } catch { return resolve(false); }
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    xvfb.once("error", () => done(false));
    xvfb.once("exit", () => { xvfb = null; done(false); });
    // Xvfb has no readiness signal; a short grace period is the norm.
    setTimeout(() => { if (xvfb && xvfb.exitCode === null) { process.env.DISPLAY = DISPLAY; done(true); } }, 700);
  });
  return xvfbReady;
}

export async function launchBrowser(): Promise<Browser> {
  const attempts: Array<() => Promise<Browser>> = [];
  if (await ensureDisplay()) {
    attempts.push(() => chromium.launch({ headless: false, channel: "chrome", args: LAUNCH_ARGS, ignoreDefaultArgs: ["--enable-automation"] }));
    attempts.push(() => chromium.launch({ headless: false, channel: "chromium", args: LAUNCH_ARGS, ignoreDefaultArgs: ["--enable-automation"] }));
  }
  attempts.push(() => chromium.launch({ headless: true, channel: "chromium", args: LAUNCH_ARGS, ignoreDefaultArgs: ["--enable-automation"] }));
  attempts.push(() => chromium.launch({ headless: true, args: LAUNCH_ARGS }));
  let lastError: unknown;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (err) { lastError = err; }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not launch a browser");
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

/** For tests and diagnostics: which launch path is in use. */
export function browserDisplayInfo(): { display: string | null; xvfbRunning: boolean } {
  return { display: process.env.DISPLAY ?? null, xvfbRunning: Boolean(xvfb && xvfb.exitCode === null) };
}
