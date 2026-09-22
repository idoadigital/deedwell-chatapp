import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AdapterHealth, ConnectionTarget, InboundMedia, InboundMessage, InboundStatus, MessagingChannelAdapter, OutboundMessage, ParsedWebhook, SendResult,
} from "./types.js";
import { WHATSAPP_TEXT_LIMIT, chunkText, clampLabel, toPlainText } from "./render.js";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const graph = () => `${process.env.META_GRAPH_BASE ?? "https://graph.facebook.com"}/${GRAPH_VERSION}`;

/**
 * WhatsApp Business Platform (Cloud API). Platform-level: the Meta app id +
 * app secret (webhook signatures, Embedded Signup code exchange) and the
 * webhook verify token. Per connection: the business phone number id and a
 * business token, sealed in connector_connections.
 *
 * Rules honoured here rather than left to callers:
 *  - free-form messages only inside the 24-hour customer-service window;
 *    outside it the API refuses (error 131047) and we report that clearly
 *    instead of sending a chargeable template;
 *  - at most three reply buttons, titles ≤ 20 chars;
 *  - media is downloaded through the Graph media endpoint with the token,
 *    never from a URL the webhook happened to contain.
 */
export class WhatsAppCloudAdapter implements MessagingChannelAdapter {
  readonly channel = "whatsapp" as const;
  constructor(private readonly config: { appId: string; appSecret: string; verifyToken: string; embeddedSignupConfigId: string | null } | null) {}

  isConfigured(): boolean { return Boolean(this.config?.appId && this.config?.appSecret); }
  get embeddedSignupConfigId(): string | null { return this.config?.embeddedSignupConfigId ?? null; }
  get appId(): string | null { return this.config?.appId ?? null; }

