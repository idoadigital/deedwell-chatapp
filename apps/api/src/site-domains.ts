import { execFile } from "node:child_process";
import type { Pool, PoolClient } from "pg";
import {
  instructionsFor, isApex, nextStatus, observeDns, probeHttps, progressCopy, registrableDomain,
  type DnsInstruction, type DnsObservation, type DomainStatus, type MappingState,
} from "@deedwell/website-domain";
import type { Deps } from "./bootstrap.js";

/**
 * Custom domains, end to end, against Google:
 *
 *   1. On add: ask the Site Verification API for the domain's TXT token. It
 *      becomes one of the two records the customer sets.
 *   2. On every check (the customer's button, or the worker below): look the
 *      records up; once the TXT is visible, ask Google to verify ownership;
 *      once ownership is confirmed and the hostname points at Google, create
 *      the Cloud Run domain mapping on the sites service; then watch the
 *      mapping until Google reports it ready with a certificate.
 *
 * Everything runs as the API's own service account (metadata server on
 * Cloud Run, gcloud in development), which therefore needs the Site
 * Verification scope and Cloud Run admin on the project. Per-domain state
 * lives in site_domains.dns:
 *   googleToken  the TXT value
 *   ownership    Google confirmed the root is ours
 *   mapping      MappingState from the last look at the domain mapping
 *   observed     the last DNS observation
 */

const PROJECT = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "royal-palace-446016";
const REGION = process.env.GCP_REGION ?? "us-central1";
const SERVICE = process.env.SITES_SERVICE_NAME ?? "deedwell-sites";
const SCOPES = ["https://www.googleapis.com/auth/siteverification", "https://www.googleapis.com/auth/cloud-platform"];

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/* ---- access token -------------------------------------------------------- */

let cached: { token: string; at: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() - cached.at < 40 * 60_000) return cached.token;
  let token = "";
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(SCOPES.join(","))}`,
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) token = ((await res.json()) as { access_token: string }).access_token;
  } catch {
    // Not on GCP — development falls through to the CLI.
  }
  if (!token) {
    token = await new Promise<string>((resolve, reject) => {
      execFile("gcloud", ["auth", "print-access-token"], { timeout: 15_000 }, (err, stdout) => {
        if (err) reject(new Error(`No Google credentials available (${err.message.slice(0, 100)})`));
        else resolve(stdout.trim());
      });
    });
  }
  cached = { token, at: Date.now() };
  return token;
}

async function google<T>(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const token = await accessToken();
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* no body */ }
  const error = res.ok ? null : ((data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`);
  return { ok: res.ok, status: res.status, data: data as T, error };
}

/* ---- Site Verification ---------------------------------------------------- */

/** The google-site-verification=… value for the registrable root. */
export async function fetchGoogleToken(domain: string): Promise<string> {
  const root = registrableDomain(domain);
  const r = await google<{ token?: string }>("POST", "https://www.googleapis.com/siteVerification/v1/token", {
    site: { type: "INET_DOMAIN", identifier: root }, verificationMethod: "DNS_TXT",
  });
  if (!r.ok || !r.data?.token) throw new Error(`Google could not prepare a verification record for ${root}: ${r.error ?? "no token returned"}`);
  return r.data.token;
}

/** Ask Google to confirm the TXT. Idempotent; false (not an error) when Google cannot see it yet. */
async function verifyOwnership(domain: string): Promise<{ verified: boolean; message: string | null }> {
  const root = registrableDomain(domain);
  const r = await google<{ id?: string }>("POST", "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT", {
    site: { type: "INET_DOMAIN", identifier: root },
  });
  if (r.ok) return { verified: true, message: null };
  // 400 "necessary verification token could not be found" = DNS not visible to Google yet.
  return { verified: false, message: r.error };
}

/* ---- Cloud Run domain mappings ------------------------------------------- */

const RUN = `https://${REGION}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${PROJECT}/domainmappings`;

