import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, uuidv7 } from "@deedwell/database";
import { HttpError, type AppContext } from "../app.js";
import { telegramAdapter, whatsappAdapter, webhookUrl, APP_ORIGIN, platformSender, savePlatformSender, registerPlatformSender, isUnregistered } from "./adapters.js";
import {
  connectionView, ensureLinkedChannel, loadConnection, prefsOf, sealed, setConnectionStatus, type ConnectionRow,
} from "./connections.js";
import { flushOutbound, healthOf, hashToken, ingestWebhook, inviteWhatsApp, mintPairing, mintTelegramPairing, testConnection, whatsappPairingLink } from "./gateway.js";

/**
 * /v1/integrations/{telegram,whatsapp}/webhook  provider-facing, no session
 * /v1/orgs/:orgId/messaging/...                 the customer's connections
 * /v1/admin/messaging/overview                  platform visibility
 */
export function registerMessagingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  /* ---- webhooks --------------------------------------------------------- */
  void app.register(async (scope) => {
    // Raw bytes: Meta's signature is over the exact body.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.get("/v1/integrations/whatsapp/webhook", async (req, reply) => {
      const wa = await whatsappAdapter(deps.appPool);
      const challenge = wa.verifySubscription(req.query as Record<string, string | undefined>);
      if (challenge === null) return reply.status(403).send("Forbidden");
      return reply.status(200).type("text/plain").send(challenge);
    });

    scope.post("/v1/integrations/whatsapp/webhook", async (req, reply) => {
      const wa = await whatsappAdapter(deps.appPool);
      const raw = req.body as Buffer;
      if (!wa.isConfigured() || !wa.verifyWebhook({ headers: req.headers as Record<string, string | string[] | undefined>, rawBody: raw })) {
        req.log.warn({ at: "whatsapp_webhook_rejected" });
        return reply.status(401).send({ error: "Bad signature" });
      }
      let body: unknown;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return reply.status(400).send({ error: "Bad JSON" }); }
      const parsed = wa.parseWebhook(body);
      // Acknowledge first; Meta retries on slow responses.
      void reply.status(200).send({ received: true });
      const stats = await ingestWebhook(deps, "whatsapp", parsed, req.log);
      req.log.info({ at: "whatsapp_webhook", ...stats });
    });

    scope.post("/v1/integrations/telegram/webhook", async (req, reply) => {
      const tg = await telegramAdapter(deps.appPool);
      if (!tg.isConfigured() || !tg.verifyWebhook({ headers: req.headers as Record<string, string | string[] | undefined>, rawBody: req.body as Buffer })) {
        req.log.warn({ at: "telegram_webhook_rejected" });
        return reply.status(401).send({ error: "Bad secret" });
      }
      let body: unknown;
      try { body = JSON.parse((req.body as Buffer).toString("utf8")); } catch { return reply.status(400).send({ error: "Bad JSON" }); }
      const parsed = tg.parseWebhook(body);
      void reply.status(200).send({ ok: true });
      const stats = await ingestWebhook(deps, "telegram", parsed, req.log);
      req.log.info({ at: "telegram_webhook", ...stats });
    });
  });

  /* ---- tenant ----------------------------------------------------------- */
  const base = "/v1/orgs/:orgId/messaging";

  const viewWithHealth = (r: ConnectionRow) => connectionView(r);

  app.get(base, async (req) => {
    ctx.requireRole(req, "viewer");
    const [tg, wa] = await Promise.all([telegramAdapter(deps.appPool), whatsappAdapter(deps.appPool)]);
    const rows = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT * FROM connector_connections WHERE provider IN ('telegram','whatsapp') AND status <> 'disconnected' ORDER BY created_at");
      return rows as ConnectionRow[];
    });
    const tgMe = tg.isConfigured() ? await tg.getMe().catch(() => null) : null;
    const sender = await platformSender(deps.appPool);
    return {
      catalogue: [
        { channel: "telegram", available: tg.isConfigured(), botUsername: tgMe?.username ?? null },
        { channel: "whatsapp", available: wa.isConfigured(), scan: wa.isConfigured() && sender ? { displayPhone: sender.displayPhone, verifiedName: sender.verifiedName, scanWorks: !/^1555/.test((sender.displayPhone ?? "").replace(/\D/g, "")) } : null, embeddedSignup: wa.isConfigured() && wa.embeddedSignupConfigId ? { appId: wa.appId, configId: wa.embeddedSignupConfigId } : null },
      ],
      connections: rows.map(viewWithHealth),
      me: req.userId,
    };
  });

  /** Telegram: mint a pairing token and the deep link that opens the bot with it. */
  app.post(`${base}/telegram/pairing`, async (req) => {
    ctx.requireRole(req, "member");
    const tg = await telegramAdapter(deps.appPool);
    if (!tg.isConfigured()) throw new HttpError(503, "Telegram isn't set up on this Deedwell yet. A platform administrator adds the bot under Platform Admin → Integrations.");
    const me = await tg.getMe().catch(() => null);
    if (!me?.username) throw new HttpError(503, "The Telegram bot is not reachable right now.");
    const { token, expiresAt } = await ctx.inOrg(req, (client) => mintTelegramPairing(client, req.orgId!, req.userId!));
    return { token, link: `https://t.me/${me.username}?start=${encodeURIComponent(token)}`, botUsername: me.username, expiresAt, tokenHash: hashToken(token) };
  });

  /** WhatsApp scan-to-connect: a wa.me link (and QR) that opens Deedwell's number with the pairing message. */
  app.post(`${base}/whatsapp/pairing`, async (req) => {
    ctx.requireRole(req, "member");
    const wa = await whatsappAdapter(deps.appPool);
    const sender = await platformSender(deps.appPool);
    if (!wa.isConfigured() || !sender) throw new HttpError(503, "WhatsApp isn't set up on this Deedwell yet. A platform administrator adds Deedwell's WhatsApp number under Platform Admin → Integrations → WhatsApp.");
    const digits = (sender.displayPhone ?? "").replace(/\D/g, "");
    if (!digits) throw new HttpError(503, "Deedwell's WhatsApp number has no display number on file yet — validate it in Platform Admin.");
    const body = z.object({ phone: z.string().min(6).optional().nullable() }).parse(req.body ?? {});
    const phone = body.phone ? body.phone.replace(/\D/g, "") : null;
    if (body.phone && (!phone || phone.length < 8)) throw new HttpError(400, "Enter your WhatsApp number in international format, e.g. +1 469 514 1427.");
    const { token, expiresAt } = await ctx.inOrg(req, (client) => mintPairing(client, "whatsapp", req.orgId!, req.userId!, phone));
    let invited = false;
    if (phone) {
      try { await inviteWhatsApp(deps, req.orgId!, req.userId!, phone); invited = true; }
      catch (err) {
        // Nothing reached the phone, so nothing may pair against this attempt.
        await ctx.inOrg(req, (client) => client.query("DELETE FROM connector_oauth_states WHERE state_hash = $1 AND provider = 'whatsapp'", [hashToken(token)])).catch(() => undefined);
        const msg = (err as Error).message;
        throw new HttpError(400, isUnregistered(err)
          ? "Deedwell's WhatsApp number isn't registered with Meta yet, so it can't send. A platform admin can fix this in Platform Admin → Integrations → WhatsApp → Deedwell's number → Register number."
          : /131030|not in allowed list|recipient/i.test(msg)
            ? `WhatsApp refused to message ${phone}: while Deedwell is on Meta's test number, only phone numbers added as test recipients in the Meta console can receive messages.`
            : `Could not message ${phone}: ${msg}`);
      }
    }
    // Meta test numbers (555…) are not real WhatsApp accounts: wa.me cannot open them, so "Text me" is the way in.
    const scanWorks = !/^1555/.test(digits);
    return { token, link: whatsappPairingLink(digits, token), number: sender.displayPhone, message: `Connect Deedwell DW-${token}`, expiresAt, tokenHash: hashToken(token), invited, phone, scanWorks };
  });

  /** Polled by the Connect dialogs: has the token been used, and by which connection? */
  const pairingStatus = (channel: "telegram" | "whatsapp") => async (req: FastifyRequest) => {
    ctx.requireRole(req, "member");
    const { hash } = req.params as { hash: string };
    return ctx.inOrg(req, async (client) => {
      const st = await client.query("SELECT consumed_at, expires_at FROM connector_oauth_states WHERE state_hash = $1 AND provider = $2", [hash, channel]);
      if (!st.rows[0]) throw new HttpError(404, "Unknown pairing");
      const consumed = Boolean(st.rows[0].consumed_at);
      const conn = consumed
        ? (await client.query("SELECT * FROM connector_connections WHERE provider = $2 AND connected_by_user_id = $1 AND status <> 'disconnected' ORDER BY updated_at DESC LIMIT 1", [req.userId, channel])).rows[0] as ConnectionRow | undefined
        : undefined;
      return { consumed, expired: !consumed && new Date(st.rows[0].expires_at) < new Date(), connection: conn ? connectionView(conn) : null };
    });
  };
  app.get(`${base}/telegram/pairing/:hash`, pairingStatus("telegram"));
  app.get(`${base}/whatsapp/pairing/:hash`, pairingStatus("whatsapp"));

  /** WhatsApp: attach a business phone number, from Embedded Signup or pasted credentials. */
  const WhatsAppConnect = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("embedded_signup"), code: z.string().min(10), phoneNumberId: z.string().min(3), wabaId: z.string().min(3), ownerPhone: z.string().min(6) }),
    z.object({ mode: z.literal("manual"), phoneNumberId: z.string().min(3), wabaId: z.string().min(3).optional().nullable(), accessToken: z.string().min(20), ownerPhone: z.string().min(6) }),
  ]);
  app.post(`${base}/whatsapp/connect`, async (req, reply) => {
    ctx.requireRole(req, "admin");
    const wa = await whatsappAdapter(deps.appPool);
    if (!wa.isConfigured()) throw new HttpError(503, "WhatsApp isn't set up on this Deedwell yet. A platform administrator adds the Meta app under Platform Admin → Integrations.");
    const input = WhatsAppConnect.parse(req.body);
    const ownerPhone = input.ownerPhone.replace(/\D/g, "");
    if (ownerPhone.length < 8) throw new HttpError(400, "Enter your own WhatsApp number in international format, e.g. +1 415 555 0100.");

    let token: string;
    let wabaId: string | null = input.wabaId ?? null;
    if (input.mode === "embedded_signup") token = (await wa.exchangeCode(input.code)).accessToken;
    else token = input.accessToken.trim();

    // Prove the credentials before saving anything: the number must answer.
    const probe = await wa.health({ channel: "whatsapp", chatId: "", accountId: input.phoneNumberId, accessToken: token });
    if (!probe.ok) throw new HttpError(400, `WhatsApp rejected those details: ${probe.detail ?? "the phone number id or token is wrong"}`);
    if (!wabaId) wabaId = (await wa.businessAccountsFor(token).catch(() => []))[0] ?? null;
    if (wabaId) await wa.subscribeApp(token, wabaId).catch((err) => req.log.warn({ at: "whatsapp_subscribe_failed", err: (err as Error).message }));

    const s = sealed(token);
    const meta = {
      wabaId, displayPhone: (probe.facts.number as string | null) ?? null, verifiedName: (probe.facts.name as string | null) ?? null,
      ownerPhone, allowedSenders: [{ phone: ownerPhone, userId: req.userId!, label: "You" }],
      connectMode: input.mode, notifications: {}, health: { ...probe, checkedAt: new Date().toISOString() }, lastActivityAt: new Date().toISOString(),
    };
    const row = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO connector_connections
           (id, tenant_id, provider, connector_type, provider_account_id, provider_account_name, provider_account_handle,
            encrypted_access_token, access_iv, access_tag, key_version, scopes, status, metadata, connected_by_user_id)
         VALUES ($1,$2,'whatsapp','whatsapp_number',$3,$4,$5,$6,$7,$8,$9,'{whatsapp_business_messaging}','connected',$10,$11)
         ON CONFLICT (tenant_id, provider, connector_type, provider_account_id) WHERE status <> 'disconnected'
         DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token, access_iv = EXCLUDED.access_iv, access_tag = EXCLUDED.access_tag, key_version = EXCLUDED.key_version,
                       provider_account_name = EXCLUDED.provider_account_name, status = 'connected', status_detail = NULL,
                       metadata = connector_connections.metadata || EXCLUDED.metadata
         RETURNING *`,
        [uuidv7(), req.orgId, input.phoneNumberId, meta.verifiedName ?? meta.displayPhone ?? "WhatsApp", meta.displayPhone,
         s.ciphertext, s.iv, s.tag, s.keyVersion, JSON.stringify(meta), req.userId]);
      const conn = rows[0] as ConnectionRow;
      await ensureLinkedChannel(client, conn);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "messaging.connected", entityType: "connector_connection", entityId: conn.id, metadata: { channel: "whatsapp", mode: input.mode, phoneNumberId: input.phoneNumberId } });
      return conn;
    });
    // Anyone else's phone that had been pointed at this number's identity is re-resolved on their next message.
    await deps.adminPool.query("UPDATE messaging_identities SET user_id = $2, active_connection_id = $3 WHERE channel = 'whatsapp' AND external_user_id = $1", [ownerPhone, req.userId, row.id]);
    return reply.status(201).send({ connection: connectionView(row) });
  });

  const Patch = z.object({
    notifications: z.object({ agent: z.boolean().optional(), tasks: z.boolean().optional(), approvals: z.boolean().optional(), critical: z.boolean().optional() }).optional(),
    addSender: z.object({ phone: z.string().min(6), userId: z.string().uuid(), label: z.string().max(80).optional().nullable() }).optional(),
    removeSender: z.string().min(6).optional(),
  });
  app.patch(`${base}/connections/:id`, async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    const patch = Patch.parse(req.body);
    return ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT * FROM connector_connections WHERE id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'", [id]);
      const conn = rows[0] as ConnectionRow | undefined;
      if (!conn) throw new HttpError(404, "Connection not found");
      const mine = conn.connected_by_user_id === req.userId;
      if ((patch.addSender || patch.removeSender) && conn.provider !== "whatsapp") throw new HttpError(400, "Only WhatsApp numbers have a sender list.");
      if ((patch.addSender || patch.removeSender)) ctx.requireRole(req, "admin");
      if (patch.notifications && !mine) ctx.requireRole(req, "admin");
      const meta = { ...conn.metadata };
      if (patch.notifications) meta.notifications = { ...prefsOf(meta), ...patch.notifications };
      if (patch.addSender) {
        const phone = patch.addSender.phone.replace(/\D/g, "");
        const member = await client.query("SELECT 1 FROM organization_memberships WHERE user_id = $1 AND tenant_id = $2", [patch.addSender.userId, req.orgId]);
        if (!member.rows[0]) throw new HttpError(400, "That person is not a member of this workspace.");
        meta.allowedSenders = [...(meta.allowedSenders ?? []).filter((x) => x.phone !== phone), { phone, userId: patch.addSender.userId, label: patch.addSender.label ?? null }];
      }
      if (patch.removeSender) {
        const phone = patch.removeSender.replace(/\D/g, "");
        meta.allowedSenders = (meta.allowedSenders ?? []).filter((x) => x.phone !== phone);
        await deps.adminPool.query("UPDATE messaging_identities SET active_connection_id = NULL WHERE channel = 'whatsapp' AND external_user_id = $1 AND active_connection_id = $2", [phone, conn.id]);
      }
      await client.query("UPDATE connector_connections SET metadata = $2::jsonb WHERE id = $1", [conn.id, JSON.stringify(meta)]);
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "messaging.updated", entityType: "connector_connection", entityId: conn.id, metadata: { keys: Object.keys(patch) } });
      return { connection: connectionView({ ...conn, metadata: meta }) };
    });
  });

  app.post(`${base}/connections/:id/test`, async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    const conn = await ctx.inOrg(req, async (client) => (await client.query("SELECT * FROM connector_connections WHERE id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'", [id])).rows[0] as ConnectionRow | undefined);
    if (!conn) throw new HttpError(404, "Connection not found");
    return testConnection(deps, conn, req.userId!);
  });

  app.post(`${base}/connections/:id/health`, async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    const conn = await ctx.inOrg(req, async (client) => (await client.query("SELECT * FROM connector_connections WHERE id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'", [id])).rows[0] as ConnectionRow | undefined);
    if (!conn) throw new HttpError(404, "Connection not found");
    const health = await healthOf(deps, conn);
    const fresh = await loadConnection(deps.adminPool, conn.id);
    return { health, connection: fresh ? connectionView(fresh) : connectionView(conn) };
  });

  app.get(`${base}/connections/:id/activity`, async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    return ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `SELECT id, direction, kind, status, error, created_at, processed_at, sent_at, attempts,
                CASE WHEN direction = 'in' THEN left(payload->>'text', 120) ELSE left(payload->>'text', 120) END AS preview,
                payload->>'reason' AS reason, conversation_channel_id
           FROM messaging_events WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 60`, [id]);
      return { events: rows };
    });
  });

  app.delete(`${base}/connections/:id`, async (req) => {
    ctx.requireRole(req, "member");
    const { id } = req.params as { id: string };
    await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT * FROM connector_connections WHERE id = $1 AND provider IN ('telegram','whatsapp') AND status <> 'disconnected'", [id]);
      const conn = rows[0] as ConnectionRow | undefined;
      if (!conn) throw new HttpError(404, "Connection not found");
      if (conn.connected_by_user_id !== req.userId) ctx.requireRole(req, "admin");
      await setConnectionStatus(client, conn.id, "disconnected", "Disconnected from Deedwell");
      await audit(client, { tenantId: req.orgId!, actorUser: req.userId, action: "messaging.disconnected", entityType: "connector_connection", entityId: conn.id, metadata: { channel: conn.provider } });
    });
    // Unpair, and start the sender's rate-limit window afresh so the "how to
    // reconnect" help is not swallowed by counts accumulated while paired.
    await deps.adminPool.query("UPDATE messaging_identities SET active_connection_id = NULL, window_count = 0, window_started_at = NULL WHERE active_connection_id = $1", [id]);
    return { ok: true };
  });

  /* ---- admin ------------------------------------------------------------ */
  app.get("/v1/admin/messaging/overview", async (req) => {
    ctx.requirePlatformAdmin(req);
    const q = (sql: string, params: unknown[] = []) => deps.adminPool.query(sql, params).then((r) => r.rows);
    const [connections, volume, failures, recent, billable, identities] = await Promise.all([
      q(`SELECT provider AS channel, status, count(*)::int AS n FROM connector_connections WHERE provider IN ('telegram','whatsapp') GROUP BY 1,2 ORDER BY 1,2`),
      q(`SELECT channel, direction, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week, count(*)::int AS total
           FROM messaging_events GROUP BY 1,2 ORDER BY 1,2`),
      q(`SELECT channel, direction, count(*)::int AS n FROM messaging_events WHERE status = 'failed' AND created_at > now() - interval '7 days' GROUP BY 1,2`),
      q(`SELECT e.id, e.channel, e.direction, e.kind, e.status, e.error, e.created_at, o.name AS org_name, e.tenant_id
           FROM messaging_events e JOIN organizations o ON o.id = e.tenant_id
          WHERE e.status = 'failed' ORDER BY e.created_at DESC LIMIT 25`),
      q(`SELECT count(*)::int AS n FROM messaging_events WHERE channel = 'whatsapp' AND direction = 'out' AND (result->>'billable') = 'true' AND created_at > now() - interval '30 days'`),
      q(`SELECT channel, count(*)::int AS n, count(*) FILTER (WHERE active_connection_id IS NOT NULL)::int AS paired FROM messaging_identities GROUP BY 1`),
    ]);
    const [tg, wa] = await Promise.all([telegramAdapter(deps.appPool), whatsappAdapter(deps.appPool)]);
    const tgHealth = tg.isConfigured() ? await tg.health(null).catch((e) => ({ ok: false, detail: (e as Error).message, facts: {} })) : { ok: false, detail: "Not configured", facts: {} };
    return {
      providers: { telegram: { configured: tg.isConfigured(), ...tgHealth, webhook: webhookUrl("telegram") }, whatsapp: { configured: wa.isConfigured(), webhook: webhookUrl("whatsapp"), embeddedSignup: Boolean(wa.embeddedSignupConfigId) } },
      connections, volume, failures, recent, billableWhatsApp30d: (billable[0] as { n?: number } | undefined)?.n ?? 0, identities,
      appOrigin: APP_ORIGIN,
    };
  });

  /** Admin: Deedwell's own WhatsApp number (what customers scan to connect). Token never read back. */
  app.get("/v1/admin/messaging/whatsapp/sender", async (req) => {
    ctx.requirePlatformAdmin(req);
    const s = await platformSender(deps.appPool);
    return { configured: Boolean(s), phoneNumberId: s?.phoneNumberId ?? null, wabaId: s?.wabaId ?? null, displayPhone: s?.displayPhone ?? null, verifiedName: s?.verifiedName ?? null, registeredAt: s?.registeredAt ?? null, tokenHint: s ? `••••${s.token.slice(-4)}` : null };
  });
  app.post("/v1/admin/messaging/whatsapp/sender", async (req) => {
    ctx.requirePlatformAdmin(req);
    const input = z.object({ phoneNumberId: z.string().min(3), wabaId: z.string().min(3).optional().nullable(), accessToken: z.string().min(20) }).parse(req.body);
    try {
      const s = await savePlatformSender(deps.appPool, { phoneNumberId: input.phoneNumberId.trim(), wabaId: input.wabaId?.trim() || null, token: input.accessToken.trim(), configuredBy: req.userId! });
      req.log.info({ at: "whatsapp_sender_configured", phoneNumberId: s.phoneNumberId, by: req.userId });
      return { ok: true, phoneNumberId: s.phoneNumberId, wabaId: s.wabaId, displayPhone: s.displayPhone, verifiedName: s.verifiedName, tokenHint: `••••${s.token.slice(-4)}` };
    } catch (err) { throw new HttpError(400, (err as Error).message); }
  });

  /** Admin: register Deedwell's number on the Cloud API (clears Meta 133010). PIN used once, never stored or logged. */
  app.post("/v1/admin/messaging/whatsapp/sender/register", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, "The two-step verification PIN is 6 digits.") }).parse(req.body);
    try {
      const s = await registerPlatformSender(deps.appPool, pin);
      req.log.info({ at: "whatsapp_sender_registered", phoneNumberId: s.phoneNumberId, by: req.userId });
      return { ok: true, registeredAt: s.registeredAt };
    } catch (err) { throw new HttpError(400, `Meta did not register the number: ${(err as Error).message}`); }
  });

  /** Admin: re-drive stuck outbound deliveries after a provider incident. */
  app.post("/v1/admin/messaging/flush", async (req) => {
    ctx.requirePlatformAdmin(req);
    await deps.adminPool.query("UPDATE messaging_events SET status = 'pending', attempts = 0 WHERE direction = 'out' AND status = 'failed' AND created_at > now() - interval '24 hours' AND error NOT ILIKE '%131047%'");
    const sent = await flushOutbound(deps, null, req.log);
    return { sent };
  });

}
