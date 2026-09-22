import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "./telegram.js";
import { WhatsAppCloudAdapter } from "./whatsapp.js";
import { approvalButtons, buttonToText, chunkText, toPlainText, toTelegramHtml } from "./render.js";
import { mediaAllowed } from "./types.js";

const tg = new TelegramAdapter({ botToken: "123:abc", botUsername: "deedwell_bot", webhookSecret: "s3cret-token" });
const wa = new WhatsAppCloudAdapter({ appId: "1", appSecret: "app-secret", verifyToken: "verify-me", embeddedSignupConfigId: null });

describe("Telegram adapter", () => {
  it("verifies the secret token header in constant time", () => {
    expect(tg.verifyWebhook({ headers: { "x-telegram-bot-api-secret-token": "s3cret-token" }, rawBody: Buffer.alloc(0) })).toBe(true);
    expect(tg.verifyWebhook({ headers: { "x-telegram-bot-api-secret-token": "s3cret-tokeX" }, rawBody: Buffer.alloc(0) })).toBe(false);
    expect(tg.verifyWebhook({ headers: {}, rawBody: Buffer.alloc(0) })).toBe(false);
  });
  it("parses a text message, a /start command and a reply", () => {
    const base = { update_id: 10, message: { message_id: 55, date: 1_700_000_000, chat: { id: 987, type: "private" }, from: { id: 42, first_name: "Sam", last_name: "Lee", username: "sam" } } };
    const t = tg.parseWebhook({ ...base, message: { ...base.message, text: "Research our competitors" } }).messages[0]!;
    expect(t).toMatchObject({ channel: "telegram", externalMessageId: "987:55", externalUserId: "42", externalChatId: "987", kind: "text", text: "Research our competitors", displayName: "Sam Lee" });
    const c = tg.parseWebhook({ ...base, message: { ...base.message, text: "/start abc.def", entities: [{ type: "bot_command", offset: 0, length: 6 }] } }).messages[0]!;
    expect(c.kind).toBe("command"); expect(c.command).toEqual({ name: "start", args: "abc.def" });
    const r = tg.parseWebhook({ ...base, message: { ...base.message, text: "yes", reply_to_message: { message_id: 50 } } }).messages[0]!;
    expect(r.replyToExternalId).toBe("987:50");
  });
  it("parses photos (largest size), documents and voice notes", () => {
    const m = (extra: object) => ({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 9, first_name: "A" }, ...extra } });
    const photo = tg.parseWebhook(m({ photo: [{ file_id: "small", file_size: 100 }, { file_id: "big", file_size: 9000 }], caption: "our logo" })).messages[0]!;
    expect(photo.kind).toBe("image"); expect(photo.media?.providerRef).toBe("big"); expect(photo.text).toBe("our logo");
    const doc = tg.parseWebhook(m({ document: { file_id: "d1", mime_type: "application/pdf", file_name: "grant.pdf", file_size: 2048 } })).messages[0]!;
    expect(doc.kind).toBe("document"); expect(doc.media?.filename).toBe("grant.pdf");
    const voice = tg.parseWebhook(m({ voice: { file_id: "v1", mime_type: "audio/ogg", file_size: 512 } })).messages[0]!;
    expect(voice.kind).toBe("audio");
  });
  it("parses a button press as a callback with the message it belongs to", () => {
    const p = tg.parseWebhook({ update_id: 3, callback_query: { id: "cbq1", from: { id: 42, first_name: "Sam" }, data: "approve:ap-1", message: { message_id: 77, chat: { id: 987, type: "private" } } } }).messages[0]!;
    expect(p).toMatchObject({ kind: "button", buttonPayload: "approve:ap-1", externalMessageId: "cb:cbq1", externalChatId: "987", replyToExternalId: "77" });
  });
  it("ignores messages from bots", () => {
    expect(tg.parseWebhook({ update_id: 4, message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 2, is_bot: true, first_name: "X" }, text: "hi" } }).messages).toHaveLength(0);
  });
  it("builds the pairing deep link", () => {
    expect(tg.startLink("tok en")).toBe("https://t.me/deedwell_bot?start=tok%20en");
  });
});

