import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";

/**
 * Custom domains, on the hosting Deedwell actually runs:
 *
 *   Generated sites are served by the `deedwell-sites` Cloud Run service.
 *   deedwell.org's own hostnames reach Cloud Run through Cloud Run domain
 *   mappings, whose DNS target is ghs.googlehosted.com — so that is the CNAME
 *   a customer's domain uses too. A mapping for the customer's hostname has
 *   to be registered on the service before Google issues its certificate;
 *   that step is done by Deedwell (Platform Admin), which is why a verified
 *   domain sits in "SSL provisioning" until then. Nothing here is a guess:
 *   the records are checked with real DNS lookups.
 */

export const DNS_TARGET = process.env.SITES_CNAME_TARGET ?? "ghs.googlehosted.com";
export const VERIFY_PREFIX = "_deedwell";

export interface DnsInstruction { type: "CNAME" | "TXT" | "A"; host: string; value: string; note: string }

export function newVerificationToken(): string {
  return `deedwell-site-verification=${randomBytes(12).toString("hex")}`;
}

export function instructionsFor(domain: string, token: string): DnsInstruction[] {
  const parts = domain.split(".");
  const apex = parts.length === 2;
  // Hosts are relative to the zone, the way DNS providers ask for them:
  // "www" for www.example.org, "@" for the apex.
  const host = apex ? "@" : parts.slice(0, -2).join(".");
  const out: DnsInstruction[] = [
    { type: "TXT", host: `${VERIFY_PREFIX}${apex ? "" : `.${host}`}`, value: token, note: `Proves you control the domain (full name: ${VERIFY_PREFIX}.${domain}). Can be removed after the domain is connected.` },
  ];
  if (apex) out.push({ type: "A", host: "@", value: "216.239.32.21", note: "Apex domains cannot use a CNAME. Add all four Google A records: 216.239.32.21, 216.239.34.21, 216.239.36.21, 216.239.38.21 — DNS only (not proxied)." });
  else out.push({ type: "CNAME", host, value: DNS_TARGET, note: "Points the hostname at Deedwell's hosting. DNS only (not proxied) so the certificate can be issued." });
  return out;
}

export interface DnsObservation { txt: string[]; cname: string | null; a: string[]; verified: boolean; pointed: boolean; error: string | null }

const GOOGLE_A = new Set(["216.239.32.21", "216.239.34.21", "216.239.36.21", "216.239.38.21"]);

/** Looks the records up. Resolver errors are reported, not hidden. */
export async function observeDns(domain: string, token: string): Promise<DnsObservation> {
  const parts = domain.split(".");
  const apex = parts.length === 2;
  const obs: DnsObservation = { txt: [], cname: null, a: [], verified: false, pointed: false, error: null };
  const verifyHost = `${VERIFY_PREFIX}.${domain}`;
  try { obs.txt = (await dns.resolveTxt(verifyHost)).map((r) => r.join("")); } catch (err) { obs.error = `TXT ${verifyHost}: ${(err as { code?: string }).code ?? "lookup failed"}`; }
  obs.verified = obs.txt.includes(token);
  try { const c = await dns.resolveCname(domain); obs.cname = c[0] ?? null; } catch { obs.cname = null; }
  if (!obs.cname) { try { obs.a = await dns.resolve4(domain); } catch { obs.a = []; } }
  obs.pointed = apex ? obs.a.some((ip) => GOOGLE_A.has(ip)) : (obs.cname ?? "").replace(/\.$/, "").toLowerCase() === DNS_TARGET.toLowerCase() || obs.a.some((ip) => GOOGLE_A.has(ip));
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

/** The next status from what was observed. `mapped` = Deedwell registered
 *  the hostname on the hosting service (Platform Admin marks it). */
export function nextStatus(obs: DnsObservation, https: { ok: boolean } | null, mapped: boolean): DomainStatus {
  if (obs.error && !obs.verified && !obs.pointed) return "pending_dns";
  if (!obs.verified || !obs.pointed) return obs.verified || obs.pointed ? "verifying" : "pending_dns";
  if (https?.ok) return "connected";
  return mapped ? "ssl_provisioning" : "ssl_provisioning";
}
