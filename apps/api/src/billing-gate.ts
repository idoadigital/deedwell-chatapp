import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { getBalance, loadStripeConfig } from "@deedwell/billing-domain";
import { HttpError, type AppContext } from "./app.js";

/**
 * The paywall, in one place.
 *
 * An organization can spend when billing is not configured at all (nothing
 * to buy, so nothing is gated — same graceful degradation as every other
 * "not configured yet" feature), when a platform admin has marked it exempt
 * (staff and testers), or when its prepaid balance is above zero. Every
 * model call debits that balance through the usage_ledger trigger, so the
 * balance is the single source of truth for "have they paid".
 */
export interface BillingState {
  configured: boolean;
  exempt: boolean;
  tokenBalance: number;
  /** True when paid features must refuse to start. */
  blocked: boolean;
}

export const PAYMENT_REQUIRED_MESSAGE =
  "You're out of tokens. Add tokens in Settings → Billing to keep your team working.";

export async function billingState(client: Pool | PoolClient, tenantId: string): Promise<BillingState> {
  const [config, tokenBalance, org] = await Promise.all([
    loadStripeConfig(client),
    getBalance(client, tenantId),
    client.query(`SELECT billing_exempt FROM organizations WHERE id = $1`, [tenantId]),
  ]);
  const configured = config !== null;
  const exempt = Boolean(org.rows[0]?.billing_exempt);
  return { configured, exempt, tokenBalance, blocked: configured && !exempt && tokenBalance <= 0 };
}

/** Route guard: 402 with `code: "payment_required"` when the org cannot spend. */
export async function requireTokens(ctx: AppContext, req: FastifyRequest): Promise<BillingState> {
  const state = await ctx.inOrg(req, (client) => billingState(client, req.orgId!));
  if (state.blocked) {
    throw new HttpError(402, PAYMENT_REQUIRED_MESSAGE, { code: "payment_required", tokenBalance: state.tokenBalance });
  }
  return state;
}

/** For the workflow engine: may this tenant's runs keep consuming tokens? */
export function canSpendChecker(adminPool: Pool): (tenantId: string) => Promise<boolean> {
  return async (tenantId) => !(await billingState(adminPool, tenantId)).blocked;
}
