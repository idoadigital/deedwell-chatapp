import type { FastifyInstance } from "fastify";
import {
  createCheckoutSession, getBalance, handleCheckoutCompleted,
  listTransactions, loadStripeConfig, TOKEN_PACKAGES, verifyWebhookEvent,
} from "@deedwell/billing-domain";
import { HttpError, type AppContext } from "./app.js";

// Same trusted-origin allowlist reasoning as routes-ad-grants.ts's OAuth
// redirect handling — success/cancel URLs are round-tripped through
// Stripe's servers, so they're returned to us, not attacker-supplied on
// this request, but still only ever pointed at an origin this deployment
// already trusts.
function appOrigin(): string {
  return (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",")[0]!;
}

export function registerBillingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/orgs/:orgId/billing/balance", async (req) => {
    ctx.requireRole(req, "member");
    const config = await loadStripeConfig(ctx.deps.appPool);
    const tokenBalance = await ctx.inOrg(req, (client) => getBalance(client, req.orgId!));
    return { tokenBalance, configured: config !== null };
  });

  app.get("/v1/orgs/:orgId/billing/transactions", async (req) => {
    ctx.requireRole(req, "member");
    const transactions = await ctx.inOrg(req, (client) => listTransactions(client, req.orgId!));
    return { transactions };
  });

  app.get("/v1/orgs/:orgId/billing/packages", async (req) => {
    ctx.requireRole(req, "member");
    return { packages: TOKEN_PACKAGES };
  });

  app.post("/v1/orgs/:orgId/billing/checkout", async (req, reply) => {
    ctx.requireRole(req, "admin");
    const config = await loadStripeConfig(ctx.deps.appPool);
    if (!config) throw new HttpError(503, "Billing isn't configured yet");
    const { packageId } = req.body as { packageId?: string };
    if (!packageId) throw new HttpError(400, "packageId is required");
    const origin = appOrigin();
    const result = await createCheckoutSession(ctx.deps.appPool, config, {
      tenantId: req.orgId!, userId: req.userId!, packageId,
      successUrl: `${origin}/?settings=billing&billing=success`,
      cancelUrl: `${origin}/?settings=billing&billing=cancel`,
    });
    return reply.status(201).send(result);
  });

  // Top-level — not under /v1/orgs/:orgId. Stripe's servers call this
  // directly, before any tenant/session context exists (same reasoning as
  // the Google OAuth callback route), and it needs the RAW request body to
  // verify the signature, so it's registered in its own encapsulated
  // sub-plugin with a content-type-parser override that doesn't leak to
  // any other route on this Fastify instance.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/v1/billing/stripe/webhook", async (req, reply) => {
      const config = await loadStripeConfig(ctx.deps.appPool);
      if (!config) return reply.status(503).send({ error: "Billing isn't configured" });
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") return reply.status(400).send({ error: "Missing signature" });
      let event;
      try {
        event = verifyWebhookEvent(req.body as Buffer, signature, config);
      } catch {
        return reply.status(400).send({ error: "Invalid signature" });
      }
      if (event.type === "checkout.session.completed") {
        await handleCheckoutCompleted({ adminPool: ctx.deps.adminPool, appPool: ctx.deps.appPool }, event);
      }
      return reply.status(200).send({ received: true });
    });
  });
}
