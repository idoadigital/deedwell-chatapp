import type { PoolClient } from "pg";
import type { StorageAdapter } from "./storage.js";

/**
 * The organization's Mission Profile as one block every agent can read:
 * the facts the user certified (organization, brand style), the notes they
 * wrote in the Knowledge Base, and the titles of the documents they
 * uploaded. Loaded once per request/step and cached briefly per tenant —
 * notes are small text files in storage, and a chat turn should not read
 * them all twice.
 */
export interface MissionProfile {
  orgName: string;
  facts: Array<{ key: string; value: string; status: string }>;
  notes: Array<{ title: string; text: string; createdAt: string }>;
  documents: Array<{ filename: string; createdAt: string }>;
  hasLogo: boolean;
}

const FACT_LABELS: Record<string, string> = {
  legal_name: "Organization name", tagline: "Tagline", mission: "Mission statement", value_proposition: "Value proposition",
  entity_type: "Organization type", year_founded: "Year founded", website_url: "Website", focus_areas: "Primary focus areas",
  ein: "EIN", hq_location: "HQ location", team_size: "Team size", registration_status: "Registration status",
  annual_budget: "Annual budget", primary_contact_email: "Primary contact email",
  brand_voice: "Brand voice", brand_primary_color: "Primary colour", brand_accent_color: "Accent colour", brand_keywords: "Brand keywords",
};
const BRAND_KEYS = new Set(["brand_voice", "brand_primary_color", "brand_accent_color", "brand_keywords"]);
const HIDDEN_KEYS = new Set(["brand_logo_file_id", "brand_logo_meta"]);
const NOTE_LIMIT = 12;
const NOTE_CHARS = 2000;
const TOTAL_NOTE_CHARS = 8000;
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; value: MissionProfile }>();

export function invalidateMissionProfile(tenantId: string): void { cache.delete(tenantId); }

export async function loadMissionProfile(client: PoolClient, storage: StorageAdapter, tenantId: string, opts: { fresh?: boolean } = {}): Promise<MissionProfile> {
  const hit = cache.get(tenantId);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const [org, facts, files] = await Promise.all([
    client.query("SELECT name FROM organizations WHERE id = $1", [tenantId]),
    client.query("SELECT fact_key, value, status FROM org_facts WHERE tenant_id = $1 AND status <> 'rejected' ORDER BY fact_key", [tenantId]),
    client.query(
      `SELECT id, filename, mime, storage_key, size_bytes, created_at FROM files
        WHERE tenant_id = $1 AND project_id IS NULL ORDER BY created_at DESC LIMIT 60`, [tenantId]),
  ]);
  const logoId = String(facts.rows.find((r) => r.fact_key === "brand_logo_file_id")?.value ?? "").replace(/^"|"$/g, "");
  const notes: MissionProfile["notes"] = [];
  const documents: MissionProfile["documents"] = [];
  let budget = TOTAL_NOTE_CHARS;
  for (const f of files.rows) {
    if (f.id === logoId) continue;
    if (f.mime === "text/plain") {
      if (notes.length >= NOTE_LIMIT || budget <= 0 || Number(f.size_bytes) > 200_000) continue;
      try {
        const text = (await storage.get(f.storage_key)).toString("utf8").trim().slice(0, Math.min(NOTE_CHARS, budget));
        if (!text) continue;
        budget -= text.length;
        notes.push({ title: String(f.filename).replace(/\.txt$/i, ""), text, createdAt: new Date(f.created_at).toISOString() });
      } catch { /* a missing note is not a reason to fail the turn */ }
    } else if (!/^image\//.test(String(f.mime))) {
      documents.push({ filename: f.filename, createdAt: new Date(f.created_at).toISOString() });
    }
  }
  const value: MissionProfile = {
    orgName: org.rows[0]?.name ?? "This organization",
    facts: facts.rows.filter((r) => !HIDDEN_KEYS.has(r.fact_key)).map((r) => ({ key: r.fact_key, value: String(r.value), status: r.status })),
    notes, documents, hasLogo: /^[0-9a-f-]{36}$/.test(logoId),
  };
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}

const label = (key: string) => FACT_LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The profile as plain text for a model data block. Empty sections are
 *  named as empty, so an agent knows what it does not know rather than
 *  guessing. */
export function missionProfileBlock(p: MissionProfile): string {
  const org = p.facts.filter((f) => !BRAND_KEYS.has(f.key));
  const brand = p.facts.filter((f) => BRAND_KEYS.has(f.key));
  const lines: string[] = [`ORGANIZATION: ${p.orgName}`];
  if (org.length) for (const f of org) lines.push(`${label(f.key)}: ${f.value}${f.status === "verified" || f.status === "user_certified" ? "" : ` (${f.status})`}`);
  else lines.push("(No organization details saved yet.)");
  lines.push("", "BRAND STYLE:");
  if (brand.length || p.hasLogo) {
    for (const f of brand) lines.push(`${label(f.key)}: ${f.value}`);
    lines.push(`Logo: ${p.hasLogo ? "on file" : "none yet"}`);
  } else lines.push("(No brand style saved yet.)");
  lines.push("", "KNOWLEDGE BASE NOTES (written by the organization):");
  if (p.notes.length) for (const n of p.notes) lines.push(`— ${n.title}: ${n.text.replace(/\s+/g, " ")}`);
  else lines.push("(No notes yet.)");
  lines.push("", "DOCUMENTS ON FILE (titles only; contents are not shown here):");
  lines.push(p.documents.length ? p.documents.map((d) => d.filename).join("; ") : "(No documents yet.)");
  return lines.join("\n");
}
