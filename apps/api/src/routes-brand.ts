import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, invalidateMissionProfile, uuidv7 } from "@deedwell/database";
import { syncSitesToBrandLogo } from "@deedwell/website-domain";
import { HttpError, type AppContext } from "./app.js";
import { BRAND_LOGO_FACT, LOGO_MAX_BYTES, LOGO_MIMES } from "./brand.js";

/** Brand Style's logo. The file itself is uploaded through the ordinary
 *  files route; this records which file is the logo (as an org fact), after
 *  checking it is a raster the website sanitizer will also accept. */
export function registerBrandRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/orgs/:orgId/brand/logo", async (req) => {
    ctx.requireRole(req, "viewer");
    const logo = await ctx.inOrg(req, async (client) => {
      const fact = await client.query(
        "SELECT value FROM org_facts WHERE fact_key = $1 LIMIT 1",
        [BRAND_LOGO_FACT]
      );
      const fileId = String(fact.rows[0]?.value ?? "").replace(/^"|"$/g, "");
      if (!/^[0-9a-f-]{36}$/.test(fileId)) return null;
      const file = await client.query("SELECT id, filename, mime, size_bytes FROM files WHERE id = $1", [fileId]);
      return file.rows[0] ?? null;
    });
    return { logo: logo ? { fileId: logo.id, filename: logo.filename, mime: logo.mime, size: Number(logo.size_bytes) } : null };
  });

  app.put("/v1/orgs/:orgId/brand/logo", async (req) => {
    ctx.requireRole(req, "member");
    invalidateMissionProfile(req.orgId!);
    const { fileId } = z.object({ fileId: z.string().uuid() }).parse(req.body);
    const file = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT id, filename, mime, size_bytes FROM files WHERE id = $1", [fileId]);
      const row = rows[0];
      if (!row) throw new HttpError(404, "That file was not found.");
      if (!LOGO_MIMES.has(row.mime)) throw new HttpError(400, "The logo must be a PNG, JPEG or WebP image.");
      if (Number(row.size_bytes) > LOGO_MAX_BYTES) throw new HttpError(413, "The logo must be under 2.5 MB.");
      await setLogoFact(client, req.orgId!, req.userId!, row.id);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "brand.logo_set",
        entityType: "files", entityId: row.id, metadata: { filename: row.filename },
      });
      // The generated website follows Brand Style.
      const sites = await syncSitesToBrandLogo(client, ctx.deps.storage, req.orgId!, req.userId ?? null);
      return { row, sites };
    });
    return { logo: { fileId: file.row.id, filename: file.row.filename, mime: file.row.mime, size: Number(file.row.size_bytes) }, sites: file.sites };
  });

  app.delete("/v1/orgs/:orgId/brand/logo", async (req) => {
    ctx.requireRole(req, "member");
    invalidateMissionProfile(req.orgId!);
    const sites = await ctx.inOrg(req, async (client) => {
      // Cleared, not deleted: an empty value is "no logo".
      await setLogoFact(client, req.orgId!, req.userId!, "");
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "brand.logo_cleared", entityType: "org_facts", metadata: { key: BRAND_LOGO_FACT } });
      return syncSitesToBrandLogo(client, ctx.deps.storage, req.orgId!, req.userId ?? null);
    });
    return { ok: true, sites };
  });
}

/** Choosing a logo is a decision, not a claim about the organisation, so it
 *  is written directly rather than through the fact-conflict flow (which
 *  would park a replacement as a "conflict" to review). */
export async function setLogoFact(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, tenantId: string, userId: string, value: string): Promise<void> {
  await client.query(
    `INSERT INTO org_facts (id, tenant_id, fact_key, value, status, certified_by)
     VALUES ($1, $2, $3, $4, 'user_certified', $5)
     ON CONFLICT (tenant_id, fact_key)
     DO UPDATE SET value = EXCLUDED.value, status = 'user_certified', certified_by = EXCLUDED.certified_by, updated_at = now()`,
    [uuidv7(), tenantId, BRAND_LOGO_FACT, value, userId]
  );
}