interface Mapping {
  status?: { conditions?: { type: string; status: string; message?: string; reason?: string }[]; mappedRouteName?: string };
}

function readMapping(m: Mapping | null): MappingState {
  const conds = m?.status?.conditions ?? [];
  const cond = (t: string) => conds.find((c) => c.type === t);
  const ready = cond("Ready")?.status === "True";
  const cert = cond("CertificateProvisioned")?.status === "True";
  const failing = conds.find((c) => c.status === "False" && c.message);
  return { created: Boolean(m), ready, certificate: cert, message: failing?.message ?? null, checkedAt: new Date().toISOString() };
}

async function getMapping(domain: string): Promise<{ state: MappingState; error: string | null }> {
  const r = await google<Mapping>("GET", `${RUN}/${encodeURIComponent(domain)}`);
  if (r.status === 404) return { state: readMapping(null), error: null };
  if (!r.ok) return { state: readMapping(null), error: r.error };
  return { state: readMapping(r.data), error: null };
}

async function createMapping(domain: string): Promise<{ state: MappingState; error: string | null }> {
  const r = await google<Mapping>("POST", RUN, {
    apiVersion: "domains.cloudrun.com/v1", kind: "DomainMapping",
    metadata: { name: domain, namespace: PROJECT },
    spec: { routeName: SERVICE, certificateMode: "AUTOMATIC" },
  });
  if (r.status === 409) return getMapping(domain);
  if (!r.ok) return { state: readMapping(null), error: r.error };
  return { state: readMapping(r.data), error: null };
}

async function deleteMapping(domain: string): Promise<void> {
  await google("DELETE", `${RUN}/${encodeURIComponent(domain)}`).catch(() => undefined);
}

/* ---- the check ----------------------------------------------------------- */

interface Row {
  id: string; domain: string; status: DomainStatus; verification_token: string;
  dns: { googleToken?: string; ownership?: boolean; mapping?: MappingState; observed?: DnsObservation; https?: unknown } | null;
}

export interface CheckResult { status: DomainStatus; dns: Row["dns"]; lastError: string | null }

/**
 * One full check of a domain. Writes the row and returns the new state.
 * Never throws for a domain that is merely not ready; only for programming
 * or credential errors, which the caller records as last_error.
 */
export async function checkDomain(client: Pool | PoolClient, row: Row, log?: Log): Promise<CheckResult> {
  const dnsState = { ...(row.dns ?? {}) };
  let lastError: string | null = null;

  if (!dnsState.googleToken) {
    try { dnsState.googleToken = await fetchGoogleToken(row.domain); } catch (err) { lastError = (err as Error).message; }
  }
  const token = dnsState.googleToken ?? null;
  const obs = await observeDns(row.domain, token);
  dnsState.observed = obs;

  if (obs.verified && !dnsState.ownership) {
    const v = await verifyOwnership(row.domain);
    dnsState.ownership = v.verified;
    if (!v.verified && v.message && !/token could not be found|not found/i.test(v.message)) lastError = `Google: ${v.message}`;
  }

  let mapping: MappingState | null = dnsState.mapping ?? null;
  if (dnsState.ownership && obs.pointed) {
    const m = mapping?.created ? await getMapping(row.domain) : await createMapping(row.domain);
    if (m.error) lastError = `Hosting: ${m.error}`;
    else mapping = m.state;
    dnsState.mapping = mapping ?? undefined;
  }

  const https = mapping?.created && !mapping.ready ? await probeHttps(row.domain) : null;
  if (https) dnsState.https = https;
  const status = row.status === "connected" && !(mapping && !mapping.ready && https?.ok === false)
    ? "connected"
    : nextStatus(obs, https, Boolean(dnsState.ownership), mapping);
  if (obs.error && !lastError) lastError = obs.error;
  if (mapping?.message && status !== "connected" && !lastError) lastError = `Google: ${mapping.message}`;

  await client.query(
    `UPDATE site_domains SET status = $2, dns = $3::jsonb, last_checked_at = now(), last_error = $4,
            connected_at = CASE WHEN $2 = 'connected' AND connected_at IS NULL THEN now() ELSE connected_at END
      WHERE id = $1`,
    [row.id, status, JSON.stringify(dnsState), lastError],
  );
  log?.info({ domain: row.domain, status, ownership: dnsState.ownership, mapping }, "site domain checked");
  return { status, dns: dnsState, lastError };
}

