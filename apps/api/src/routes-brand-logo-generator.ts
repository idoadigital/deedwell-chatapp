import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, tenantFileKey, uuidv7 } from "@deedwell/database";
import { createImageGenerator, readProviderKey } from "@deedwell/content-domain";
import { LogoBrief, LogoConcept } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";
import { LOGO_MAX_BYTES } from "./brand.js";
import { setLogoFact } from "./routes-brand.js";
import { buildLogoBrief, planLogoConcepts, renderLogoConcept, type LogoOrgContext } from "./logo-generator.js";
import { transcribeClip } from "./transcribe.js";

/**
 * Brand Style → Generate a Logo. Additive to the upload flow in
 * routes-brand.ts: candidates live in storage only (never in `files`, so
 * they do not appear among the organization's documents), and the one the
 * user picks is written exactly as an upload is — a `files` row and the
 * brand_logo_file_id fact — so nothing downstream can tell the difference.
 */
const GENERATION_ID = /^[0-9a-f-]{36}$/;
const CONCEPT_ID = /^[a-z0-9-]{1,40}$/;
const BRAND_LOGO_META_FACT = "brand_logo_meta";

function candidateKey(orgId: string, generationId: string, conceptId: string): string {
  return `tenants/${orgId}/logo-candidates/${generationId}/${conceptId}.png`;
}

async function loadLogoContext(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, orgId: string): Promise<LogoOrgContext> {
  const [org, facts] = await Promise.all([
    client.query("SELECT name FROM organizations WHERE id = $1", [orgId]),
    client.query("SELECT fact_key, value FROM org_facts WHERE status <> 'rejected' ORDER BY fact_key LIMIT 80"),
  ]);
  return {
    name: String(org.rows[0]?.name ?? "This nonprofit"),
    facts: facts.rows.map((r) => ({ key: String(r.fact_key), value: String(r.value) })),
  };
}

export function registerBrandLogoGeneratorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  /** Step 1 → 2: the conversational request becomes an editable brief. */
  app.post("/v1/orgs/:orgId/brand/logo/brief", async (req) => {
    ctx.requireRole(req, "member");
    const { request } = z.object({ request: z.string().trim().min(8).max(4000) }).parse(req.body);
    const org = await ctx.inOrg(req, (client) => loadLogoContext(client, req.orgId!));
    if (!org.facts.some((f) => f.key === "legal_name" && f.value.trim())) {
      throw new HttpError(409, "Add your organization name under Mission Profile → Organization first, so the logo can carry it.");
    }
    try {
      const brief = await buildLogoBrief({ model: deps.provider, org, request });
      return { brief };
    } catch (err) {
      req.log.warn({ err }, "logo brief failed");
      throw new HttpError(502, "Could not write the brief just now. Please try again.");
    }
  });

  /** Step 3: the approved brief becomes a set of distinct concepts. Nothing
   *  is drawn yet — each concept is rendered by its own request below, so a
   *  slow or failed image never takes the others with it. */
  app.post("/v1/orgs/:orgId/brand/logo/concepts", async (req) => {
    ctx.requireRole(req, "member");
    const input = z.object({
      brief: LogoBrief,
      count: z.number().int().min(3).max(6).optional(),
      /** Titles/approaches already shown — "Generate more" must not repeat them. */
      avoid: z.array(z.string().max(200)).max(30).optional(),
    }).parse(req.body);
    try {
      const concepts = await planLogoConcepts({ model: deps.provider, brief: input.brief, count: input.count ?? 5, avoid: input.avoid });
      const generationId = uuidv7();
      return {
        generationId,
        concepts: concepts.map((c, i) => ({ id: `c${i + 1}-${c.approach.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "concept"}`, ...c })),
      };
    } catch (err) {
      req.log.warn({ err }, "logo concepts failed");
      throw new HttpError(502, "Could not plan the logo directions just now. Please try again.");
    }
  });

  /** One concept → one transparent PNG candidate in storage. */
  app.post("/v1/orgs/:orgId/brand/logo/render", async (req) => {
    ctx.requireRole(req, "member");
    const input = z.object({
      generationId: z.string().regex(GENERATION_ID),
      conceptId: z.string().regex(CONCEPT_ID),
      brief: LogoBrief,
      concept: LogoConcept,
    }).parse(req.body);
    const apiKey = await readProviderKey(deps.appPool, "openai");
    let rendered;
    try {
      rendered = await renderLogoConcept({ images: createImageGenerator({ apiKey }), brief: input.brief, concept: input.concept, maxBytes: LOGO_MAX_BYTES });
    } catch (err) {
      const message = String((err as Error).message ?? err);
      req.log.warn({ err }, "logo render failed");
      const timedOut = /timeout|aborted/i.test(message);
      throw new HttpError(502, timedOut ? "That concept took too long to draw. Try it again." : /transparent|PNG|empty|too large/i.test(message) ? `${message} Try that concept again.` : "Could not draw that concept just now. Try it again.");
    }
    await deps.storage.put(candidateKey(req.orgId!, input.generationId, input.conceptId), rendered.bytes);
    return {
      candidate: {
        generationId: input.generationId, conceptId: input.conceptId,
        width: rendered.width, height: rendered.height, size: rendered.bytes.length, prompt: rendered.prompt,
      },
    };
  });

  /** The candidate's bytes, for the modal's previews. Tenant-scoped by the
   *  key, which embeds the org from the session, not the URL. */
  app.get("/v1/orgs/:orgId/brand/logo/candidates/:generationId/:conceptId", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { generationId, conceptId } = req.params as { generationId: string; conceptId: string };
    if (!GENERATION_ID.test(generationId) || !CONCEPT_ID.test(conceptId)) throw new HttpError(404, "Not found");
    let bytes: Buffer;
    try { bytes = await deps.storage.get(candidateKey(req.orgId!, generationId, conceptId)); }
    catch { throw new HttpError(404, "That logo option is no longer available."); }
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(bytes);
  });

  /** "Use this logo": the candidate becomes an ordinary file and the
   *  organization's logo, exactly as an upload would. */
  app.post("/v1/orgs/:orgId/brand/logo/select", async (req) => {
    ctx.requireRole(req, "member");
    const input = z.object({
      generationId: z.string().regex(GENERATION_ID),
      conceptId: z.string().regex(CONCEPT_ID),
      brief: LogoBrief,
      concept: LogoConcept,
      prompt: z.string().max(6000).optional(),
    }).parse(req.body);
    let bytes: Buffer;
    try { bytes = await deps.storage.get(candidateKey(req.orgId!, input.generationId, input.conceptId)); }
    catch { throw new HttpError(404, "That logo option is no longer available — generate again."); }
    if (bytes.length > LOGO_MAX_BYTES) throw new HttpError(413, "The logo must be under 2.5 MB.");

    const fileId = uuidv7();
    const filename = `${input.brief.organizationName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "organization"}-logo.png`;
    const storageKey = tenantFileKey(req.orgId!, fileId, filename);
    await deps.storage.put(storageKey, bytes);
    const meta = {
      logo_source: "generated",
      logo_type: input.concept.logoType,
      logo_generation_id: input.generationId,
      logo_concept: { id: input.conceptId, title: input.concept.title, approach: input.concept.approach },
      logo_generation_prompt: (input.prompt ?? "").slice(0, 2000),
      logo_design_brief: input.brief,
      selected_logo_asset: fileId,
      created_at: new Date().toISOString(),
    };
    const file = await ctx.inOrg(req, async (client) => {
      await client.query(
        `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
        [fileId, req.orgId, filename, "image/png", bytes.length, createHash("sha256").update(bytes).digest("hex"), storageKey, req.userId]
      );
      await setLogoFact(client, req.orgId!, req.userId!, fileId);
      await client.query(
        `INSERT INTO org_facts (id, tenant_id, fact_key, value, status, certified_by)
         VALUES ($1, $2, $3, $4, 'user_certified', $5)
         ON CONFLICT (tenant_id, fact_key)
         DO UPDATE SET value = EXCLUDED.value, status = 'user_certified', certified_by = EXCLUDED.certified_by, updated_at = now()`,
        [uuidv7(), req.orgId, BRAND_LOGO_META_FACT, JSON.stringify(meta), req.userId]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "brand.logo_generated",
        entityType: "files", entityId: fileId,
        metadata: { filename, generationId: input.generationId, concept: input.concept.title, logoType: input.concept.logoType },
      });
      return { id: fileId, filename, mime: "image/png", size_bytes: bytes.length };
    });
    return { logo: { fileId: file.id, filename: file.filename, mime: file.mime, size: file.size_bytes } };
  });

  /** Voice input for the request box, for browsers without on-device
   *  speech recognition: one short clip in, its transcript out. */
  app.post("/v1/orgs/:orgId/brand/logo/transcribe", async (req) => {
    ctx.requireRole(req, "member");
    const { audioBase64, mime } = z.object({
      audioBase64: z.string().min(16).max(12_000_000),
      mime: z.string().max(80),
    }).parse(req.body);
    const bytes = Buffer.from(audioBase64, "base64");
    if (bytes.length < 1000) throw new HttpError(400, "That recording was too short to transcribe.");
    try {
      const text = await transcribeClip(bytes, mime);
      return { text };
    } catch (err) {
      const message = String((err as Error).message ?? err);
      req.log.warn({ err }, "logo transcribe failed");
      throw new HttpError(/switched off|not available/i.test(message) ? 503 : 502, /switched off|not available/i.test(message)
        ? "Voice input is not available on this server — type your description instead."
        : "Could not transcribe that recording. Try again, or type your description.");
    }
  });
}
