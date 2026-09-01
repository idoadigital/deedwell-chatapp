import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { decryptSecret } from "@deedwell/auth";

export { enqueueWebhookEvent } from "@deedwell/database";

const MAX_ATTEMPTS = 5;

/** Delivers a specific set of deliveries now — used by the webhook "test"
 *  endpoint, where a consumer waiting a moment for a real response is the
 *  point. Retries with the same capped exponential backoff already used for
 *  model-provider 429s (packages/agent-runtime/src/gemini-provider.ts). */
export async function deliverWebhooks(pool: Pool, deliveryIds: string[]): Promise<void> {
  await Promise.all(deliveryIds.map((id) => deliverOne(pool, id)));
}

/** Picks up whatever site.created/website.published deliveries got enqueued
 *  (transactionally, from routes-website.ts / packages/website-domain's
 *  publish gate — neither is in a position to await a slow HTTP call) since
 *  the last sweep, and delivers them. Each row is only ever picked up once:
 *  deliverOne exhausts its own retry budget before leaving a row in a
 *  terminal 'success' or 'failed' state, so overlapping sweeps can't
 *  double-attempt a row still sitting at 'pending'. */
export async function sweepPendingWebhooks(pool: Pool, limit = 25): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at LIMIT $1`,
    [limit]
  );
  const ids = (rows as { id: string }[]).map((r) => r.id);
  await deliverWebhooks(pool, ids);
  return ids.length;
}

async function deliverOne(pool: Pool, deliveryId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT d.id, d.event_type, d.payload, d.attempt_count,
            s.url, s.secret_ciphertext, s.secret_iv, s.secret_tag, s.secret_key_version
     FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  const delivery = rows[0];
  if (!delivery) return;

  const secret = decryptSecret({
    ciphertext: delivery.secret_ciphertext,
    iv: delivery.secret_iv,
    tag: delivery.secret_tag,
    keyVersion: delivery.secret_key_version,
  }).toString("utf8");

  const body = JSON.stringify({ id: delivery.id, type: delivery.event_type, data: delivery.payload });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  for (let attempt = delivery.attempt_count; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * 2 ** attempt, 20_000) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    let responseStatus: number | null = null;
    try {
      const res = await fetch(delivery.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-deedwell-signature": `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = res.status;
    } catch {
      responseStatus = null; // network error / timeout — treated the same as a failed attempt
    }
    const success = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = $2, attempt_count = $3, last_attempt_at = now(), response_status = $4
       WHERE id = $1`,
      [deliveryId, success ? "success" : "failed", attempt + 1, responseStatus]
    );
    if (success) return;
  }
}
