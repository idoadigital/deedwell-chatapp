import type { PoolClient } from "pg";
import type { StorageAdapter } from "@deedwell/database";
import type { LogoReference } from "@deedwell/content-domain";

/** Brand Style keeps the logo as an org fact pointing at a stored file, so
 *  it is one more thing the account knows about itself — and every
 *  generator reads it the same way. */
export const BRAND_LOGO_FACT = "brand_logo_file_id";
export const LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const LOGO_MAX_BYTES = 2_500_000;

export interface BrandLogo extends LogoReference { fileId: string; filename: string }

/** The organization's logo bytes, or null when Brand Style has none (or the
 *  file is gone). Tenant-scoped through the client that is passed in. */
export async function loadBrandLogo(client: PoolClient, storage: StorageAdapter): Promise<BrandLogo | null> {
  const fact = await client.query(
    "SELECT value FROM org_facts WHERE fact_key = $1 LIMIT 1",
    [BRAND_LOGO_FACT]
  );
  const fileId = String(fact.rows[0]?.value ?? "").trim().replace(/^"|"$/g, "");
  if (!/^[0-9a-f-]{36}$/.test(fileId)) return null;
  const file = await client.query("SELECT id, filename, mime, storage_key, size_bytes FROM files WHERE id = $1", [fileId]);
  const row = file.rows[0];
  if (!row || !LOGO_MIMES.has(row.mime) || Number(row.size_bytes) > LOGO_MAX_BYTES) return null;
  try {
    const bytes = await storage.get(row.storage_key);
    return { fileId: row.id, filename: row.filename, mime: row.mime, bytes };
  } catch {
    return null;
  }
}
