import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { readPlatformCredentials, savePlatformCredentials, updateIntegrationConfiguration, currentEnvironment, TelegramAdapter, WhatsAppCloudAdapter, type MessagingChannel, type MessagingChannelAdapter } from "@deedwell/connectors";

/**
 * Adapters are built from the platform-level integration rows (Platform
 * Admin → Integrations), the same store the OAuth connectors use:
 *
 *   telegram  client_id = bot username, secret = bot token,
 *             configuration.webhookSecret (generated here on first use)
 *   whatsapp  client_id = Meta app id, secret = app secret,
 *             configuration.verifyToken (generated), configuration.embeddedSignupConfigId (optional)
 *
 * Cached briefly so a burst of webhooks does not hit the table per delivery.
 */
const TTL = 30_000;
const cache = new Map<MessagingChannel, { at: number; adapter: MessagingChannelAdapter }>();

export const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
export const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://deedwell.org";
export const webhookUrl = (channel: MessagingChannel) => `${API_ORIGIN}/v1/integrations/${channel}/webhook`;

export function invalidateAdapters(): void { cache.clear(); }

/**
 * Where the platform credentials come from, in order:
 *   1. the provider's own platform_integrations row (Platform Admin → Integrations);
 *   2. for WhatsApp, the Meta connector's row — WhatsApp is an additional use
 *      case on the same Meta app, so its App ID/secret are already on file;
 *      a `whatsapp` row is created from it once so the admin UI shows it;
 *   3. environment variables on the service (TELEGRAM_BOT_TOKEN /
 *      TELEGRAM_BOT_USERNAME, META_APP_ID / META_APP_SECRET), for deployments
 *      that inject secrets from a secret store rather than the admin UI.
 * A secret that no longer decrypts (key rotated without re-saving) must not
 * take the page down: it reads as "not configured" and is logged.
 */
