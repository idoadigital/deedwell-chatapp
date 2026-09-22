import type { FastifyInstance } from "fastify";
import {
  currentEnvironment, disableIntegration, getProvider, listPlatformIntegrations,
  markIntegrationValidated, PROVIDER_NAMES, readPlatformCredentials, savePlatformCredentials,
  updateIntegrationConfiguration, type IntegrationEnvironment,
} from "@deedwell/connectors";
import { HttpError, type AppContext } from "./app.js";
import { invalidateAdapters, telegramAdapter, webhookUrl, whatsappAdapter } from "./messaging/adapters.js";

const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
const envOf = (req: unknown): IntegrationEnvironment => {
  const q = (req as { query?: { environment?: string } }).query?.environment;
  return q === "development" || q === "production" ? q : currentEnvironment();
};

/** Platform-level OAuth applications. requirePlatformAdmin on every route:
 *  a tenant administrator must never see a client secret, and these rows have
 *  no tenant_id to scope them by. */
const INTEGRATION_NAMES = [...PROVIDER_NAMES, "telegram", "whatsapp"];

export function registerAdminIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.get("/v1/admin/integrations", async (req) => {
    ctx.requirePlatformAdmin(req);
    const environment = envOf(req);
    // WhatsApp inherits the Meta app's credentials; building the adapter once
    // here materialises its row so the card and its verify token show up.
    await whatsappAdapter(deps.appPool).catch(() => undefined);
    return {
      environment,
      // The exact values an administrator must paste into each console.
      redirectUris: Object.fromEntries(
        PROVIDER_NAMES.map((p) => [p, `${API_ORIGIN}/v1/connectors/${p}/callback`])
      ),
      // Meta requires this for App Review; Google does not use it.
      dataDeletionUrls: { meta: `${API_ORIGIN}/v1/connectors/meta/data-deletion` },
      integrations: await listPlatformIntegrations(deps.appPool, INTEGRATION_NAMES, environment),
      // Messaging providers are webhook-driven, not OAuth: what Meta's and
      // Telegram's consoles need is the callback URL (and, for Meta, the
      // verify token, which is generated here on first save).
      webhookUrls: { telegram: webhookUrl("telegram"), whatsapp: webhookUrl("whatsapp") },
      whatsappVerifyToken: (await readPlatformCredentials(deps.appPool, "whatsapp", environment))?.configuration.verifyToken ?? null,
    };
  });

  app.post("/v1/admin/integrations/:provider", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { provider } = req.params as { provider: string };
    if (!INTEGRATION_NAMES.includes(provider)) throw new HttpError(404, "Unknown provider");
    const { clientId, clientSecret, environment } = req.body as {
      clientId?: string; clientSecret?: string; environment?: IntegrationEnvironment;
    };
    if (!clientId?.trim()) throw new HttpError(400, "Enter the application's client ID.");
    if (!clientSecret?.trim()) throw new HttpError(400, "Enter the application's client secret.");
    const env: IntegrationEnvironment = environment === "development" ? "development" : "production";

    await savePlatformCredentials(deps.appPool, {
      provider, environment: env, clientId: clientId.trim(),
      clientSecret: clientSecret.trim(), configuredBy: req.userId!,
    });
    // Audit without the secret — not even its length.
    req.log.info({ at: "integration_configured", provider, environment: env, by: req.userId });
    invalidateAdapters();
    return reply.status(201).send({ ok: true });
  });

  /** Server-side validation. Deliberately does not "test" by pretending to
   *  authorize: it checks the credentials exist, are shaped like that
   *  provider's, and that an authorize URL can actually be built. */
  app.post("/v1/admin/integrations/:provider/validate", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { provider: name } = req.params as { provider: string };
    const environment = envOf(req);
    const credentials = await readPlatformCredentials(deps.appPool, name, environment);
    if (!credentials) {
      await markIntegrationValidated(deps.appPool, name, environment, false, "No credentials saved yet.");
      return { ok: false, detail: "No credentials saved yet." };
    }
    const problems: string[] = [];
    // Messaging providers: talk to the provider and register the webhook —
    // that is the validation, and it is what makes them work.
    if (name === "telegram" || name === "whatsapp") {
      invalidateAdapters();
      let detail: string | null = null;
      try {
        if (name === "telegram") {
          const tg = await telegramAdapter(deps.appPool);
          const me = await tg.getMe();
          if (!me.username) problems.push("The bot has no username — set one in @BotFather.");
          if (me.username && me.username.toLowerCase() !== credentials.clientId.replace(/^@/, "").toLowerCase()) {
            await updateIntegrationConfiguration(deps.appPool, "telegram", environment, { botUsername: me.username });
          }
          await tg.setWebhook(webhookUrl("telegram"));
          const h = await tg.health(null);
          if (!h.ok) problems.push(h.detail ?? "Webhook registration did not stick.");
          detail = `Bot @${me.username ?? "?"}, webhook ${webhookUrl("telegram")}`;
        } else {
          if (!/^\d{8,}$/.test(credentials.clientId)) problems.push("That does not look like a Meta App ID — it should be numeric.");
          const res = await fetch(`https://graph.facebook.com/${credentials.clientId}?access_token=${encodeURIComponent(`${credentials.clientId}|${credentials.clientSecret}`)}&fields=name`, { signal: AbortSignal.timeout(15_000) });
          const data = (await res.json().catch(() => null)) as { name?: string; error?: { message?: string } } | null;
          if (!res.ok || !data?.name) problems.push(`Meta rejected the App ID / secret: ${data?.error?.message ?? `HTTP ${res.status}`}`);
          else detail = `App "${data.name}". Webhook: ${webhookUrl("whatsapp")}`;
          const wa = await whatsappAdapter(deps.appPool);
          if (!wa.isConfigured()) problems.push("Credentials are not readable by the server.");
        }
      } catch (err) { problems.push((err as Error).message); }
      const ok = problems.length === 0;
      await markIntegrationValidated(deps.appPool, name, environment, ok, ok ? (detail ?? undefined) : problems.join(" "));
      return { ok, detail: ok ? detail : problems.join(" ") };
    }
    if (name === "meta" && !/^\d{8,}$/.test(credentials.clientId)) {
      problems.push("That does not look like a Meta App ID — it should be numeric.");
    }
    if ((name === "google" || name === "google_ads") && !credentials.clientId.endsWith(".apps.googleusercontent.com")) {
      problems.push("That does not look like a Google OAuth client ID.");
    }
    const provider = await getProvider(deps.appPool, name);
    if (!provider?.isConfigured()) problems.push("Credentials are not readable by the server.");
    else {
      try {
        const url = provider.authorizeUrl({ state: "validation", redirectUri: `${API_ORIGIN}/v1/connectors/${name}/callback` });
        if (!url.startsWith("https://")) problems.push("Could not build an authorization URL.");
      } catch (err) {
        problems.push(`Could not initialize the OAuth flow: ${(err as Error).message}`);
      }
    }
    const ok = problems.length === 0;
    await markIntegrationValidated(deps.appPool, name, environment, ok, ok ? undefined : problems.join(" "));
    if (!ok) req.log.warn({ at: "validation_failed", provider: name, environment, problems });
    return { ok, detail: ok ? null : problems.join(" ") };
  });

  /** Admin-recorded facts no API will tell us: Meta App Review state, Google
   *  consent-screen mode. Recorded rather than guessed, so the UI never shows
   *  a green "approved" that nobody verified. */
  app.patch("/v1/admin/integrations/:provider/configuration", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { provider } = req.params as { provider: string };
    const patch = req.body as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      if (/secret|token|password/i.test(key)) throw new HttpError(400, "Secrets do not belong in configuration.");
    }
    await updateIntegrationConfiguration(deps.appPool, provider, envOf(req), patch);
    return { ok: true };
  });

  app.delete("/v1/admin/integrations/:provider", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { provider } = req.params as { provider: string };
    const environment = envOf(req);
    const disabled = await disableIntegration(deps.appPool, provider, environment);
    if (!disabled) throw new HttpError(404, "Nothing configured for that provider.");
    req.log.info({ at: "integration_disabled", provider, environment, by: req.userId });
    return { ok: true };
  });
}
