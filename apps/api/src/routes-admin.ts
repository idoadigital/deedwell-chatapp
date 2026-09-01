import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { generateApiKey, encryptSecret } from "@deedwell/auth";
import { uuidv7 } from "@deedwell/database";
import { CreateApiKeyInput, CreateWebhookInput } from "@deedwell/schemas";
import { clearStripeConfig, getStripeConfigStatus, saveStripeConfig } from "@deedwell/billing-domain";
import { HttpError, type AppContext } from "./app.js";
import { deliverWebhooks } from "./webhooks.js";

/** Platform-admin-only management of the developer platform: API keys and
 *  webhook subscriptions for the platform-wide read API (routes-public.ts).
 *  This is NOT a per-nonprofit-org surface — it's provisioning for the one
 *  external application (an AI agent that builds nonprofit websites) that
 *  reads across every organization's site data, so it's gated on
 *  requirePlatformAdmin, not org membership. There is no :orgId in these
 *  routes at all. */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- API keys -------------------------------------------------------

  app.post("/v1/admin/api-keys", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const input = CreateApiKeyInput.parse(req.body);
    const { key, keyHash, keyPrefix } = generateApiKey();
    const id = uuidv7();
    await ctx.deps.appPool.query(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.name, keyHash, keyPrefix, input.scopes, req.userId]
    );
    // Platform-level audit trail: no tenant_id to attach this to, so it's
    // logged rather than written through the tenant-scoped audit() helper.
    req.log.info({ at: "api_key.created", id, name: input.name, scopes: input.scopes, createdBy: req.userId });
    // The raw key is returned exactly once — only key_hash is ever stored.
    return reply.status(201).send({ id, key });
  });

  app.get("/v1/admin/api-keys", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.appPool.query(
      `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
       FROM api_keys ORDER BY created_at DESC`
    );
    return { apiKeys: rows };
  });

  app.delete("/v1/admin/api-keys/:id", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { id } = req.params as { id: string };
    const { rowCount } = await ctx.deps.appPool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
    if (!rowCount) throw new HttpError(404, "API key not found");
    req.log.info({ at: "api_key.revoked", id, revokedBy: req.userId });
    return { ok: true };
  });

  // ---- Webhooks ---------------------------------------------------------

  app.post("/v1/admin/webhooks", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const input = CreateWebhookInput.parse(req.body);
    const secret = randomBytes(32).toString("base64url");
    const { ciphertext, iv, tag, keyVersion } = encryptSecret(Buffer.from(secret, "utf8"));
    const id = uuidv7();
    await ctx.deps.appPool.query(
      `INSERT INTO webhook_subscriptions
         (id, url, description, event_types, secret_ciphertext, secret_iv, secret_tag, secret_key_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, input.url, input.description ?? null, input.eventTypes, ciphertext, iv, tag, keyVersion, req.userId]
    );
    req.log.info({ at: "webhook.created", id, url: input.url, eventTypes: input.eventTypes, createdBy: req.userId });
    // The signing secret is returned exactly once — only its encrypted form is stored.
    return reply.status(201).send({ id, secret });
  });

  app.get("/v1/admin/webhooks", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.appPool.query(
      `SELECT id, url, description, event_types, is_active, created_at
       FROM webhook_subscriptions ORDER BY created_at DESC`
    );
    return { webhooks: rows };
  });

  app.delete("/v1/admin/webhooks/:id", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { id } = req.params as { id: string };
    const { rowCount } = await ctx.deps.appPool.query(`DELETE FROM webhook_subscriptions WHERE id = $1`, [id]);
    if (!rowCount) throw new HttpError(404, "Webhook not found");
    req.log.info({ at: "webhook.deleted", id, deletedBy: req.userId });
    return { ok: true };
  });

  app.post("/v1/admin/webhooks/:id/test", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { id } = req.params as { id: string };
    const sub = await ctx.deps.appPool.query(`SELECT id FROM webhook_subscriptions WHERE id = $1`, [id]);
    if (!sub.rows[0]) throw new HttpError(404, "Webhook not found");
    // A test ping ignores event_types/is_active — it exists precisely so an
    // integrator can verify their endpoint before relying on a real event.
    const delivery = await ctx.deps.appPool.query(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload)
       VALUES ($1,$2,'website.test','{"message":"This is a test delivery from Deedwell."}'::jsonb)
       RETURNING id`,
      [uuidv7(), id]
    );
    await deliverWebhooks(ctx.deps.appPool, delivery.rows.map((r: { id: string }) => r.id));
    return { ok: true };
  });

  // ---- Payments: the one platform-wide Stripe account, not per-org -------

  app.get("/v1/admin/billing/stripe-config", async (req) => {
    ctx.requirePlatformAdmin(req);
    return getStripeConfigStatus(ctx.deps.appPool);
  });

  app.post("/v1/admin/billing/stripe-config", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { secretKey, webhookSecret } = req.body as { secretKey?: string; webhookSecret?: string };
    if (!secretKey?.startsWith("sk_")) throw new HttpError(400, "That doesn't look like a Stripe secret key (should start with sk_)");
    if (!webhookSecret?.startsWith("whsec_")) throw new HttpError(400, "That doesn't look like a Stripe webhook signing secret (should start with whsec_)");
    const result = await saveStripeConfig(ctx.deps.appPool, { secretKey, webhookSecret, setBy: req.userId! });
    // Platform-level audit trail: no tenant_id to attach this to, so it's
    // logged rather than written through the tenant-scoped audit() helper —
    // same as api_key.created/webhook.created above.
    req.log.info({ at: "stripe_config.updated", secretKeyLast4: result.secretKeyLast4, setBy: req.userId });
    return reply.status(201).send(result);
  });

  app.delete("/v1/admin/billing/stripe-config", async (req) => {
    ctx.requirePlatformAdmin(req);
    const cleared = await clearStripeConfig(ctx.deps.appPool);
    if (!cleared) throw new HttpError(404, "No Stripe configuration to remove");
    req.log.info({ at: "stripe_config.removed", removedBy: req.userId });
    return { ok: true };
  });
}
