import { timingSafeEqual } from "node:crypto";
import type {
  AdapterHealth, ConnectionTarget, InboundMedia, InboundMessage, MessagingChannelAdapter, OutboundMessage, ParsedWebhook, SendResult,
} from "./types.js";
import { TELEGRAM_TEXT_LIMIT, chunkText, toTelegramHtml, toPlainText } from "./render.js";

/** Overridable for tests and staging; production talks to Telegram directly. */
export const telegramApiBase = () => process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

/**
 * Telegram Bot API. One platform bot (token in platform_integrations); each
 * customer connection is a chat id paired through a signed /start token. The
 * webhook is registered with a secret token that Telegram echoes in
 * X-Telegram-Bot-Api-Secret-Token on every delivery.
 */
export class TelegramAdapter implements MessagingChannelAdapter {
  readonly channel = "telegram" as const;
  constructor(private readonly config: { botToken: string; botUsername: string | null; webhookSecret: string } | null) {}

  isConfigured(): boolean { return Boolean(this.config?.botToken); }

  private api(method: string): string { return `${telegramApiBase()}/bot${this.config!.botToken}/${method}`; }
  private fileUrl(path: string): string { return `${telegramApiBase()}/file/bot${this.config!.botToken}/${path}`; }

  private async call<T>(method: string, body?: unknown, form?: FormData): Promise<T> {
    if (!this.config) throw new Error("Telegram is not configured");
    const res = await fetch(this.api(method), {
      method: "POST",
      headers: form ? undefined : { "content-type": "application/json" },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!res.ok || !data?.ok) {
      const err = new Error(`Telegram ${method}: ${data?.description ?? `HTTP ${res.status}`}`) as Error & { code?: number; retryAfter?: number };
      err.code = data?.error_code ?? res.status;
      const ra = (data as { parameters?: { retry_after?: number } } | null)?.parameters?.retry_after;
      if (ra) err.retryAfter = ra;
      throw err;
    }
    return data.result as T;
  }

  verifyWebhook({ headers }: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): boolean {
    if (!this.config) return false;
    const got = headers["x-telegram-bot-api-secret-token"];
    const token = Array.isArray(got) ? got[0] : got;
    if (!token || token.length !== this.config.webhookSecret.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.config.webhookSecret));
  }

  parseWebhook(body: unknown): ParsedWebhook {
    const update = (body ?? {}) as TgUpdate;
    const out: ParsedWebhook = { messages: [], statuses: [] };
    const msg = update.message ?? update.edited_message ?? null;
    if (msg && msg.from && !msg.from.is_bot) out.messages.push(this.fromMessage(msg, update.update_id));
    if (update.callback_query?.from) {
      const cq = update.callback_query;
      const chat = cq.message?.chat;
      out.messages.push({
        channel: "telegram",
        externalMessageId: `cb:${cq.id}`,
        externalUserId: String(cq.from.id),
        externalChatId: String(chat?.id ?? cq.from.id),
        accountId: null,
        displayName: nameOf(cq.from),
        kind: "button",
        text: null,
        buttonPayload: cq.data ?? null,
        command: null,
        media: null,
        replyToExternalId: cq.message ? String(cq.message.message_id) : null,
        sentAt: new Date().toISOString(),
        raw: { update_id: update.update_id, callback_query_id: cq.id, data: cq.data ?? null, message_id: cq.message?.message_id ?? null },
      });
    }
    return out;
  }

