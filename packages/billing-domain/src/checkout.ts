import type { Pool } from "pg";
import Stripe from "stripe";
import { resumeRunsWaitingPayment } from "./balance.js";
import { audit, uuidv7, withContext } from "@deedwell/database";
import type { StripeConfig } from "./stripe-config.js";
import { findPackage } from "./packages.js";
import { emailOrgAdmins, orgNameOf, userRecipient } from "@deedwell/email";

function stripeClient(config: StripeConfig): Stripe {
  return new Stripe(config.secretKey, { apiVersion: "2025-02-24.acacia" });
}

export async function createCheckoutSession(
  appPool: Pool,
  config: StripeConfig,
  args: { tenantId: string; userId: string; packageId: string; successUrl: string; cancelUrl: string }
): Promise<{ url: string }> {
  const pkg = findPackage(args.packageId);
  if (!pkg) throw new Error(`Unknown package "${args.packageId}"`);
  const stripe = stripeClient(config);

  return withContext(appPool, { tenantId: args.tenantId, userId: args.userId }, async (client) => {
    const existing = await client.query(`SELECT stripe_customer_id FROM billing_accounts WHERE tenant_id = $1`, [args.tenantId]);
    let stripeCustomerId: string | undefined = existing.rows[0]?.stripe_customer_id ?? undefined;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ metadata: { tenantId: args.tenantId } });
      stripeCustomerId = customer.id;
      await client.query(
        `INSERT INTO billing_accounts (id, tenant_id, stripe_customer_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = $3`,
        [uuidv7(), args.tenantId, stripeCustomerId]
      );
    }

    const transactionId = uuidv7();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      client_reference_id: args.tenantId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pkg.priceCents,
          product_data: { name: `${pkg.label} — ${pkg.tokens.toLocaleString()} tokens` },
        },
      }],
      metadata: { tenantId: args.tenantId, transactionId, packageId: pkg.id },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");

    await client.query(
      `INSERT INTO billing_transactions
         (id, tenant_id, created_by, package_id, token_amount, amount_cents, currency, stripe_checkout_session_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'usd',$7,'pending')`,
      [transactionId, args.tenantId, args.userId, pkg.id, pkg.tokens, pkg.priceCents, session.id]
    );

    return { url: session.url };
  });
}

export function verifyWebhookEvent(rawBody: Buffer, signature: string, config: StripeConfig): Stripe.Event {
  const stripe = stripeClient(config);
  return stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
}

/**
 * Runs the initial lookup against the admin pool — a webhook arrives as a
 * top-level HTTP call from Stripe's servers before any tenant context
 * exists, same reasoning as redeemOAuthState. Only once the transaction
 * row (and its tenant_id) is found does the actual balance credit run
 * tenant-scoped through the app pool. The guarded status transition
 * (pending -> completed, WHERE status='pending') makes this idempotent
 * against Stripe's automatic webhook retries — a second delivery of the
 * same event finds 0 rows and is a silent no-op, never a double credit.
 */
export async function handleCheckoutCompleted(
  pools: { adminPool: Pool; appPool: Pool },
  event: Stripe.Event
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const { rows } = await pools.adminPool.query(
    `UPDATE billing_transactions SET status = 'completed', completed_at = now()
     WHERE stripe_checkout_session_id = $1 AND status = 'pending'
     RETURNING id, tenant_id, token_amount, amount_cents, currency, package_id, created_by`,
    [session.id]
  );
  const row = rows[0];
  if (!row) return;

  await withContext(pools.appPool, { tenantId: row.tenant_id, userId: null }, async (client) => {
    await client.query(
      `INSERT INTO billing_accounts (id, tenant_id, token_balance) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET token_balance = billing_accounts.token_balance + $3`,
      [uuidv7(), row.tenant_id, Number(row.token_amount)]
    );
    const resumedRuns = await resumeRunsWaitingPayment(client, row.tenant_id);
    await audit(client, {
      tenantId: row.tenant_id, action: "billing.topped_up",
      entityType: "billing_transaction", entityId: row.id,
      metadata: { tokens: Number(row.token_amount), stripeSessionId: session.id },
    });
    // Receipt to every owner/admin — the purchaser included.
    const orgName = await orgNameOf(client, row.tenant_id);
    const buyer = row.created_by ? await userRecipient(client, row.created_by) : null;
    const pkg = findPackage(String(row.package_id ?? ""));
    await emailOrgAdmins(client, row.tenant_id, "topup_receipt", {
      orgName, packageName: pkg?.label ?? String(row.package_id ?? "Token pack"), tokens: Number(row.token_amount),
      amountCents: Number(row.amount_cents ?? 0), currency: String(row.currency ?? "usd"), transactionId: row.id,
      resumedRuns, purchasedBy: buyer?.displayName ?? null,
    }, { dedupe: `topup_receipt:${row.id}` });
  });
}