describe("WhatsApp adapter", () => {
  it("answers the subscription handshake only with the right verify token", () => {
    expect(wa.verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" })).toBe("12345");
    expect(wa.verifySubscription({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "12345" })).toBeNull();
  });
  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");
    expect(wa.verifyWebhook({ headers: { "x-hub-signature-256": sig }, rawBody: raw })).toBe(true);
    expect(wa.verifyWebhook({ headers: { "x-hub-signature-256": sig }, rawBody: Buffer.from("tampered") })).toBe(false);
  });
  const envelope = (value: object) => ({ object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: "PN1" }, ...value } }] }] });
  it("parses text, media, interactive replies and statuses", () => {
    const parsed = wa.parseWebhook(envelope({
      contacts: [{ wa_id: "14155550100", profile: { name: "Sam" } }],
      messages: [
        { id: "wamid.1", from: "14155550100", timestamp: "1700000000", type: "text", text: { body: "Good morning" } },
        { id: "wamid.2", from: "14155550100", timestamp: "1700000001", type: "document", document: { id: "media9", mime_type: "application/pdf", filename: "budget.pdf", caption: "our budget" } },
        { id: "wamid.3", from: "14155550100", timestamp: "1700000002", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "approve:ap-1", title: "Approve" } }, context: { id: "wamid.out1" } },
        { id: "wamid.4", from: "14155550100", timestamp: "1700000003", type: "audio", audio: { id: "media10", mime_type: "audio/ogg; codecs=opus" } },
      ],
      statuses: [{ id: "wamid.out1", status: "delivered", timestamp: "1700000004", recipient_id: "14155550100", conversation: { origin: { type: "service" } }, pricing: { billable: false, category: "service" } }],
    }));
    expect(parsed.messages.map((m) => m.kind)).toEqual(["text", "document", "button", "audio"]);
    expect(parsed.messages[0]).toMatchObject({ externalUserId: "14155550100", accountId: "PN1", displayName: "Sam", text: "Good morning" });
    expect(parsed.messages[1]!.media).toMatchObject({ providerRef: "media9", mime: "application/pdf", filename: "budget.pdf" });
    expect(parsed.messages[2]).toMatchObject({ buttonPayload: "approve:ap-1", replyToExternalId: "wamid.out1" });
    expect(parsed.statuses[0]).toMatchObject({ externalMessageId: "wamid.out1", status: "delivered", raw: { billable: false, category: "service" } });
  });
  it("ignores other webhook objects", () => {
    expect(wa.parseWebhook({ object: "page", entry: [] }).messages).toHaveLength(0);
  });
});

describe("rendering", () => {
  it("flattens markdown for WhatsApp and keeps structure", () => {
    expect(toPlainText("## Summary\n\nI found **three** competitors:\n- Alpha (https://a.org)\n- [Beta](https://b.org)\n\n`code`")).toBe(
      "SUMMARY\n\nI found three competitors:\n• Alpha (https://a.org)\n• Beta (https://b.org)\n\ncode");
  });
  it("emits Telegram HTML with escaping", () => {
    expect(toTelegramHtml("**Bold** & <tag> _it_ [x](https://x.org)")).toBe('<b>Bold</b> &amp; &lt;tag&gt; <i>it</i> <a href="https://x.org">x</a>');
  });
  it("chunks long text at paragraph boundaries", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "x".repeat(150)).join("\n\n");
    const chunks = chunkText(text, 1000);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
  it("maps buttons back to intents", () => {
    expect(approvalButtons("ap-1").map((b) => b.id)).toEqual(["approve:ap-1", "review:ap-1", "reject:ap-1"]);
    expect(buttonToText("approve:ap-1")).toEqual({ text: "approve", openUrl: null });
    expect(buttonToText("review_task:t9")?.openUrl).toBe("/dashboard/tasks?task=t9");
    expect(buttonToText("evil:1")).toBeNull();
  });
  it("gates media by mime and size", () => {
    expect(mediaAllowed("application/pdf", 1000).ok).toBe(true);
    expect(mediaAllowed("audio/ogg; codecs=opus", 1000).ok).toBe(true);
    expect(mediaAllowed("application/x-msdownload", 10).ok).toBe(false);
    expect(mediaAllowed("image/png", 9_000_000).ok).toBe(false);
  });
});
