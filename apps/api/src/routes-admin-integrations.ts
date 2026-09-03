import type { FastifyInstance } from "fastify";
import {
  currentEnvironment, disableIntegration, getProvider, listPlatformIntegrations,
  markIntegrationValidated, PROVIDER_NAMES, readPlatformCredentials, savePlatformCredentials,
  updateIntegrationConfiguration, type IntegrationEnvironment,
} from "@deedwell/connectors";
import { HttpError, type AppContext } from "./app.js";

const API_ORIGIN = process.env.API_ORIGIN ?? "https://coworkers.deedwell.org";
const envOf = (req: unknown): IntegrationEnvironment => {
  const q = (req as { query?: { environment?: string } }).query?.environment;
  return q === "development" || q === "production" ? q : currentEnvironment();
};

/** Platform-level OAuth applications. requirePlatformAdmin on every route:
 *  a tenant administrator must never see a client secret, and these rows have
 *  no tenant_id to scope them by. */
export function registerAdminIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { deps } = ctx;

  app.get("/v1/admin/integrations", async (req) => {
    ctx.requirePlatformAdmin(req);
    const environment = envOf(req);
    return {
      environment,
      // The exact values an administrator must paste into each console.
      redirectUris: Object.fromEntries(
        PROVIDER_NAMES.map((p) => [p, `${API_ORIGIN}/v1/connectors/${p}/callback`])
      ),
      // Meta requires this for App Review; Google does not use it.
      dataDeletionUrls: { meta: `${API_ORIGIN}/v1/connectors/meta/data-deletion` },
      integrations: await listPlatformIntegrations(deps.appPool, PROVIDER_NAMES, environment),
    };
  });

  app.post("/v1/admin/integrations/:provider", async (req, reply) => {
    ctx.requirePlatformAdmin(req);
    const { provider } = req.params as { provider: string };
    if (!PROVIDER_NAMES.includes(provider)) throw new HttpError(404, "Unknown provider");
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
    if (name === "meta" && !/^\d{8,}$/.test(credentials.clientId)) {
      problems.push("That does not look like a Meta App ID — it should be numeric.");
    }
    if (name === "google" && !credentials.clientId.endsWith(".apps.googleusercontent.com")) {
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
