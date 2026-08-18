import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";

export class SessionExpiredError extends Error {
  constructor() {
    super("Google session is no longer authenticated — a reconnect is required");
    this.name = "SessionExpiredError";
  }
}

/**
 * Launches a headless Chromium context seeded from a previously-captured
 * storageState, runs `fn`, and always tears the context/browser down —
 * decrypted session material never touches disk and never outlives the
 * call. Every caller must check authentication itself (isGoogleAuthenticated
 * below) before doing anything else: a redirect to accounts.google.com
 * means the session expired, and that must surface as an honest pause, not
 * a guess.
 */
export async function withGoogleSession<T>(
  storageState: unknown,
  fn: (ctx: { page: Page; context: BrowserContext; browser: Browser }) => Promise<T>
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: storageState as BrowserContextOptions["storageState"],
    });
    try {
      const page = await context.newPage();
      return await fn({ page, context, browser });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/** Google's own logged-out state redirects to accounts.google.com for
 *  virtually every product surface — checking the landed URL after loading
 *  a known-authenticated page is the one reliable, product-agnostic signal. */
export async function isGoogleAuthenticated(page: Page, checkUrl: string): Promise<boolean> {
  await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return !page.url().includes("accounts.google.com/");
}
