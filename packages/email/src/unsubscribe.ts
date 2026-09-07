import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailConfig } from "./config.js";

/** Stateless one-click opt-out: the link carries the user id and an HMAC of
 *  it, so no token table is needed and the link never expires. Only
 *  'activity' emails honour it — account, billing and security mail can't be
 *  opted out of. */
export function unsubscribeToken(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`unsubscribe:${userId}`).digest("base64url").slice(0, 32);
}

export function verifyUnsubscribeToken(userId: string, token: string, secret: string): boolean {
  const expected = unsubscribeToken(userId, secret);
  if (expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

export function unsubscribeUrl(cfg: Pick<EmailConfig, "coworkersOrigin" | "unsubscribeSecret">, userId: string): string {
  return `${cfg.coworkersOrigin}/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId, cfg.unsubscribeSecret)}`;
}
