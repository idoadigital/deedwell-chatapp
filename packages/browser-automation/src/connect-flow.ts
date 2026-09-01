import { chromium, type BrowserContext } from "playwright";
import { isGoogleAuthenticated } from "./session.js";
import { dispatchInput, startScreencast, type RelayInputEvent } from "./live-relay.js";

const NONPROFITS_URL = "https://www.google.com/nonprofits/";
// Presence of either indicates an authenticated Google session. Checking
// cookies (rather than navigating to a check page) is what makes the poll
// non-disruptive — the user may still be mid-interaction on whatever page
// Google's own login flow currently has them on.
const AUTH_COOKIE_NAMES = new Set(["SID", "__Secure-1PSID", "__Secure-3PSID"]);
const POLL_INTERVAL_MS = 2000;

async function hasGoogleAuthCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some((c) => c.domain.includes("google.com") && AUTH_COOKIE_NAMES.has(c.name));
}

export interface ConnectFlowHandlers {
  onFrame(dataBase64: string): void;
  onReady(): void;
  onError(message: string): void;
  onConnected(result: { storageState: unknown }): void;
}

export interface ConnectFlowHandle {
  submitInput(evt: RelayInputEvent): void;
  close(): Promise<void>;
}

/**
 * Drives the entire "connect your Google account" live session — launch,
 * screencast, input relay, non-disruptive auth-cookie polling, one
 * confirming navigation, storageState capture — behind a callback API with
 * no Playwright types in its surface. This is the only thing apps/api ever
 * imports for the connect flow, so a real headless browser and Chromium
 * process management stay fully inside this package.
 */
export async function startGoogleConnectFlow(handlers: ConnectFlowHandlers): Promise<ConnectFlowHandle> {
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopScreencast: (() => Promise<void>) | undefined;
  const browser = await chromium.launch({ headless: true });

  const close = async () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (stopScreencast) await stopScreencast().catch(() => {});
    await browser.close().catch(() => {});
  };

  try {
    // Fixed viewport matching the screencast's max dimensions — the client
    // scales its display to this same size, so pointer coordinates it sends
    // back map onto the real page without any per-client negotiation.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    stopScreencast = await startScreencast(page, (frame) => handlers.onFrame(frame.data));
    await page
      .goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch((err) => handlers.onError(`Could not load Google sign-in: ${String(err)}`));

    handlers.onReady();

    pollTimer = setInterval(() => {
      void (async () => {
        if (closed) return;
        const hasCookie = await hasGoogleAuthCookie(context).catch(() => false);
        if (!hasCookie) return;
        // One confirming navigation, done only after the auth cookie
        // already appeared — by this point the user's own interaction
        // with the login page is effectively finished.
        const confirmed = await isGoogleAuthenticated(page, NONPROFITS_URL).catch(() => false);
        if (!confirmed) return;
        const storageState = await context.storageState();
        handlers.onConnected({ storageState });
        await close();
      })();
    }, POLL_INTERVAL_MS);

    return {
      submitInput: (evt) => {
        if (!closed) void dispatchInput(page, evt).catch(() => {});
      },
      close,
    };
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : "Connect session failed");
    await close();
    return { submitInput: () => {}, close };
  }
}
