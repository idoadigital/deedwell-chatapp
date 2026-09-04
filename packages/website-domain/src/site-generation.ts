import type { StorageAdapter } from "@deedwell/database";
import type { ModelDataBlock } from "@deedwell/agent-runtime";
import { SiteGenerationSettings, type SiteRequiredSection, type WebsiteBriefOutput } from "@deedwell/schemas";

/**
 * Platform-wide direction for the website builder, set in Platform Admin →
 * Site Generation Settings: the sections a site must carry to satisfy
 * grant-approval requirements, plus a library of reference designs.
 *
 * Everything here is read at brief time, once per site. The settings row
 * and the template library are platform-owned (no tenant), so they are
 * read through whatever client the caller has — the tenant-scoped app
 * client can see them, it just cannot change them.
 */

export const SITE_GENERATION_SETTINGS_KEY = "site_generation";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export async function loadSiteGenerationSettings(db: Queryable): Promise<SiteGenerationSettings> {
  const { rows } = await db.query("SELECT value FROM platform_settings WHERE key = $1", [
    SITE_GENERATION_SETTINGS_KEY,
  ]);
  // A malformed row (hand-edited, or from an older shape) degrades to the
  // defaults rather than blocking every website build on the platform.
  const parsed = SiteGenerationSettings.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : SiteGenerationSettings.parse({});
}

export interface ReferenceTemplate {
  id: string;
  title: string;
  description: string;
  mime: string;
  bytes: Buffer;
}

/** One active template chosen uniformly at random, or null when the library
 *  is empty — in which case the strategist works from words alone. */
export async function pickReferenceTemplate(
  db: Queryable,
  storage: StorageAdapter,
  random: () => number = Math.random
): Promise<ReferenceTemplate | null> {
  const { rows } = await db.query(
    `SELECT id, title, description, mime, storage_key FROM site_reference_templates
      WHERE status = 'active' ORDER BY created_at`
  );
  if (!rows.length) return null;
  const row = rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))]!;
  const bytes = await storage.get(String(row.storage_key));
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    mime: String(row.mime),
    bytes,
  };
}

/** The extra documents the strategist receives. Both are optional: an empty
 *  settings row and an empty library add nothing to the prompt. */
export function siteGenerationDataBlocks(
  settings: SiteGenerationSettings,
  template: ReferenceTemplate | null
): ModelDataBlock[] {
  const blocks: ModelDataBlock[] = [];
  if (settings.requiredSections.length || settings.guidance.trim()) {
    blocks.push({
      label: "grant_requirements",
      content: JSON.stringify({
        requiredSections: settings.requiredSections,
        guidance: settings.guidance,
      }),
    });
  }
  if (template) {
    blocks.push({
      label: "design_reference",
      content: [
        `Reference design: "${template.title}".`,
        template.description.trim(),
        "Match its colours, contrast, typography and layout feel; do not copy its words.",
      ].filter(Boolean).join(" "),
      image: { mime: template.mime, base64: template.bytes.toString("base64") },
    });
  }
  return blocks;
}

type SitemapEntry = WebsiteBriefOutput["sitemap"][number];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function covers(page: SitemapEntry, section: SiteRequiredSection): boolean {
  if (page.slug === section.key) return true;
  const title = norm(section.title);
  if (!title) return false;
  return norm(page.title).includes(title) || norm(page.slug).includes(title) || norm(page.purpose).includes(title);
}

/**
 * Deterministic guarantee behind the prompt: every required section is in
 * the sitemap, whatever the model chose to do. A section the strategist
 * already covered is left as written; a missing one is appended as its own
 * page. The sitemap cap (10, from the schema) is kept by dropping the
 * model's optional pages from the end, never a required one.
 */
export function ensureRequiredSections(
  sitemap: SitemapEntry[],
  sections: SiteRequiredSection[],
  cap = 10
): SitemapEntry[] {
  const out: SitemapEntry[] = sitemap.map((p) => ({ ...p }));
  const required = new Set<number>();
  const usedSlugs = new Set(out.map((p) => p.slug));
  for (const section of sections) {
    const idx = out.findIndex((p) => covers(p, section));
    if (idx >= 0) {
      required.add(idx);
      continue;
    }
    let slug = section.key;
    for (let n = 2; usedSlugs.has(slug); n += 1) slug = `${section.key}-${n}`;
    usedSlugs.add(slug);
    out.push({
      slug,
      title: section.title,
      purpose: section.description.trim() || `Required for grant approval: ${section.title}.`,
    });
    required.add(out.length - 1);
  }
  while (out.length > cap) {
    // Drop the last optional page; the home page (index 0) is never optional.
    let victim = -1;
    for (let i = out.length - 1; i > 0; i -= 1) {
      if (!required.has(i)) { victim = i; break; }
    }
    if (victim < 0) break;
    out.splice(victim, 1);
    const shifted = new Set<number>();
    for (const i of required) shifted.add(i > victim ? i - 1 : i);
    required.clear();
    for (const i of shifted) required.add(i);
  }
  return out;
}
