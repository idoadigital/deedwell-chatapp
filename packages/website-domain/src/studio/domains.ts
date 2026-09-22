import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";

/**
 * Custom domains, on the hosting Deedwell actually runs.
 *
 *   Generated sites are served by the `deedwell-sites` Cloud Run service.
 *   A customer's hostname reaches it through a Cloud Run domain mapping,
 *   whose DNS target is ghs.googlehosted.com (or Google's four anycast A
 *   records at an apex). Google only issues that mapping — and its
 *   certificate — for a domain the calling Google identity has verified, so
 *   the customer's records are:
 *
 *     TXT   @      google-site-verification=…   (Google's own ownership proof,
 *                                               requested per domain from the
 *                                               Site Verification API)
 *     CNAME www    ghs.googlehosted.com          (or four A records at an apex)
 *
 *   Once both resolve, the API verifies the domain with Google, creates the
 *   mapping on the sites service, and watches it until the certificate is
 *   live. No step is manual. The pure helpers here (records, DNS
 *   observation, status) know nothing about Google's APIs; the API layer
 *   provides the token and the mapping state.
 *
 *   The TXT sits on the registrable root (example.org) even when the site
 *   is on www: Google's verification of a root covers its subdomains, and a
 *   TXT cannot share a name with the www CNAME anyway.
 */

export const DNS_TARGET = process.env.SITES_CNAME_TARGET ?? "ghs.googlehosted.com";
export const GOOGLE_A = ["216.239.32.21", "216.239.34.21", "216.239.36.21", "216.239.38.21"];
const GOOGLE_A_SET = new Set(GOOGLE_A);

/** Kept for rows created before Google tokens existed; no longer shown. */
export function newVerificationToken(): string {
  return `deedwell-site-verification=${randomBytes(12).toString("hex")}`;
}

/* Public suffixes with a second label (co.uk, org.au, …). Not the full
 * list — the common nonprofit ones. Anything else is treated as TLD-only. */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "org.au", "net.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "org.nz", "net.nz", "ac.nz", "school.nz", "govt.nz",
  "co.za", "org.za", "net.za", "web.za", "ac.za",
  "com.br", "org.br", "net.br", "gov.br", "edu.br",
  "co.in", "org.in", "net.in", "ac.in", "edu.in", "gov.in",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.mx", "org.mx", "net.mx", "edu.mx", "gob.mx",
  "co.ke", "or.ke", "ac.ke", "com.ng", "org.ng", "com.gh", "org.gh", "co.ug", "or.ug", "co.tz", "or.tz",
  "com.sg", "org.sg", "edu.sg", "com.hk", "org.hk", "com.ph", "org.ph", "com.my", "org.my",
  "com.ar", "org.ar", "com.co", "org.co", "com.pe", "org.pe", "com.cl", "org.cl", "org.il", "co.il", "ac.il",
  "com.tr", "org.tr", "com.pk", "org.pk", "com.bd", "org.bd", "com.np", "org.np",
]);