/** Called when a domain is removed: the mapping goes with it. */
export async function releaseDomain(domain: string): Promise<void> {
  await deleteMapping(domain);
}

/** What the customer sees for a row. */
export function domainView(r: Row & { last_checked_at?: unknown; last_error?: unknown; connected_at?: unknown; created_at?: unknown }) {
  const token = r.dns?.googleToken ?? null;
  const obs = r.dns?.observed ?? null;
  const records: DnsInstruction[] = instructionsFor(r.domain, token).map((i) => ({
    ...i,
    found: !obs ? false
      : i.type === "TXT" ? obs.verified
      : i.type === "CNAME" ? obs.pointed
      : (obs.aFound ?? []).includes(i.value),
  }));
  const mapping = r.dns?.mapping ?? null;
  const ownership = Boolean(r.dns?.ownership);
  const steps = [
    { key: "records", label: "Add the DNS records", done: Boolean(obs?.verified && obs?.pointed) },
    { key: "ownership", label: "Ownership confirmed by Google", done: ownership },
    { key: "hosting", label: "Hosting set up", done: Boolean(mapping?.created) },
    { key: "certificate", label: "Certificate issued", done: r.status === "connected" },
  ];
  return {
    id: r.id, domain: r.domain, status: r.status, apex: isApex(r.domain), root: registrableDomain(r.domain),
    instructions: records, steps,
    message: token ? progressCopy(r.domain, obs ?? { txt: [], cname: null, a: [], verified: false, pointed: false, aFound: [], error: null }, ownership, mapping, token) : progressCopy(r.domain, { txt: [], cname: null, a: [], verified: false, pointed: false, aFound: [], error: null }, false, null, null),
    dns: r.dns, lastCheckedAt: r.last_checked_at, lastError: r.last_error, connectedAt: r.connected_at, createdAt: r.created_at,
  };
}

/* ---- worker -------------------------------------------------------------- */

/**
 * Re-checks every domain that is not connected yet, so a customer who added
 * the records and closed the tab still ends up connected. Cross-tenant, so
 * it runs on the admin pool. SITE_DOMAINS_WORKER=off disables it.
 */
export function startSiteDomainsWorker(deps: Deps, opts: { log?: Log; everyMs?: number } = {}): () => void {
  const everyMs = opts.everyMs ?? Number(process.env.SITE_DOMAINS_CHECK_MS ?? 5 * 60_000);
  let stopped = false; let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const { rows } = await deps.adminPool.query<Row>(
        `SELECT id, domain, status, verification_token, dns FROM site_domains
          WHERE status <> 'connected' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '4 minutes')
          ORDER BY last_checked_at NULLS FIRST LIMIT 20`,
      );
      for (const row of rows) {
        if (stopped) break;
        try { await checkDomain(deps.adminPool, row, opts.log); }
        catch (err) {
          opts.log?.warn({ domain: row.domain, err: (err as Error).message }, "site domain check failed");
          await deps.adminPool.query("UPDATE site_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1", [row.id, (err as Error).message.slice(0, 300)]).catch(() => undefined);
        }
      }
    } catch (err) {
      opts.log?.warn({ err: (err as Error).message }, "site domains sweep failed");
    } finally { busy = false; }
  };
  const first = setTimeout(() => { void tick(); }, 20_000);
  const timer = setInterval(() => { void tick(); }, everyMs);
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