  /** GET verification handshake: returns the challenge to echo, or null. */
  verifySubscription(query: Record<string, string | undefined>): string | null {
    if (!this.config) return null;
    if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === this.config.verifyToken) return query["hub.challenge"] ?? "";
    return null;
  }

  verifyWebhook({ headers, rawBody }: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): boolean {
    if (!this.config) return false;
    const got = headers["x-hub-signature-256"];
    const sig = (Array.isArray(got) ? got[0] : got) ?? "";
    if (!sig.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.config.appSecret).update(rawBody).digest("hex");
    const a = Buffer.from(sig.slice(7)); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown): ParsedWebhook {
    const out: ParsedWebhook = { messages: [], statuses: [] };
    const payload = (body ?? {}) as WaWebhook;
    if (payload.object !== "whatsapp_business_account") return out;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const v = change.value;
        const phoneNumberId = v.metadata?.phone_number_id ?? null;
        const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
        for (const m of v.messages ?? []) out.messages.push(this.fromMessage(m, phoneNumberId, names.get(m.from) ?? null));
        for (const s of v.statuses ?? []) out.statuses.push(this.fromStatus(s));
      }
    }
    return out;
  }

  private fromMessage(m: WaMessage, phoneNumberId: string | null, displayName: string | null): InboundMessage {
    let kind: InboundMessage["kind"] = "text";
    let text: string | null = null;
    let media: InboundMedia | null = null;
    let buttonPayload: string | null = null;
    switch (m.type) {
      case "text": text = m.text?.body ?? null; break;
      case "image": kind = "image"; media = { providerRef: m.image!.id, mime: m.image!.mime_type ?? "image/jpeg", filename: `image-${m.id}.jpg`, sizeBytes: null, caption: m.image!.caption ?? null }; text = m.image!.caption ?? null; break;
      case "document": kind = "document"; media = { providerRef: m.document!.id, mime: m.document!.mime_type ?? null, filename: m.document!.filename ?? `document-${m.id}`, sizeBytes: null, caption: m.document!.caption ?? null }; text = m.document!.caption ?? null; break;
      case "audio": kind = "audio"; media = { providerRef: m.audio!.id, mime: m.audio!.mime_type ?? "audio/ogg", filename: `voice-${m.id}.ogg`, sizeBytes: null, caption: null }; break;
      case "video": kind = "video"; media = { providerRef: m.video!.id, mime: m.video!.mime_type ?? "video/mp4", filename: `video-${m.id}.mp4`, sizeBytes: null, caption: m.video!.caption ?? null }; text = m.video!.caption ?? null; break;
      case "interactive": {
        kind = "button";
        buttonPayload = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? null;
        text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        break;
      }
      case "button": kind = "button"; buttonPayload = m.button?.payload ?? null; text = m.button?.text ?? null; break;
      default: kind = "unsupported";
    }
    let command: InboundMessage["command"] = null;
    if (kind === "text" && text && /^\/[a-z_]+/i.test(text.trim())) {
      const [head, ...rest] = text.trim().split(/\s+/);
      command = { name: head!.slice(1).toLowerCase(), args: rest.join(" ") };
      kind = "command";
    }
    return {
      channel: "whatsapp",
      externalMessageId: m.id,
      externalUserId: m.from,
      externalChatId: m.from,
      accountId: phoneNumberId,
      displayName,
      kind, text, buttonPayload, command, media,
      replyToExternalId: m.context?.id ?? null,
      sentAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
      raw: { type: m.type, phone_number_id: phoneNumberId, has_media: Boolean(media), text_length: text?.length ?? 0 },
    };
  }

  private fromStatus(s: WaStatus): InboundStatus {
    const status = s.status === "sent" || s.status === "delivered" || s.status === "read" || s.status === "failed" ? s.status : "sent";
    const err = s.errors?.[0];
    return {
      channel: "whatsapp", externalMessageId: s.id, status,
      error: err ? `${err.code}${err.title ? ` ${err.title}` : ""}${err.error_data?.details ? `: ${err.error_data.details}` : ""}` : null,
      at: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString(),
      raw: { conversation: s.conversation?.origin?.type ?? null, billable: s.pricing?.billable ?? null, category: s.pricing?.category ?? null },
    };
  }

  private async graph<T>(token: string, path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
    const res = await fetch(`${graph()}/${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } } }) | null;
    if (!res.ok || data?.error) {
      const e = data?.error;
      const err = new Error(`WhatsApp: ${e?.message ?? `HTTP ${res.status}`}${e?.error_data?.details ? ` — ${e.error_data.details}` : ""}`) as Error & { code?: number; subcode?: number; outsideWindow?: boolean; rateLimited?: boolean };
      err.code = e?.code ?? res.status; err.subcode = e?.error_subcode;
      err.outsideWindow = e?.code === 131047 || e?.code === 131026;
      err.rateLimited = e?.code === 130429 || e?.code === 131056 || res.status === 429;
      throw err;
    }
    return data as T;
  }

  async send(target: ConnectionTarget, message: OutboundMessage): Promise<SendResult> {
    if (!target.accessToken || !target.accountId) throw new Error("WhatsApp connection is missing its phone number or token");
    const to = target.chatId;
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
    const ctx = message.replyToExternalId ? { context: { message_id: message.replyToExternalId } } : {};
    let last: { messages?: { id: string }[] } | null = null;
    if (message.media) {
      let mediaId: string | null = null;
      let link: string | null = null;
      if ("bytes" in message.media) {
        const form = new FormData();
        form.set("messaging_product", "whatsapp");
        form.set("type", message.media.mime);
        form.set("file", new Blob([message.media.bytes], { type: message.media.mime }), message.media.filename);
        const up = await this.graph<{ id: string }>(target.accessToken, `${target.accountId}/media`, { method: "POST", form });
        mediaId = up.id;
      } else link = message.media.url;
      const isImage = /^image\/(jpeg|png)$/.test(message.media.mime);
      const type = isImage ? "image" : "document";
      const obj: Record<string, unknown> = mediaId ? { id: mediaId } : { link };
      if (message.media.caption) obj.caption = message.media.caption.slice(0, 1024);
      if (!isImage) obj.filename = message.media.filename;
      last = await this.graph(target.accessToken, `${target.accountId}/messages`, { method: "POST", body: { ...base, ...ctx, type, [type]: obj } });
    }
    const text = toPlainText(message.text);
    const chunks = text ? chunkText(text, WHATSAPP_TEXT_LIMIT) : [];
    for (let i = 0; i < chunks.length; i++) {
      const lastChunk = i === chunks.length - 1;
      if (lastChunk && message.buttons?.length) {
        const body = chunks[i]!.length > 1024 ? chunks[i]!.slice(0, 1020) + "…" : chunks[i]!;
        last = await this.graph(target.accessToken, `${target.accountId}/messages`, {
          method: "POST",
          body: { ...base, ...(i === 0 ? ctx : {}), type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: message.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: clampLabel(b.label) } })) } } },
        });
      } else {
        last = await this.graph(target.accessToken, `${target.accountId}/messages`, { method: "POST", body: { ...base, ...(i === 0 ? ctx : {}), type: "text", text: { body: chunks[i], preview_url: false } } });
      }
    }
    return { externalMessageId: last?.messages?.[0]?.id ?? null };
  }

  async markRead(target: ConnectionTarget, externalMessageId: string): Promise<void> {
    if (!target.accessToken || !target.accountId) return;
    await this.graph(target.accessToken, `${target.accountId}/messages`, { method: "POST", body: { messaging_product: "whatsapp", status: "read", message_id: externalMessageId } }).catch(() => undefined);
  }

  async downloadMedia(target: ConnectionTarget, media: InboundMedia): Promise<{ bytes: Buffer; mime: string | null; filename: string | null }> {
    if (!target.accessToken) throw new Error("WhatsApp connection is missing its token");
    const meta = await this.graph<{ url: string; mime_type?: string; file_size?: number }>(target.accessToken, media.providerRef);
    const testBase = process.env.META_GRAPH_BASE;
    if (!(testBase && meta.url.startsWith(testBase)) && !/^https:\/\/lookaside\.fbsbx\.com\//.test(meta.url) && !/^https:\/\/[a-z0-9.-]+\.facebook\.com\//.test(meta.url) && !/^https:\/\/[a-z0-9.-]+\.whatsapp\.net\//.test(meta.url)) {
      throw new Error("WhatsApp returned a media URL outside Meta's domains");
    }
    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${target.accessToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`WhatsApp media download failed (${res.status})`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type ?? media.mime ?? res.headers.get("content-type"), filename: media.filename };
  }

  async health(target: ConnectionTarget | null): Promise<AdapterHealth> {
    if (!this.config) return { ok: false, detail: "Meta app not configured", facts: {} };
    if (!target?.accessToken || !target.accountId) return { ok: true, detail: null, facts: {} };
    try {
      const p = await this.graph<{ display_phone_number?: string; verified_name?: string; quality_rating?: string; code_verification_status?: string; name_status?: string; messaging_limit_tier?: string; platform_type?: string }>(
        target.accessToken, `${target.accountId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier,platform_type`,
      );
      return { ok: true, detail: null, facts: { number: p.display_phone_number ?? null, name: p.verified_name ?? null, quality: p.quality_rating ?? null, verification: p.code_verification_status ?? null, limit: p.messaging_limit_tier ?? null } };
    } catch (err) { return { ok: false, detail: (err as Error).message, facts: {} }; }
  }

  /** Subscribes the app to the WABA's webhooks (needed once per business account). */
  async subscribeApp(token: string, wabaId: string): Promise<void> {
    await this.graph(token, `${wabaId}/subscribed_apps`, { method: "POST", body: {} });
  }

  /** Phone numbers under a business account, for the picker after Embedded Signup. */
  async listPhoneNumbers(token: string, wabaId: string): Promise<{ id: string; display: string; name: string | null; quality: string | null }[]> {
    const r = await this.graph<{ data?: { id: string; display_phone_number: string; verified_name?: string; quality_rating?: string }[] }>(token, `${wabaId}/phone_numbers`);
    return (r.data ?? []).map((p) => ({ id: p.id, display: p.display_phone_number, name: p.verified_name ?? null, quality: p.quality_rating ?? null }));
  }

  /** Embedded Signup: the browser's code → a business token for the customer's WABA. */
  async exchangeCode(code: string): Promise<{ accessToken: string }> {
    if (!this.config) throw new Error("Meta app not configured");
    const url = new URL(`${graph()}/oauth/access_token`);
    url.searchParams.set("client_id", this.config.appId);
    url.searchParams.set("client_secret", this.config.appSecret);
    url.searchParams.set("code", code);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = (await res.json().catch(() => null)) as { access_token?: string; error?: { message?: string } } | null;
    if (!res.ok || !data?.access_token) throw new Error(`Meta code exchange failed: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    return { accessToken: data.access_token };
  }

  /** Which business accounts a token can see (debug_token shares → granular_scopes). */
  async businessAccountsFor(token: string): Promise<string[]> {
    if (!this.config) return [];
    const url = new URL(`${graph()}/debug_token`);
    url.searchParams.set("input_token", token);
    url.searchParams.set("access_token", `${this.config.appId}|${this.config.appSecret}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = (await res.json().catch(() => null)) as { data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] } } | null;
    const ids = new Set<string>();
    for (const g of data?.data?.granular_scopes ?? []) if (/whatsapp_business/.test(g.scope)) for (const id of g.target_ids ?? []) ids.add(id);
    return [...ids];
  }
}

/* ---- the slice of the webhook we read ------------------------------------------ */
interface WaMedia { id: string; mime_type?: string; caption?: string; filename?: string; sha256?: string }
interface WaMessage {
  id: string; from: string; timestamp?: string; type: string;
  text?: { body?: string }; image?: WaMedia; document?: WaMedia; audio?: WaMedia; video?: WaMedia;
  interactive?: { type?: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  context?: { id?: string; from?: string };
}
interface WaStatus {
  id: string; status: string; timestamp?: string; recipient_id?: string;
  conversation?: { id?: string; origin?: { type?: string } }; pricing?: { billable?: boolean; category?: string };
  errors?: { code: number; title?: string; error_data?: { details?: string } }[];
}
interface WaWebhook {
  object?: string;
  entry?: { id: string; changes?: { field: string; value: { metadata?: { phone_number_id?: string; display_phone_number?: string }; contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[];
}
