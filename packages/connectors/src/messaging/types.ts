/**
 * External conversational channels (WhatsApp, Telegram, later Slack/SMS…) as
 * interfaces into the existing Deedwell agent runtime.
 *
 * An adapter knows one provider's wire format and nothing about Deedwell:
 * it turns a webhook body into InboundMessage[] and an OutboundMessage into
 * provider calls. The gateway in apps/api owns identity, tenancy, the
 * conversation and the agent runtime. Keeping that line means a new channel
 * is one file here plus a registry entry.
 */

export type MessagingChannel = "telegram" | "whatsapp";

export type InboundKind = "text" | "image" | "document" | "audio" | "video" | "button" | "command" | "unsupported";

/** One message from a person, normalised across providers. */
export interface InboundMessage {
  channel: MessagingChannel;
  /** Provider's id for the message — the idempotency key. */
  externalMessageId: string;
  /** Provider's id for the person (Telegram user id, WhatsApp phone in E.164 digits). */
  externalUserId: string;
  /** Where replies go (Telegram chat id, WhatsApp phone number id + recipient). */
  externalChatId: string;
  /** For WhatsApp: the business phone number id that received the message; identifies the connection. */
  accountId: string | null;
  displayName: string | null;
  kind: InboundKind;
  text: string | null;
  /** A pressed button's payload, e.g. "approve:<approvalId>". */
  buttonPayload: string | null;
  /** For a slash command: name without the slash and the remaining argument text. */
  command: { name: string; args: string } | null;
  media: InboundMedia | null;
  /** The provider's id of the message this one replies to, when the person replied to one. */
  replyToExternalId: string | null;
  sentAt: string;
  /** Redacted copy of the provider payload, for diagnostics. */
  raw: Record<string, unknown>;
}

export interface InboundMedia {
  /** Provider handle to download the bytes with (Telegram file_id, WhatsApp media id). */
  providerRef: string;
  mime: string | null;
  filename: string | null;
  sizeBytes: number | null;
  caption: string | null;
}

/** Delivery/read/error reports for messages Deedwell sent. */
export interface InboundStatus {
  channel: MessagingChannel;
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
  at: string;
  raw: Record<string, unknown>;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: InboundStatus[];
}

export interface OutboundButton { id: string; label: string }

export interface OutboundMessage {
  text: string;
  /** Up to three quick-reply buttons (WhatsApp's limit; Telegram takes more but three keeps parity). */
  buttons?: OutboundButton[];
  /** A file to attach; sent as image/document depending on the mime. */
  media?: { bytes: Buffer; mime: string; filename: string; caption?: string } | { url: string; mime: string; filename: string; caption?: string };
  /** Provider id of the message being replied to, for threading where supported. */
  replyToExternalId?: string | null;
}

export interface SendResult { externalMessageId: string | null; raw?: Record<string, unknown> }

export interface ConnectionTarget {
  channel: MessagingChannel;
  /** Telegram chat id; WhatsApp recipient phone (digits). */
  chatId: string;
  /** WhatsApp phone number id; unused for Telegram. */
  accountId: string | null;
  /** Sealed credential for this connection (WhatsApp business token). Telegram uses the platform bot token. */
  accessToken: string | null;
}

export interface AdapterHealth {
  ok: boolean;
  detail: string | null;
  /** Provider facts worth showing (bot username, business number quality rating…). */
  facts: Record<string, string | number | boolean | null>;
}

export interface MessagingChannelAdapter {
  readonly channel: MessagingChannel;
  /** True when the platform-level credential exists (bot token / app secret). */
  isConfigured(): boolean;
  /** Authenticates a webhook delivery. `rawBody` is the exact bytes received. */
  verifyWebhook(args: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer; query?: Record<string, string> }): boolean;
  parseWebhook(body: unknown): ParsedWebhook;
  send(target: ConnectionTarget, message: OutboundMessage): Promise<SendResult>;
  /** Fetches inbound media bytes. The gateway validates mime and size before storing. */
  downloadMedia(target: ConnectionTarget, media: InboundMedia): Promise<{ bytes: Buffer; mime: string | null; filename: string | null }>;
  /** Acknowledge a button press so the client stops its spinner (Telegram); no-op elsewhere. */
  acknowledgeButton?(target: ConnectionTarget, raw: Record<string, unknown>): Promise<void>;
  health(target: ConnectionTarget | null): Promise<AdapterHealth>;
}

/* ---- shared limits --------------------------------------------------------- */

export const MEDIA_MAX_BYTES = 8_000_000; // matches the chat upload limit
export const MEDIA_ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "text/markdown",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/wav", "audio/x-wav", "audio/webm",
]);

export function mediaAllowed(mime: string | null, size: number | null): { ok: boolean; reason: string | null } {
  if (!mime) return { ok: false, reason: "The file type could not be determined." };
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_ALLOWED_MIME.has(base)) return { ok: false, reason: `Files of type ${base} are not accepted here. Send images, PDFs, Office documents, text or voice notes.` };
  if (size !== null && size > MEDIA_MAX_BYTES) return { ok: false, reason: "Files over 8 MB are not accepted here — please upload it in Deedwell instead." };
  return { ok: true, reason: null };
}