/** example.org for www.example.org; example.co.uk for donate.example.co.uk. */
export function registrableDomain(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  const keep = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export function isApex(domain: string): boolean {
  return registrableDomain(domain) === domain.toLowerCase().replace(/\.$/, "");
}

export interface DnsInstruction {
  type: "CNAME" | "TXT" | "A";
  host: string;
  value: string;
  /** The record's full name, for providers that ask for it. */
  name: string;
  note: string;
  /** Set by the API from the last observation. */
  found?: boolean;
}

/**
 * The records the customer adds. `googleToken` is the value from Google's
 * Site Verification API (google-site-verification=…); until the API has
 * fetched it the TXT row carries a placeholder and `found` stays false.
 */
export function instructionsFor(domain: string, googleToken: string | null): DnsInstruction[] {
  const root = registrableDomain(domain);
  const apex = isApex(domain);
  // Hosts are relative to the zone, the way DNS providers ask for them:
  // "www" for www.example.org, "@" for the apex.
  const host = apex ? "@" : domain.slice(0, -(root.length + 1));
  const out: DnsInstruction[] = [
    {
      type: "TXT", host: "@", name: root, value: googleToken ?? "(preparing — check again in a moment)",
      note: `Lets Google confirm you own ${root} so it can issue the certificate. Keep it in place.`,
    },
  ];
  if (apex) {
    for (const ip of GOOGLE_A) out.push({ type: "A", host: "@", name: root, value: ip, note: "Apex domains cannot use a CNAME; all four Google addresses are needed. DNS only (not proxied)." });
  } else {
    out.push({ type: "CNAME", host, name: domain, value: DNS_TARGET, note: "Points the hostname at Deedwell's hosting. DNS only (not proxied) so the certificate can be issued." });
  }
  return out;
}

export interface DnsObservation {
  txt: string[];
  cname: string | null;
  a: string[];
  /** Google's TXT is present at the root. */
  verified: boolean;
  /** The hostname points at Google's front end. */
  pointed: boolean;
  /** Which of the A records are present (apex). */
  aFound: string[];
  error: string | null;
}

/** Looks the records up with real DNS queries. Resolver errors are reported, not hidden. */
export async function observeDns(domain: string, googleToken: string | null): Promise<DnsObservation> {
  const root = registrableDomain(domain);
  const apex = isApex(domain);
  const obs: DnsObservation = { txt: [], cname: null, a: [], verified: false, pointed: false, aFound: [], error: null };
  try { obs.txt = (await dns.resolveTxt(root)).map((r) => r.join("")); } catch (err) {
    const code = (err as { code?: string }).code ?? "lookup failed";
    obs.error = code === "ENODATA" ? null : `TXT ${root}: ${code}`;
  }
  obs.verified = Boolean(googleToken) && obs.txt.includes(googleToken as string);
  try { const c = await dns.resolveCname(domain); obs.cname = c[0] ?? null; } catch { obs.cname = null; }
  if (!obs.cname) { try { obs.a = await dns.resolve4(domain); } catch { obs.a = []; } }
  obs.aFound = obs.a.filter((ip) => GOOGLE_A_SET.has(ip));
  obs.pointed = apex
    ? obs.aFound.length === GOOGLE_A.length
    : (obs.cname ?? "").replace(/\.$/, "").toLowerCase() === DNS_TARGET.toLowerCase() || obs.aFound.length === GOOGLE_A.length;
  return obs;
}

/** Whether the hostname already serves over HTTPS from the mapping. */
export async function probeHttps(domain: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://${domain}/`, { method: "HEAD", redirect: "manual", signal: controller.signal });
    clearTimeout(t);
    return { ok: res.status < 500, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: null, error: String((err as Error).message ?? err).slice(0, 120) };
  }
}

export type DomainStatus = "pending_dns" | "verifying" | "ssl_provisioning" | "connected" | "error";

/** What Google reports about the mapping, as the API stores it in dns.mapping. */
export interface MappingState {
  created: boolean;
  ready: boolean;
  certificate: boolean;
  message: string | null;
  checkedAt: string;
}

/**
 * The next status from what was observed:
 *   pending_dns      nothing (or only one record) resolves yet
 *   verifying        records resolve; waiting for Google to confirm ownership
 *   ssl_provisioning ownership confirmed and the mapping exists; certificate pending
 *   connected        the mapping is ready or the hostname answers over HTTPS
 */
export function nextStatus(
  obs: DnsObservation,
  https: { ok: boolean } | null,
  ownership: boolean,
  mapping: MappingState | null,
): DomainStatus {
  if (https?.ok || mapping?.ready) return "connected";
  if (mapping?.created) return "ssl_provisioning";
  if (obs.verified && obs.pointed) return ownership ? "ssl_provisioning" : "verifying";
  return "pending_dns";
}

/** One line for the customer about what is still missing. */
export function progressCopy(domain: string, obs: DnsObservation, ownership: boolean, mapping: MappingState | null, googleToken: string | null): string {
  const apex = isApex(domain);
  if (!googleToken) return "Preparing your DNS records — this takes a moment.";
  if (mapping?.ready) return "Connected and serving over HTTPS.";
  if (mapping?.created) return "Ownership confirmed and hosting set up. Google is issuing the certificate — usually 15 minutes, occasionally up to a few hours.";
  if (obs.verified && obs.pointed) return ownership ? "Records found and ownership confirmed. Setting up hosting…" : "Both records found. Confirming ownership with Google…";
  const missing: string[] = [];
  if (!obs.verified) missing.push(`the TXT record on ${registrableDomain(domain)}`);
  if (!obs.pointed) missing.push(apex ? (obs.aFound.length ? `${GOOGLE_A.length - obs.aFound.length} of the four A records` : "the four A records") : `the CNAME on ${domain}`);
  const seen = obs.cname ? `Currently ${domain} points to ${obs.cname}.` : obs.a.length && !obs.aFound.length ? `Currently ${domain} points to ${obs.a.slice(0, 2).join(", ")}.` : "";
  return `Waiting for ${missing.join(" and ")}. DNS changes can take up to an hour to be visible. ${seen}`.trim();
}
