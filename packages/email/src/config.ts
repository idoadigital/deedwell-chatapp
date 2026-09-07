/**
 * Everything the mailer needs from the environment, read lazily so tests and
 * one-off scripts can flip a variable before the first send. Unset
 * RESEND_API_KEY = the outbox still fills up (every event is recorded) but
 * rows are marked 'skipped' instead of sent — the same honest degrade as
 * VOICE_PROVIDER=off or MODEL_PROVIDER=mock elsewhere in the platform.
 */
export interface EmailConfig {
  apiKey: string | null;
  from: string;
  replyTo: string;
  /** Internal alerts (new signups, support requests, failures). */
  opsTo: string[];
  /** Dashboard + marketing origin — every link in an email points here. */
  appOrigin: string;
  /** Chat workspace origin (coworkers.deedwell.org). */
  coworkersOrigin: string;
  /** Publicly reachable logo for the email header. */
  logoUrl: string;
  /** HMAC key for one-click unsubscribe links. */
  unsubscribeSecret: string;
  supportEmail: string;
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const trim = (s: string | undefined) => (s ?? "").trim();
  const ops = trim(env.EMAIL_OPS_TO) || "hello@deedwell.org";
  return {
    apiKey: trim(env.RESEND_API_KEY) || null,
    from: trim(env.EMAIL_FROM) || "Deedwell <hello@deedwell.org>",
    replyTo: trim(env.EMAIL_REPLY_TO) || "hello@deedwell.org",
    opsTo: ops.split(",").map((s) => s.trim()).filter(Boolean),
    appOrigin: (trim(env.APP_ORIGIN) || "https://deedwell.org").replace(/\/+$/, ""),
    coworkersOrigin: (trim(env.API_ORIGIN) || "https://coworkers.deedwell.org").replace(/\/+$/, ""),
    logoUrl: trim(env.EMAIL_LOGO_URL) || "https://deedwell.org/assets/logo-black.png",
    unsubscribeSecret: trim(env.EMAIL_UNSUBSCRIBE_SECRET) || trim(env.SESSION_ENCRYPTION_KEY) || "deedwell-dev-unsubscribe",
    supportEmail: trim(env.EMAIL_SUPPORT) || "hello@deedwell.org",
  };
}
