/**
 * Durable outbox: every email is first a row (written inside the same
 * transaction as the event that caused it, so a crash between "task
 * completed" and "email sent" loses nothing), then delivered by a periodic
 * sweep with capped retries — the same shape as webhook_deliveries.
 */
import type { Pool, PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";
import { emailConfig, type EmailConfig } from "./config.js";
import { renderEmail } from "./layout.js";
import { createResendSender, ResendError, type ResendSender } from "./resend.js";
import { EMAIL_CATEGORY, renderTemplate, type EmailKind, type EmailPayloads } from "./templates.js";
import { unsubscribeUrl } from "./unsubscribe.js";

export type Queryable = Pick<PoolClient, "query">;

export interface EnqueueEmailInput<K extends EmailKind> {
  kind: K;
  payload: EmailPayloads[K];
  to: string;
  tenantId?: string | null;
  userId?: string | null;
  /** Same key twice = second insert is a no-op. Bake a time bucket into it
   *  for "at most once per day" semantics. */
  dedupeKey?: string | null;
}

/** Returns the outbox row id, or null when dedupeKey already existed. */
export async function enqueueEmail<K extends EmailKind>(client: Queryable, input: EnqueueEmailInput<K>): Promise<string | null> {
  const to = input.to.trim();
  if (!to || !to.includes("@")) return null;
  const id = uuidv7();
  const { rowCount } = await client.query(
    `INSERT INTO email_outbox (id, tenant_id, user_id, to_email, kind, category, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [id, input.tenantId ?? null, input.userId ?? null, to, input.kind, EMAIL_CATEGORY[input.kind],
     JSON.stringify(input.payload), input.dedupeKey ?? null]
  );
  return rowCount ? id : null;
}

const MAX_ATTEMPTS = 5;
const STALE_SENDING_MINUTES = 5;

export interface SweepOptions {
  sender?: ResendSender | null;
  config?: EmailConfig;
  limit?: number;
  log?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}

export interface SweepResult { sent: number; failed: number; skipped: number; retried: number }

let warnedUnconfigured = false;

/** Picks up due 'pending' rows (SKIP LOCKED — several API instances may
 *  sweep concurrently), renders each and hands it to Resend. */
export async function sweepEmailOutbox(pool: Pool, opts: SweepOptions = {}): Promise<SweepResult> {
  const cfg = opts.config ?? emailConfig();
  const sender = opts.sender === undefined ? (cfg.apiKey ? createResendSender(cfg.apiKey) : null) : opts.sender;
  const result: SweepResult = { sent: 0, failed: 0, skipped: 0, retried: 0 };

  // A row stuck in 'sending' means an instance died mid-send; give it back.
  await pool.query(
    `UPDATE email_outbox SET status = 'pending' WHERE status = 'sending' AND updated_at < now() - make_interval(mins => $1)`,
    [STALE_SENDING_MINUTES]
  );

  const claimed = await pool.query(
    `UPDATE email_outbox SET status = 'sending', attempt_count = attempt_count + 1
      WHERE id IN (
        SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, user_id, to_email, kind, category, payload, attempt_count`,
    [opts.limit ?? 25]
  );

  for (const row of claimed.rows as Array<{ id: string; tenant_id: string | null; user_id: string | null; to_email: string; kind: EmailKind; category: string; payload: Record<string, unknown>; attempt_count: number }>) {
    const finish = (status: "sent" | "failed" | "skipped", extra: { error?: string | null; messageId?: string | null }) =>
      pool.query(
        `UPDATE email_outbox SET status = $2, last_error = $3, provider_message_id = COALESCE($4, provider_message_id),
                sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
        [row.id, status, extra.error ?? null, extra.messageId ?? null]
      );
    try {
      if (row.category === "activity" && row.user_id) {
        const pref = await pool.query("SELECT email_activity_opt_out, suspended_at FROM users WHERE id = $1", [row.user_id]);
        if (pref.rows[0]?.email_activity_opt_out || pref.rows[0]?.suspended_at) {
          await finish("skipped", { error: pref.rows[0]?.suspended_at ? "user suspended" : "user opted out of activity email" });
          result.skipped++;
          continue;
        }
      }
      if (!sender) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          opts.log?.warn({ at: "email.unconfigured" }, "RESEND_API_KEY is not set — outbox rows are recorded but not sent");
        }
        await finish("skipped", { error: "RESEND_API_KEY not set" });
        result.skipped++;
        continue;
      }
      const doc = renderTemplate(row.kind, row.payload as never, cfg);
      const unsub = row.category === "activity" && row.user_id ? unsubscribeUrl(cfg, row.user_id) : null;
      const { html, text } = renderEmail({ ...doc, unsubscribeUrl: unsub }, cfg);
      const { id: messageId } = await sender.send({
        from: cfg.from,
        to: [row.to_email],
        subject: doc.subject,
        html,
        text,
        replyTo: cfg.replyTo,
        headers: {
          "X-Entity-Ref-ID": row.id,
          ...(unsub ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
        },
        tags: [{ name: "kind", value: row.kind }, { name: "category", value: row.category }],
      });
      await finish("sent", { messageId });
      result.sent++;
      opts.log?.info({ at: "email.sent", id: row.id, kind: row.kind, to: row.to_email, messageId }, "email sent");
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      const permanent = err instanceof ResendError && err.permanent;
      const giveUp = permanent || row.attempt_count >= MAX_ATTEMPTS;
      if (giveUp) {
        await finish("failed", { error: message });
        result.failed++;
        opts.log?.error({ at: "email.failed", id: row.id, kind: row.kind, to: row.to_email, attempts: row.attempt_count, err: message }, "email failed");
      } else {
        const backoffMs = Math.min(30_000 * 2 ** (row.attempt_count - 1), 15 * 60_000);
        await pool.query(
          `UPDATE email_outbox SET status = 'pending', last_error = $2,
                  next_attempt_at = now() + make_interval(secs => $3 / 1000.0) WHERE id = $1`,
          [row.id, message, backoffMs]
        );
        result.retried++;
        opts.log?.warn({ at: "email.retry", id: row.id, kind: row.kind, attempts: row.attempt_count, err: message }, "email send failed, will retry");
      }
    }
  }
  return result;
}
