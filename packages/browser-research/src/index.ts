/**
 * Browser-backed research (workspace spec §4): really fetch the pages an
 * opportunity links to, capture title/text/links/access time, and report
 * failures honestly. Uses Playwright's Chromium when available and falls back
 * to plain fetch — the record says which. Never fabricates content.
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  links: string[];
  accessedAt: string;
  via: "browser" | "fetch";
  status: "retrieved" | "failed" | "blocked";
  error?: string;
}

export interface ResearchFetcher {
  fetchPage(url: string): Promise<FetchedPage>;
  close(): Promise<void>;
}

const PAGE_TIMEOUT_MS = 20_000;
const MAX_TEXT = 20_000;

/** SSRF guard: only public http(s) targets; loopback, RFC1918, link-local and
 *  metadata hosts are refused before any request is made. */
export function isBlockedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `refusing ${url.protocol} URL`;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "internal hostname";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) ||
        (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) {
      return "private or loopback address";
    }
  }
  if (host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) {
    return "private IPv6 address";
  }
  return null;
}

function stripHtml(html: string): { title: string; text: string; links: string[] } {
  const title = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? "";
  const links = [...html.matchAll(/href="(https?:\/\/[^"#]+)"/g)].map((m) => m[1]!).slice(0, 100);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return { title, text, links };
}

type Browser = import("playwright").Browser;

export function createBrowserResearch(mode: "browser" | "fetch" = "browser"): ResearchFetcher {
  let browserPromise: Promise<Browser | null> | null = null;

  const getBrowser = async (): Promise<Browser | null> => {
    if (mode === "fetch") return null;
    if (!browserPromise) {
      browserPromise = import("playwright")
        .then((pw) => pw.chromium.launch({ headless: true }))
        .catch(() => null); // no browser installed → plain fetch, recorded as such
    }
    return browserPromise;
  };

  const viaBrowser = async (browser: Browser, url: string): Promise<FetchedPage> => {
    const accessedAt = new Date().toISOString();
    const context = await browser.newContext({ userAgent: "DeedwellResearch/1.0 (+nonprofit grant research)" });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      if (!response || response.status() >= 400) {
        return {
          url, finalUrl: page.url(), title: "", text: "", links: [], accessedAt,
          via: "browser", status: "failed",
          error: `HTTP ${response?.status() ?? "no response"}`,
        };
      }
      const title = (await page.title()).slice(0, 300);
      // String-form evaluate: runs in the page, keeps this package free of DOM lib types.
      const text = (await page.evaluate<string>("document.body ? document.body.innerText : ''"))
        .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      const links = (await page.evaluate<string[]>(
        `Array.from(document.querySelectorAll("a[href^='http']"), (a) => a.href)`
      )).slice(0, 100);
      return { url, finalUrl: page.url(), title, text, links, accessedAt, via: "browser", status: "retrieved" };
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  const viaFetch = async (url: string): Promise<FetchedPage> => {
    const accessedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "DeedwellResearch/1.0 (+nonprofit grant research)" },
      });
      if (!res.ok) {
        return { url, finalUrl: res.url, title: "", text: "", links: [], accessedAt, via: "fetch", status: "failed", error: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const { title, text, links } = stripHtml(html);
      return { url, finalUrl: res.url, title, text, links, accessedAt, via: "fetch", status: "retrieved" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async fetchPage(url: string): Promise<FetchedPage> {
      const blocked = isBlockedUrl(url);
      if (blocked) {
        return {
          url, finalUrl: url, title: "", text: "", links: [],
          accessedAt: new Date().toISOString(), via: "fetch", status: "blocked", error: blocked,
        };
      }
      try {
        const browser = await getBrowser();
        if (browser) return await viaBrowser(browser, url);
        return await viaFetch(url);
      } catch (err) {
        return {
          url, finalUrl: url, title: "", text: "", links: [],
          accessedAt: new Date().toISOString(),
          via: mode === "fetch" ? "fetch" : "browser", status: "failed",
          error: err instanceof Error ? err.message.slice(0, 300) : "fetch failed",
        };
      }
    },
    async close(): Promise<void> {
      const browser = await browserPromise;
      await browser?.close().catch(() => undefined);
    },
  };
}
