import type { Pool } from "pg";
import type { ConnectorProvider } from "./types.js";
import { MetaProvider } from "./providers/meta.js";
import { GoogleProvider } from "./providers/google.js";
import { readPlatformCredentials } from "./platform-config.js";

type Factory = (credentials: { clientId: string; clientSecret: string } | null) => ConnectorProvider;

/** Registry, not a switch statement. A new connector is one entry here — the
 *  routes, the UI and the worker all go through this. */
const FACTORIES = new Map<string, Factory>([
  ["meta", (c) => new MetaProvider(c)],
  ["google", (c) => new GoogleProvider(c)],
]);

export const PROVIDER_NAMES = [...FACTORIES.keys()];

/** An unconfigured provider still constructs — it simply reports
 *  isConfigured() === false, so the UI can show "Not Configured" instead of
 *  the application breaking. */
export async function getProvider(pool: Pool, name: string): Promise<ConnectorProvider | undefined> {
  const factory = FACTORIES.get(name);
  if (!factory) return undefined;
  const credentials = await readPlatformCredentials(pool, name);
  return factory(credentials);
}

export async function listProviders(pool: Pool): Promise<ConnectorProvider[]> {
  return Promise.all(PROVIDER_NAMES.map((name) => getProvider(pool, name) as Promise<ConnectorProvider>));
}
