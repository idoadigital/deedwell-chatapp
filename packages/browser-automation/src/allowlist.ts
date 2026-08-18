/**
 * Hostnames this package is permitted to navigate to. Defense in depth on
 * top of the fact that every flow here is hand-written and deterministic
 * (never an LLM choosing a URL) — mirrors browser-research's isBlockedUrl
 * SSRF guard in spirit, but as an allowlist rather than a blocklist, since
 * this package's whole job is acting inside one specific vendor's product.
 */
const ALLOWED_HOSTS = [
  "accounts.google.com",
  "www.google.com",
  "google.com",
  "ads.google.com",
  "myaccount.google.com",
  "www.techsoup.org",
  "techsoup.org",
];

export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

export function assertAllowedUrl(url: string): void {
  if (!isAllowedUrl(url)) {
    throw new Error(`Refusing to navigate outside the Google/TechSoup allowlist: ${url}`);
  }
}
