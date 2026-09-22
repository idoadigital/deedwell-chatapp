import http from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createOrg, createTestEnv, registerUser, type TestEnv } from "../helpers.js";
import { processInboundEvent, flushOutbound } from "../../apps/api/src/messaging/gateway.js";
import { invalidateAdapters, whatsappAdapter } from "../../apps/api/src/messaging/adapters.js";

/**
 * WhatsApp and Telegram as interfaces into the agent runtime. Providers are
 * stand-in HTTP servers (TELEGRAM_API_BASE / META_GRAPH_BASE); everything
 * else — webhook routes, identity, pairing, the runtime, the relay, the
 * outbox — is the real thing.
 */

let env: TestEnv;
let token: string;
let orgId: string;
let userId: string;
const tg: { calls: Array<{ method: string; body: any }> } = { calls: [] };
const wa: { calls: Array<{ path: string; body: any }>; windowClosed: boolean } = { calls: [], windowClosed: false };
let tgServer: http.Server; let waServer: http.Server;

const readJson = async (req: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const raw = Buffer.concat(chunks).toString(); try { return JSON.parse(raw); } catch { return { raw: raw.length }; } };

beforeAll(async () => {
  tgServer = http.createServer(async (req, res) => {
    const m = req.url!.match(/^\/bot[^/]+\/(\w+)/); const body = await readJson(req);
    const method = m?.[1] ?? "";
    if (req.url!.startsWith("/file/bot")) { res.setHeader("content-type", "application/pdf"); return res.end("%PDF-1.4 x"); }
    tg.calls.push({ method, body });
    const json = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (method === "getMe") return json({ ok: true, result: { id: 1, is_bot: true, first_name: "Deedwell", username: "deedwell_test_bot" } });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://x/hook", pending_update_count: 0 } });
    if (method === "getFile") return json({ ok: true, result: { file_path: "documents/x.pdf" } });
    if (method === "sendMessage") return json({ ok: true, result: { message_id: 100 + tg.calls.length } });
    return json({ ok: true, result: true });
  }).listen(0);
  waServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x"); const path = url.pathname.replace(/^\/v\d+\.\d+\//, ""); const body = await readJson(req);
    wa.calls.push({ path, body });
    const json = (o: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (!(req.headers.authorization ?? "").startsWith("Bearer BIZ-TOKEN")) return json({ error: { message: "Invalid OAuth access token.", code: 190 } }, 401);
    if (path === "PN-1" && url.searchParams.has("fields")) return json({ display_phone_number: "+1 555-000-1111", verified_name: "Hope Forward", quality_rating: "GREEN" });
    if (path === "PN-DW" && url.searchParams.has("fields")) return json({ display_phone_number: "+1 555-187-2077", verified_name: "Deedwell", quality_rating: "GREEN" });
    if (path === "WABA-DW/subscribed_apps") return json({ success: true });
    if (path === "PN-DW/messages") {
      if (body.status === "read") return json({ success: true });
      return json({ messages: [{ id: `wamid.dw.${wa.calls.length}` }] });
    }
    if (path === "PN-1/messages") {
      if (body.status === "read") return json({ success: true });
      if (wa.windowClosed) return json({ error: { message: "Re-engagement message", code: 131047 } }, 400);
      return json({ messages: [{ id: `wamid.out.${wa.calls.length}` }] });
    }
    if (path === "WABA-1/subscribed_apps") return json({ success: true });
    return json({ error: { message: `unhandled ${path}`, code: 100 } }, 400);
  }).listen(0);
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(tgServer.address() as { port: number }).port}`;
  process.env.META_GRAPH_BASE = `http://127.0.0.1:${(waServer.address() as { port: number }).port}`;
  process.env.MESSAGING_WORKER = "off";
  process.env.SESSION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

  env = await createTestEnv();
  ({ token } = await registerUser(env.app, "phone@example.org"));
  orgId = await createOrg(env.app, token, "phone-org");
  userId = (await env.adminPool.query("SELECT id FROM users WHERE email = 'phone@example.org'")).rows[0].id;
  await env.adminPool.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [userId]);
  await api(env.app, "POST", "/v1/admin/integrations/telegram", { token, body: { clientId: "deedwell_test_bot", clientSecret: "1:FAKE", environment: "development" } });
  await api(env.app, "POST", "/v1/admin/integrations/whatsapp", { token, body: { clientId: "123456789012", clientSecret: "META-SECRET", environment: "development" } });
  invalidateAdapters();
});
afterAll(async () => { tgServer?.close(); waServer?.close(); await env.close(); });