async function credentials(pool: Pool, provider: MessagingChannel) {
  try {
    const own = await readPlatformCredentials(pool, provider);
    if (own) return own;
    if (provider === "whatsapp") {
      const meta = await readPlatformCredentials(pool, "meta");
      if (meta) {
        await pool.query(
          `INSERT INTO platform_integrations (id, provider, environment, client_id, encrypted_client_secret, secret_iv, secret_tag, key_version, secret_hint, configuration, status, status_detail, validated_at, configured_by)
           SELECT gen_random_uuid(), 'whatsapp', environment, client_id, encrypted_client_secret, secret_iv, secret_tag, key_version, secret_hint,
                  '{"source":"meta"}'::jsonb, 'configured', 'Using the Meta app already configured for Facebook & Instagram.', NULL, configured_by
             FROM platform_integrations WHERE provider = 'meta' AND environment = $1 AND status = 'configured'
           ON CONFLICT (provider, environment) DO NOTHING`, [meta.environment]).catch(() => undefined);
        return (await readPlatformCredentials(pool, "whatsapp")) ?? meta;
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({ at: "messaging_platform_credentials_unreadable", provider, error: (err as Error).message }));
  }
  if (provider === "telegram" && process.env.TELEGRAM_BOT_TOKEN) {
    return { clientId: process.env.TELEGRAM_BOT_USERNAME ?? "", clientSecret: process.env.TELEGRAM_BOT_TOKEN, environment: "production" as const, configuration: { fromEnv: true } };
  }
  if (provider === "whatsapp" && process.env.META_APP_ID && process.env.META_APP_SECRET) {
    return { clientId: process.env.META_APP_ID, clientSecret: process.env.META_APP_SECRET, environment: "production" as const, configuration: { fromEnv: true } };
  }
  return null;
}

/** A webhook secret that survives restarts even when there is no row to persist it in. */
const derivedSecret = (seed: string) => createHash("sha256").update(`deedwell-webhook:${seed}`).digest("hex").slice(0, 48);

export async function telegramAdapter(pool: Pool): Promise<TelegramAdapter> {
  const hit = cache.get("telegram");
  if (hit && Date.now() - hit.at < TTL) return hit.adapter as TelegramAdapter;
  const creds = await credentials(pool, "telegram");
  let adapter: TelegramAdapter;
  if (!creds) adapter = new TelegramAdapter(null);
  else {
    let secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? (typeof creds.configuration.webhookSecret === "string" ? creds.configuration.webhookSecret : "");
    if (!secret) {
      if (creds.configuration.fromEnv) secret = derivedSecret(creds.clientSecret);
      else {
        secret = randomBytes(24).toString("hex");
        await updateIntegrationConfiguration(pool, "telegram", creds.environment, { webhookSecret: secret }).catch(() => undefined);
      }
    }
    adapter = new TelegramAdapter({ botToken: creds.clientSecret, botUsername: creds.clientId || null, webhookSecret: secret });
  }
  cache.set("telegram", { at: Date.now(), adapter });
  return adapter;
}

export async function whatsappAdapter(pool: Pool): Promise<WhatsAppCloudAdapter> {
  const hit = cache.get("whatsapp");
  if (hit && Date.now() - hit.at < TTL) return hit.adapter as WhatsAppCloudAdapter;
  const creds = await credentials(pool, "whatsapp");
  let adapter: WhatsAppCloudAdapter;
  if (!creds) adapter = new WhatsAppCloudAdapter(null);
  else {
    let verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? (typeof creds.configuration.verifyToken === "string" ? creds.configuration.verifyToken : "");
    if (!verifyToken) {
      if (creds.configuration.fromEnv) verifyToken = derivedSecret(`${creds.clientId}:${creds.clientSecret}`);
      else {
        verifyToken = randomBytes(18).toString("hex");
        await updateIntegrationConfiguration(pool, "whatsapp", creds.environment, { verifyToken }).catch(() => undefined);
      }
    }
    const cfg = typeof creds.configuration.embeddedSignupConfigId === "string" && creds.configuration.embeddedSignupConfigId.trim() ? creds.configuration.embeddedSignupConfigId.trim() : null;
    adapter = new WhatsAppCloudAdapter({ appId: creds.clientId, appSecret: creds.clientSecret, verifyToken, embeddedSignupConfigId: cfg });
  }
  cache.set("whatsapp", { at: Date.now(), adapter });
  return adapter;
}

export async function adapterFor(pool: Pool, channel: MessagingChannel): Promise<MessagingChannelAdapter> {
  return channel === "telegram" ? telegramAdapter(pool) : whatsappAdapter(pool);
}

/* ---- Deedwell's own WhatsApp number ------------------------------------------
 * Customers do not bring a business number: they scan a QR that opens a chat
 * with Deedwell's number and send a prefilled pairing message. The number,
 * its business account and its permanent token are platform-level, stored
 * as the `whatsapp_sender` integration (client_id = phone number id, secret
 * = permanent token, configuration = waba id + display number). Env
 * fallback: WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_WABA_ID / WHATSAPP_ACCESS_TOKEN. */
export interface PlatformSender { phoneNumberId: string; wabaId: string | null; token: string; displayPhone: string | null; verifiedName: string | null }

let senderCache: { at: number; value: PlatformSender | null } | null = null;

export async function platformSender(pool: Pool): Promise<PlatformSender | null> {
  if (senderCache && Date.now() - senderCache.at < TTL) return senderCache.value;
  let value: PlatformSender | null = null;
  try {
    const row = await readPlatformCredentials(pool, "whatsapp_sender");
    if (row) value = { phoneNumberId: row.clientId, wabaId: (row.configuration.wabaId as string | undefined) ?? null, token: row.clientSecret, displayPhone: (row.configuration.displayPhone as string | undefined) ?? null, verifiedName: (row.configuration.verifiedName as string | undefined) ?? null };
  } catch (err) {
    console.warn(JSON.stringify({ at: "messaging_platform_sender_unreadable", error: (err as Error).message }));
  }
  if (!value && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
    value = { phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, wabaId: process.env.WHATSAPP_WABA_ID ?? null, token: process.env.WHATSAPP_ACCESS_TOKEN, displayPhone: process.env.WHATSAPP_DISPLAY_PHONE ?? null, verifiedName: null };
  }
  senderCache = { at: Date.now(), value };
  return value;
}

/** Saves the platform number after proving it against Graph. */
export async function savePlatformSender(pool: Pool, input: { phoneNumberId: string; wabaId: string | null; token: string; configuredBy: string }): Promise<PlatformSender> {
  const wa = await whatsappAdapter(pool);
  const probe = await wa.health({ channel: "whatsapp", chatId: "", accountId: input.phoneNumberId, accessToken: input.token });
  if (!probe.ok) throw new Error(`WhatsApp rejected those details: ${probe.detail ?? "the phone number id or token is wrong"}`);
  let wabaId = input.wabaId;
  if (!wabaId) wabaId = (await wa.businessAccountsFor(input.token).catch(() => []))[0] ?? null;
  if (wabaId) await wa.subscribeApp(input.token, wabaId).catch((err) => console.warn(JSON.stringify({ at: "whatsapp_subscribe_failed", error: (err as Error).message })));
  await savePlatformCredentials(pool, { provider: "whatsapp_sender", environment: currentEnvironment(), clientId: input.phoneNumberId, clientSecret: input.token, configuredBy: input.configuredBy });
  await updateIntegrationConfiguration(pool, "whatsapp_sender", currentEnvironment(), { wabaId, displayPhone: probe.facts.number ?? null, verifiedName: probe.facts.name ?? null, quality: probe.facts.quality ?? null, limit: probe.facts.limit ?? null });
  senderCache = null;
  return (await platformSender(pool))!;
}

export function invalidatePlatformSender(): void { senderCache = null; }
