import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { readPlatformCredentials, updateIntegrationConfiguration, TelegramAdapter, WhatsAppCloudAdapter, type MessagingChannel, type MessagingChannelAdapter } from "@deedwell/connectors";

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

/** A secret that no longer decrypts (key rotated without re-saving) must not take the page down. */
async function credentials(pool: Pool, provider: MessagingChannel) {
  try { return await readPlatformCredentials(pool, provider); }
  catch (err) {
    console.warn(JSON.stringify({ at: "messaging_platform_credentials_unreadable", provider, error: (err as Error).message }));
    return null;
  }
}

export async function telegramAdapter(pool: Pool): Promise<TelegramAdapter> {
  const hit = cache.get("telegram");
  if (hit && Date.now() - hit.at < TTL) return hit.adapter as TelegramAdapter;
  const creds = await credentials(pool, "telegram");
  let adapter: TelegramAdapter;
  if (!creds) adapter = new TelegramAdapter(null);
  else {
    let secret = typeof creds.configuration.webhookSecret === "string" ? creds.configuration.webhookSecret : "";
    if (!secret) {
      secret = randomBytes(24).toString("hex");
      await updateIntegrationConfiguration(pool, "telegram", creds.environment, { webhookSecret: secret }).catch(() => undefined);
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
    let verifyToken = typeof creds.configuration.verifyToken === "string" ? creds.configuration.verifyToken : "";
    if (!verifyToken) {
      verifyToken = randomBytes(18).toString("hex");
      await updateIntegrationConfiguration(pool, "whatsapp", creds.environment, { verifyToken }).catch(() => undefined);
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
