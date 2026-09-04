import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { platformFileKey, uuidv7 } from "@deedwell/database";
import {
  SiteGenerationSettings, UpdateSiteTemplateInput, UploadSiteTemplateInput,
} from "@deedwell/schemas";
import { SITE_GENERATION_SETTINGS_KEY, loadSiteGenerationSettings } from "@deedwell/website-domain";
import { HttpError, type AppContext } from "./app.js";

/** Platform Admin → Site Generation Settings.
 *
 *  Two platform-owned things the website builder reads at brief time: the
 *  sections a generated site must carry for grant approval, and the library
 *  of reference designs it draws one of at random. Neither has a tenant, so
 *  every handler is gated by requirePlatformAdmin and talks to appPool
 *  directly, the same as the integrations routes. */

const MAX_IMAGE_BYTES = 8_000_000;
const TEMPLATE_COLUMNS =
  "id, title, description, filename, mime, size_bytes, status, created_by, created_at, updated_at";

export function registerAdminSiteGenerationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.get("/v1/admin/site-generation", async (req) => {
    ctx.requirePlatformAdmin(req);
    const [settings, templates] = await Promise.all([
      loadSiteGenerationSettings(deps.appPool),
      deps.appPool.query(
        `SELECT ${TEMPLATE_COLUMNS} FROM site_reference_templates ORDER BY created_at DESC`
      ),
    ]);
    return { settings, templates: templates.rows };
  });

  app.put("/v1/admin/site-generation/settings", async (req) => {
    ctx.requirePlatformAdmin(req);
    const settings = SiteGenerationSettings.parse(req.body);
    const keys = new Set<string>();
    for (const section of settings.requiredSections) {
      if (keys.has(section.key)) throw new HttpError(400, `Duplicate section key "${section.key}"`);
      keys.add(section.key);
    }
    await deps.appPool.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [SITE_GENERATION_SETTINGS_KEY, JSON.stringify(settings), req.userId]
    );
    req.log.info(
      { at: "admin.site_generation.settings_saved", userId: req.userId, sections: settings.requiredSections.length },
      "site generation settings saved"
    );
    return { settings };
  });

  app.post("/v1/admin/site-generation/templates", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const input = UploadSiteTemplateInput.parse(req.body);
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0) throw new HttpError(400, "Image is empty");
    if (content.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Image exceeds the 8 MB limit");

    const id = uuidv7();
    const storageKey = platformFileKey("site-templates", id, input.filename);
    await deps.storage.put(storageKey, content);
    const { rows } = await deps.appPool.query(
      `INSERT INTO site_reference_templates
         (id, title, description, filename, mime, size_bytes, sha256, storage_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${TEMPLATE_COLUMNS}`,
      [id, input.title, input.description, input.filename, input.mime, content.length,
       createHash("sha256").update(content).digest("hex"), storageKey, req.userId]
    );
    req.log.info({ at: "admin.site_generation.template_added", userId: req.userId, templateId: id }, "reference template added");
    return reply.status(201).send({ template: rows[0] });
  });

  app.patch("/v1/admin/site-generation/templates/:templateId", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { templateId } = req.params as { templateId: string };
    const input = UpdateSiteTemplateInput.parse(req.body);
    const { rows } = await deps.appPool.query(
      `UPDATE site_reference_templates
          SET title = COALESCE($2, title),
              description = COALESCE($3, description),
              status = COALESCE($4, status)
        WHERE id = $1
        RETURNING ${TEMPLATE_COLUMNS}`,
      [templateId, input.title ?? null, input.description ?? null, input.status ?? null]
    );
    if (!rows[0]) throw new HttpError(404, "Template not found");
    return { template: rows[0] };
  });

  /** The image itself, for the admin library grid. Admin-only: templates are
   *  platform material, never shown to a tenant. */
  app.get("/v1/admin/site-generation/templates/:templateId/content", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { templateId } = req.params as { templateId: string };
    const { rows } = await deps.appPool.query(
      "SELECT filename, mime, storage_key FROM site_reference_templates WHERE id = $1",
      [templateId]
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Template not found");
    const bytes = await deps.storage.get(row.storage_key);
    reply.header("content-type", row.mime);
    reply.header("content-disposition", `inline; filename="${String(row.filename).replace(/"/g, "")}"`);
    reply.header("cache-control", "private, max-age=31536000, immutable");
    return reply.send(bytes);
  });
}