  private fromMessage(m: TgMessage, updateId: number): InboundMessage {
    const from = m.from!;
    const text = m.text ?? m.caption ?? null;
    let kind: InboundMessage["kind"] = "text";
    let media: InboundMedia | null = null;
    if (m.photo?.length) {
      const best = [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
      kind = "image"; media = { providerRef: best.file_id, mime: "image/jpeg", filename: `photo-${m.message_id}.jpg`, sizeBytes: best.file_size ?? null, caption: m.caption ?? null };
    } else if (m.document) {
      kind = "document"; media = { providerRef: m.document.file_id, mime: m.document.mime_type ?? null, filename: m.document.file_name ?? `file-${m.message_id}`, sizeBytes: m.document.file_size ?? null, caption: m.caption ?? null };
    } else if (m.voice) {
      kind = "audio"; media = { providerRef: m.voice.file_id, mime: m.voice.mime_type ?? "audio/ogg", filename: `voice-${m.message_id}.ogg`, sizeBytes: m.voice.file_size ?? null, caption: m.caption ?? null };
    } else if (m.audio) {
      kind = "audio"; media = { providerRef: m.audio.file_id, mime: m.audio.mime_type ?? "audio/mpeg", filename: m.audio.file_name ?? `audio-${m.message_id}.mp3`, sizeBytes: m.audio.file_size ?? null, caption: m.caption ?? null };
    } else if (m.video || m.video_note) {
      kind = "video"; const v = (m.video ?? m.video_note)!; media = { providerRef: v.file_id, mime: (m.video?.mime_type) ?? "video/mp4", filename: `video-${m.message_id}.mp4`, sizeBytes: v.file_size ?? null, caption: m.caption ?? null };
    } else if (!text) {
      kind = "unsupported";
    }
    let command: InboundMessage["command"] = null;
    if (text && /^\/[a-z_]+/i.test(text) && (m.entities ?? []).some((e) => e.type === "bot_command" && e.offset === 0)) {
      const [head, ...rest] = text.split(/\s+/);
      command = { name: head!.slice(1).replace(/@.*$/, "").toLowerCase(), args: rest.join(" ") };
      kind = "command";
    }
    return {
      channel: "telegram",
      externalMessageId: `${m.chat.id}:${m.message_id}`,
      externalUserId: String(from.id),
      externalChatId: String(m.chat.id),
      accountId: null,
      displayName: nameOf(from),
      kind, text, buttonPayload: null, command, media,
      replyToExternalId: m.reply_to_message ? `${m.chat.id}:${m.reply_to_message.message_id}` : null,
      sentAt: new Date((m.date ?? Date.now() / 1000) * 1000).toISOString(),
      raw: { update_id: updateId, message_id: m.message_id, chat_type: m.chat.type, username: from.username ?? null, has_media: Boolean(media), text_length: text?.length ?? 0 },
    };
  }

  async send(target: ConnectionTarget, message: OutboundMessage): Promise<SendResult> {
    const chat_id = target.chatId;
    const replyTo = message.replyToExternalId?.includes(":") ? Number(message.replyToExternalId.split(":")[1]) : undefined;
    let last: { message_id: number } | null = null;
    if (message.media) {
      const isImage = /^image\//.test(message.media.mime) && !/gif/.test(message.media.mime);
      const method = isImage ? "sendPhoto" : "sendDocument";
      const field = isImage ? "photo" : "document";
      const form = new FormData();
      form.set("chat_id", chat_id);
      if (message.media.caption) form.set("caption", message.media.caption.slice(0, 1024));
      if ("bytes" in message.media) form.set(field, new Blob([message.media.bytes], { type: message.media.mime }), message.media.filename);
      else form.set(field, message.media.url);
      last = await this.call<{ message_id: number }>(method, undefined, form);
    }
    const html = toTelegramHtml(message.text);
    const chunks = html ? chunkText(html, TELEGRAM_TEXT_LIMIT) : [];
    for (let i = 0; i < chunks.length; i++) {
      const lastChunk = i === chunks.length - 1;
      const body: Record<string, unknown> = { chat_id, text: chunks[i], parse_mode: "HTML", disable_web_page_preview: true };
      if (replyTo && i === 0) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      if (lastChunk && message.buttons?.length) body.reply_markup = { inline_keyboard: [message.buttons.map((b) => ({ text: b.label, callback_data: b.id.slice(0, 64) }))] };
      try {
        last = await this.call<{ message_id: number }>("sendMessage", body);
      } catch (err) {
        // Malformed HTML from an unusual body: fall back to plain text rather than dropping the reply.
        if (/parse entities|can't parse/i.test((err as Error).message)) {
          last = await this.call<{ message_id: number }>("sendMessage", { ...body, text: toPlainText(chunkText(message.text, TELEGRAM_TEXT_LIMIT)[i] ?? ""), parse_mode: undefined });
        } else throw err;
      }
    }
    return { externalMessageId: last ? `${chat_id}:${last.message_id}` : null };
  }

  async downloadMedia(_target: ConnectionTarget, media: InboundMedia): Promise<{ bytes: Buffer; mime: string | null; filename: string | null }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: media.providerRef });
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    const res = await fetch(this.fileUrl(file.file_path), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, mime: media.mime ?? res.headers.get("content-type"), filename: media.filename ?? file.file_path.split("/").pop() ?? null };
  }

  async acknowledgeButton(_target: ConnectionTarget, raw: Record<string, unknown>): Promise<void> {
    const id = raw.callback_query_id;
    if (typeof id === "string") await this.call("answerCallbackQuery", { callback_query_id: id }).catch(() => undefined);
  }

  async health(_target: ConnectionTarget | null = null): Promise<AdapterHealth> {
    if (!this.config) return { ok: false, detail: "Telegram bot token not configured", facts: {} };
    try {
      const me = await this.call<{ username?: string; first_name?: string; id: number }>("getMe");
      const wh = await this.call<{ url?: string; pending_update_count?: number; last_error_message?: string; last_error_date?: number }>("getWebhookInfo");
      return {
        ok: Boolean(wh.url), detail: wh.url ? (wh.last_error_message ? `Last webhook error: ${wh.last_error_message}` : null) : "Webhook is not registered",
        facts: { bot: me.username ? `@${me.username}` : me.first_name ?? String(me.id), webhook: wh.url ?? null, pending: wh.pending_update_count ?? 0 },
      };
    } catch (err) { return { ok: false, detail: (err as Error).message, facts: {} }; }
  }

  /** Registers (or moves) the webhook. Called when the platform token is saved. */
  async setWebhook(url: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: this.config!.webhookSecret, allowed_updates: ["message", "edited_message", "callback_query"], drop_pending_updates: false });
  }

  async getMe(): Promise<{ id: number; username: string | null; name: string }> {
    const me = await this.call<{ id: number; username?: string; first_name?: string }>("getMe");
    return { id: me.id, username: me.username ?? null, name: me.first_name ?? "Deedwell" };
  }

  /** Deep link that opens the bot with the pairing token. */
  startLink(token: string): string | null {
    return this.config?.botUsername ? `https://t.me/${this.config.botUsername}?start=${encodeURIComponent(token)}` : null;
  }
}

function nameOf(u: { first_name?: string; last_name?: string; username?: string }): string | null {
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return n || (u.username ? `@${u.username}` : null);
}

/* ---- the slice of the Bot API we read ---------------------------------------- */
interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgFile { file_id: string; file_size?: number; mime_type?: string; file_name?: string }
interface TgMessage {
  message_id: number; date?: number; chat: { id: number; type: string }; from?: TgUser; text?: string; caption?: string;
  entities?: { type: string; offset: number; length: number }[];
  photo?: TgFile[]; document?: TgFile; voice?: TgFile; audio?: TgFile; video?: TgFile; video_note?: TgFile;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number; message?: TgMessage; edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}