/** The worker is off in tests: process what the webhook queued, then deliver replies. */
const drain = async () => {
  for (let i = 0; i < 5; i++) {
    const { rows } = await env.adminPool.query("UPDATE messaging_events SET status = 'processing', claimed_at = now(), attempts = attempts + 1 WHERE direction = 'in' AND status = 'received' RETURNING *");
    for (const ev of rows) await processInboundEvent(env.deps, ev as never);
    await flushOutbound(env.deps, null);
    if (!rows.length) break;
  }
};
const tgSent = () => tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
const waSent = () => wa.calls.filter((c) => c.path === "PN-1/messages" && c.body.type).map((c) => c.body.type === "interactive" ? `[buttons] ${c.body.interactive.body.text}` : c.body.text?.body ?? `[${c.body.type}]`);

describe("Telegram", () => {
  const from = { id: 4242, first_name: "Sam", username: "sam" }; const chat = { id: 4242, type: "private" };
  let secret: string; let update = 1; let msgId = 1;
  // The route acknowledges before ingest finishes (as providers require), so give it a beat.
  const post = async (payload: object, headerSecret?: string) => {
    const res = await env.app.inject({
      method: "POST", url: "/v1/integrations/telegram/webhook", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": headerSecret ?? secret }, payload: JSON.stringify({ update_id: ++update, ...payload }),
    });
    await new Promise((r) => setTimeout(r, 250));
    return res;
  };
  const text = (t: string, extra: object = {}) => ({ message: { message_id: ++msgId, date: 1, chat, from, text: t, ...extra } });

  it("validates the bot and registers the webhook from Platform Admin", async () => {
    const r = await api(env.app, "POST", "/v1/admin/integrations/telegram/validate?environment=development", { token, body: {} });
    expect(r.body.ok).toBe(true);
    expect(tg.calls.some((c) => c.method === "setWebhook" && c.body.secret_token)).toBe(true);
    secret = (await env.adminPool.query("SELECT configuration->>'webhookSecret' AS s FROM platform_integrations WHERE provider = 'telegram'")).rows[0].s;
  });
  it("rejects deliveries without the secret token", async () => {
    expect((await post(text("hi"), "wrong")).statusCode).toBe(401);
  });
  it("answers an unpaired sender with help and nothing else", async () => {
    expect((await post(text("hello?"))).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(tgSent().at(-1)).toMatch(/isn't connected to a Deedwell workspace/);
    expect((await env.adminPool.query("SELECT count(*)::int AS n FROM messaging_events WHERE direction = 'in'")).rows[0].n).toBe(0);
  });
  it("pairs through a signed single-use /start token and links a conversation", async () => {
    const pairing = (await api(env.app, "POST", `/v1/orgs/${orgId}/messaging/telegram/pairing`, { token, body: {} })).body;
    expect(pairing.link).toMatch(/^https:\/\/t\.me\/deedwell_test_bot\?start=/);
    const start = decodeURIComponent(new URL(pairing.link).searchParams.get("start")!);
    await post(text(`/start ${start}`, { entities: [{ type: "bot_command", offset: 0, length: 6 }] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(tgSent().at(-1)).toMatch(/Connected to Org phone-org/);
    const status = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging/telegram/pairing/${pairing.tokenHash}`, { token })).body;
    expect(status.consumed).toBe(true); expect(status.connection.status).toBe("connected"); expect(status.connection.channelId).toBeTruthy();
    // The token is single use.
    await post(text(`/start ${start}`, { entities: [{ type: "bot_command", offset: 0, length: 6 }] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(tgSent().at(-1)).toMatch(/expired or was already used/);
  });
  it("runs a message through the agent runtime and mirrors the reply, exactly once per provider message", async () => {
    const before = tgSent().length;
    await post(text("find grants for after-school programs"));
    await drain();
    const replies = tgSent().slice(before);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toMatch(/after-school/);
    // Same update again → ignored at ingest, no second run.
    await post({ message: { message_id: msgId, date: 1, chat, from, text: "find grants for after-school programs" } });
    await drain();
    expect(tgSent().length).toBe(before + replies.length);
    const list = (await api(env.app, "GET", `/v1/orgs/${orgId}/channels`, { token })).body.channels;
    const ext = list.find((c: any) => c.source === "telegram");
    expect(ext).toBeTruthy();
    const msgs = (await api(env.app, "GET", `/v1/orgs/${orgId}/channels/${ext.id}/messages`, { token })).body.messages;
    expect(msgs.some((m: any) => m.author_kind === "user" && /after-school/.test(m.body))).toBe(true);
    expect(msgs.some((m: any) => m.author_kind === "agent")).toBe(true);
    const metered = (await env.adminPool.query("SELECT count(*)::int AS n FROM usage_ledger WHERE kind = 'channel_message'")).rows[0].n;
    expect(metered).toBeGreaterThan(0);
  });
  it("stores a document through the files pipeline and hands it to the runtime", async () => {
    await post({ message: { message_id: ++msgId, date: 1, chat, from, document: { file_id: "d1", file_name: "grant.pdf", mime_type: "application/pdf", file_size: 10 }, caption: "the announcement" } });
    await drain();
    const f = await env.adminPool.query("SELECT filename, mime FROM files WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [orgId]);
    expect(f.rows[0]).toMatchObject({ filename: "grant.pdf", mime: "application/pdf" });
  });
  it("refuses media outside the allow-list without touching the runtime", async () => {
    const before = (await env.adminPool.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND author_kind = 'user'", [orgId])).rows[0].n;
    await post({ message: { message_id: ++msgId, date: 1, chat, from, document: { file_id: "d2", file_name: "tool.exe", mime_type: "application/x-msdownload", file_size: 10 } } });
    await drain();
    expect(tgSent().at(-1)).toMatch(/not accepted here/);
    expect((await env.adminPool.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND author_kind = 'user'", [orgId])).rows[0].n).toBe(before);
  });
  it("answers /tasks and /help as commands", async () => {
    await post(text("/help", { entities: [{ type: "bot_command", offset: 0, length: 5 }] }));
    await drain();
    expect(tgSent().at(-1)).toMatch(/\/status/);
  });
  it("mirrors an approval posted later into the channel with buttons", async () => {
    const ch = (await env.adminPool.query("SELECT id FROM channels WHERE tenant_id = $1 AND source = 'telegram' LIMIT 1", [orgId])).rows[0].id;
    const { insertMessage } = await import("../../apps/api/src/assistant.js");
    const { withContext } = await import("@deedwell/database");
    await withContext(env.deps.appPool, { tenantId: orgId, userId }, async (client) => {
      await insertMessage(client, { tenantId: orgId, channelId: ch, authorKind: "agent", authorAgent: "website.qa_deployment", body: "The release is built. Say approve to publish.", metadata: { approvalId: "00000000-0000-7000-8000-000000000001", approvalKind: "publish_site" } });
    });
    await flushOutbound(env.deps, null);
    const last = tg.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(last.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(["approve:00000000-0000-7000-8000-000000000001", "review:00000000-0000-7000-8000-000000000001", "reject:00000000-0000-7000-8000-000000000001"]);
  });
  it("turns a button press into the runtime's approve intent", async () => {
    await post({ callback_query: { id: "cb1", from, data: "approve:00000000-0000-7000-8000-000000000001", message: { message_id: 5, chat } } });
    await drain();
    const msgs = await env.adminPool.query("SELECT body FROM messages WHERE tenant_id = $1 AND author_kind = 'user' ORDER BY created_at DESC LIMIT 1", [orgId]);
    expect(msgs.rows[0].body).toBe("approve");
    expect(tg.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });
  it("disconnects and stops resolving the chat", async () => {
    const list = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging`, { token })).body;
    const conn = list.connections.find((c: any) => c.channel === "telegram");
    expect((await api(env.app, "DELETE", `/v1/orgs/${orgId}/messaging/connections/${conn.id}`, { token })).status).toBe(200);
    await post(text("still there?"));
    await new Promise((r) => setTimeout(r, 50));
    expect(tgSent().at(-1)).toMatch(/isn't connected|was removed/);
  });
});

describe("WhatsApp", () => {
  const sign = (raw: Buffer) => "sha256=" + createHmac("sha256", "META-SECRET").update(raw).digest("hex");
  let n = 0;
  const post = async (value: object, badSig = false) => {
    const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN-1" }, ...value } }] }] }));
    const res = await env.app.inject({ method: "POST", url: "/v1/integrations/whatsapp/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": badSig ? "sha256=00" : sign(raw) }, payload: raw });
    await new Promise((r) => setTimeout(r, 250));
    return res;
  };
  const msg = (from: string, extra: object) => ({ contacts: [{ wa_id: from, profile: { name: "Ana" } }], messages: [{ id: `wamid.in.${++n}`, from, timestamp: "1", ...extra }] });

  it("completes the subscription handshake only with the verify token", async () => {
    await whatsappAdapter(env.deps.appPool);
    const vt = (await env.adminPool.query("SELECT configuration->>'verifyToken' AS v FROM platform_integrations WHERE provider = 'whatsapp'")).rows[0].v;
    const ok = await env.app.inject({ method: "GET", url: `/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=abc` });
    expect(ok.statusCode).toBe(200); expect(ok.body).toBe("abc");
    expect((await env.app.inject({ method: "GET", url: "/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc" })).statusCode).toBe(403);
  });
  it("attaches a number only after the credentials prove themselves", async () => {
    const bad = await api(env.app, "POST", `/v1/orgs/${orgId}/messaging/whatsapp/connect`, { token, body: { mode: "manual", phoneNumberId: "PN-1", accessToken: "WRONG-TOKEN-xxxxxxxxxxxx", ownerPhone: "+1 415 555 0100" } });
    expect(bad.status).toBe(400);
    const good = await api(env.app, "POST", `/v1/orgs/${orgId}/messaging/whatsapp/connect`, { token, body: { mode: "manual", phoneNumberId: "PN-1", wabaId: "WABA-1", accessToken: "BIZ-TOKEN-xxxxxxxxxxxxxxxx", ownerPhone: "+1 415 555 0100" } });
    expect(good.status).toBe(201);
    expect(good.body.connection).toMatchObject({ status: "connected", displayPhone: "+1 555-000-1111", allowedSenders: [{ phone: "14155550100" }] });
    expect(wa.calls.some((c) => c.path === "WABA-1/subscribed_apps")).toBe(true);
  });
  it("rejects a bad signature and refuses unknown senders", async () => {
    expect((await post(msg("14155550100", { type: "text", text: { body: "hi" } }), true)).statusCode).toBe(401);
    await post(msg("15550009999", { type: "text", text: { body: "hello" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(waSent().at(-1)).toMatch(/isn't on its list/);
    expect((await env.adminPool.query("SELECT count(*)::int AS n FROM messaging_events WHERE channel = 'whatsapp' AND direction = 'in'")).rows[0].n).toBe(0);
  });
  it("routes the owner's message through the runtime and records delivery statuses", async () => {
    await post(msg("14155550100", { type: "text", text: { body: "find grants for food security" } }));
    await drain();
    expect(waSent().at(-1)).toMatch(/food security/);
    const out = (await env.adminPool.query("SELECT external_message_id FROM messaging_events WHERE channel = 'whatsapp' AND direction = 'out' AND status = 'sent' ORDER BY created_at DESC LIMIT 1")).rows[0].external_message_id;
    await post({ statuses: [{ id: out, status: "read", timestamp: "2", recipient_id: "14155550100", pricing: { billable: false, category: "service" } }] });
    await new Promise((r) => setTimeout(r, 50));
    expect((await env.adminPool.query("SELECT status FROM messaging_events WHERE external_message_id = $1", [out])).rows[0].status).toBe("read");
  });
  it("fails cleanly outside the 24-hour window and never sends a template", async () => {
    wa.windowClosed = true;
    await post(msg("14155550100", { type: "text", text: { body: "status" } }));
    await drain();
    const failed = await env.adminPool.query("SELECT status, error FROM messaging_events WHERE channel = 'whatsapp' AND direction = 'out' ORDER BY created_at DESC LIMIT 1");
    expect(failed.rows[0].status).toBe("failed"); expect(failed.rows[0].error).toMatch(/Re-engagement/);
    expect(wa.calls.some((c) => c.body?.type === "template")).toBe(false);
    const notice = await env.adminPool.query("SELECT 1 FROM messages WHERE tenant_id = $1 AND metadata->>'windowClosed' = 'true'", [orgId]);
    expect(notice.rowCount).toBe(1);
    wa.windowClosed = false;
  });
  it("scan-to-connect: a customer pairs by sending the prefilled message to Deedwell's number", async () => {
    // Platform admin registers Deedwell's own number (proven against Graph, token never read back).
    const saved = await api(env.app, "POST", "/v1/admin/messaging/whatsapp/sender", { token, body: { phoneNumberId: "PN-DW", wabaId: "WABA-DW", accessToken: "BIZ-TOKEN-platform-xxxxxxxxxxxx" } });
    expect(saved.status).toBe(200); expect(saved.body.displayPhone).toBe("+1 555-187-2077"); expect(JSON.stringify(saved.body)).not.toMatch(/BIZ-TOKEN-platform/);
    const cat = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging`, { token })).body;
    expect(cat.catalogue.find((c: any) => c.channel === "whatsapp").scan).toMatchObject({ displayPhone: "+1 555-187-2077" });
    // Customer: Connect → QR/link.
    const pairing = (await api(env.app, "POST", `/v1/orgs/${orgId}/messaging/whatsapp/pairing`, { token, body: {} })).body;
    expect(pairing.link).toMatch(/^https:\/\/wa\.me\/15551872077\?text=Connect%20Deedwell%20DW-/);
    // A second phone (not on any allow-list) sends exactly the prefilled message to Deedwell's number.
    const dwSent = () => wa.calls.filter((c) => c.path === "PN-DW/messages" && c.body.type).map((c) => c.body.text?.body ?? `[${c.body.type}]`);
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "14695141427", profile: { name: "Steven" } }], messages: [{ id: `wamid.in.${++n}`, from: "14695141427", timestamp: "1", type: "text", text: { body: pairing.message } }] });
    expect(dwSent().at(-1)).toMatch(/Connected to Org phone-org/);
    const status = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging/whatsapp/pairing/${pairing.tokenHash}`, { token })).body;
    expect(status.consumed).toBe(true); expect(status.connection).toMatchObject({ platform: true, status: "connected", accountHandle: "+14695141427" });
    // The same phone now talks to the team; replies go out on Deedwell's number.
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "14695141427", profile: { name: "Steven" } }], messages: [{ id: `wamid.in.${++n}`, from: "14695141427", timestamp: "1", type: "text", text: { body: "find grants for youth mentoring" } }] });
    await drain();
    expect(dwSent().at(-1)).toMatch(/youth mentoring/);
    // A stranger on Deedwell's number gets the connect instructions, nothing else.
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "15550001234", profile: { name: "Nobody" } }], messages: [{ id: `wamid.in.${++n}`, from: "15550001234", timestamp: "1", type: "text", text: { body: "hello" } }] });
    expect(dwSent().at(-1)).toMatch(/isn't connected to your Deedwell workspace/);
    // Used token cannot pair a second phone.
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "15550001234", profile: { name: "Nobody" } }], messages: [{ id: `wamid.in.${++n}`, from: "15550001234", timestamp: "1", type: "text", text: { body: pairing.message } }] });
    expect(dwSent().at(-1)).toMatch(/expired or was already used/);
  });
  it("text-me: Deedwell messages a phone first and the reply completes a phone-bound pairing", async () => {
    // The scanned phone from the previous test is released so it can pair again.
    const mine = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging`, { token })).body.connections.filter((c: any) => c.channel === "whatsapp" && c.platform);
    for (const c of mine) await api(env.app, "DELETE", `/v1/orgs/${orgId}/messaging/connections/${c.id}`, { token });
    // Test numbers are not on wa.me, so the catalogue says scanning won't work and offers the invite path.
    const cat = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging`, { token })).body;
    expect(cat.catalogue.find((c: any) => c.channel === "whatsapp").scan.scanWorks).toBe(false);
    const before = wa.calls.length;
    const pairing = (await api(env.app, "POST", `/v1/orgs/${orgId}/messaging/whatsapp/pairing`, { token, body: { phone: "+1 (469) 514-1427" } })).body;
    expect(pairing).toMatchObject({ invited: true, phone: "14695141427", scanWorks: false });
    // Exactly one business-initiated template went to that phone from Deedwell's number.
    const templates = wa.calls.slice(before).filter((c) => c.path === "PN-DW/messages" && c.body.type === "template");
    expect(templates).toHaveLength(1); expect(templates[0].body).toMatchObject({ to: "14695141427", template: { name: "hello_world" } });
    // A different phone replying does not consume the invite.
    const dwSent = () => wa.calls.filter((c) => c.path === "PN-DW/messages" && c.body.type).map((c) => c.body.text?.body ?? `[${c.body.type}]`);
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "15550001234", profile: { name: "Nobody" } }], messages: [{ id: `wamid.in.${++n}`, from: "15550001234", timestamp: "1", type: "text", text: { body: "hi" } }] });
    expect(dwSent().at(-1)).toMatch(/isn't connected to your Deedwell workspace/);
    expect((await api(env.app, "GET", `/v1/orgs/${orgId}/messaging/whatsapp/pairing/${pairing.tokenHash}`, { token })).body.consumed).toBe(false);
    // The invited phone replies with anything — no token needed — and is linked.
    await post({ metadata: { phone_number_id: "PN-DW" }, contacts: [{ wa_id: "14695141427", profile: { name: "Steven" } }], messages: [{ id: `wamid.in.${++n}`, from: "14695141427", timestamp: "1", type: "text", text: { body: "hi" } }] });
    expect(dwSent().at(-1)).toMatch(/Connected to Org phone-org/);
    const status = (await api(env.app, "GET", `/v1/orgs/${orgId}/messaging/whatsapp/pairing/${pairing.tokenHash}`, { token })).body;
    expect(status.consumed).toBe(true); expect(status.connection).toMatchObject({ platform: true, status: "connected", accountHandle: "+14695141427" });
    // Never the token, never the phone's invite in an API response beyond what the UI needs.
    expect(JSON.stringify(pairing)).not.toMatch(/BIZ-TOKEN/);
  });

  it("shows the platform admin an overview without message bodies", async () => {
    const ov = (await api(env.app, "GET", "/v1/admin/messaging/overview", { token })).body;
    expect(ov.connections.some((c: any) => c.channel === "whatsapp" && c.status === "connected")).toBe(true);
    expect(JSON.stringify(ov)).not.toMatch(/food security/);
  });
});

