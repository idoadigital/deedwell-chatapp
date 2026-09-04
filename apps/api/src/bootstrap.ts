import type { Pool } from "pg";
import {
  createAdminPool,
  createAppPool,
  LocalFsStorage,
  GcsStorage,
  type StorageAdapter,
} from "@deedwell/database";
import {
  createDesignProvider,
  createModelProvider,
  seedAgentDefinitions,
  type ModelProvider,
} from "@deedwell/agent-runtime";
import { ToolGateway } from "@deedwell/tools";
import { PgWorkflowEngine } from "@deedwell/workflows";
import {
  ALL_AGENTS,
  buildGrantFullWorkflow,
  buildGrantSliceWorkflow,
  createGrantSource,
  registerGrantTools,
  type GrantServices,
  type GrantSourceProvider,
} from "@deedwell/grant-domain";
import {
  buildWebsiteBuildWorkflow,
  buildWebsiteUpdateWorkflow,
  WEBSITE_AGENTS,
} from "@deedwell/website-domain";
import { ALL_AD_GRANTS_AGENTS, buildAdGrantsWorkflow } from "@deedwell/adgrants-domain";
import { createGcpGrantPlatform, type GcpGrantPlatform } from "./gcp/platform.js";

export interface Deps {
  adminPool: Pool;
  appPool: Pool;
  storage: StorageAdapter;
  provider: ModelProvider;
  gateway: ToolGateway;
  engine: PgWorkflowEngine<GrantServices>;
  grantSource: GrantSourceProvider;
  /** External grant platform (GCP). Null = feature off; all behaviour local. */
  gcp: GcpGrantPlatform | null;
}

export async function createDeps(overrides: Partial<{
  adminPool: Pool;
  appPool: Pool;
  storage: StorageAdapter;
  provider: ModelProvider;
  research: GrantServices["research"];
  google: GrantServices["google"];
  backoffMs: (attempt: number) => number;
  gcp: GcpGrantPlatform | null;
}> = {}): Promise<Deps> {
  const adminPool = overrides.adminPool ?? createAdminPool();
  const appPool = overrides.appPool ?? createAppPool();
  const storage = overrides.storage
    ?? (process.env.STORAGE_BUCKET
      ? new GcsStorage(process.env.STORAGE_BUCKET)
      : new LocalFsStorage(process.env.DATA_DIR ?? "./.data"));
  const provider = overrides.provider ?? createModelProvider();
  // Page design goes to the strong tier; in tests the mock serves both.
  const designer = overrides.provider ?? createDesignProvider();

  const gateway = new ToolGateway();
  registerGrantTools(gateway);

  // Web research (spec §4): RESEARCH_FETCH=browser|fetch|off. Off (the
  // default for tests/CI) makes the research step record an honest skip —
  // never simulated sources.
  const researchMode = process.env.RESEARCH_FETCH ?? "off";
  const research = "research" in overrides
    ? overrides.research
    : researchMode === "off"
      ? undefined
      : (await import("@deedwell/browser-research")).createBrowserResearch(
          researchMode === "fetch" ? "fetch" : "browser"
        );

  // Google Ad Grants browser automation: AD_GRANTS_AUTOMATION=on|off. Off
  // (the default for tests/CI, and any environment without real Google
  // credentials configured) makes every browser-touching step park with an
  // honest "automation isn't connected" wait — it never simulates progress.
  const adGrantsAutomationOn = (process.env.AD_GRANTS_AUTOMATION ?? "off") === "on";
  const google = "google" in overrides
    ? overrides.google
    : adGrantsAutomationOn
      ? (await import("@deedwell/browser-automation")).createGoogleAutomation({ appPool, storage })
      : undefined;

  const services: GrantServices = { provider, gateway, storage, research, google, designer };
  const engine = new PgWorkflowEngine<GrantServices>(
    adminPool,
    appPool,
    services,
    overrides.backoffMs
  );
  engine.register(buildGrantSliceWorkflow());
  engine.register(buildGrantFullWorkflow());
  engine.register(buildWebsiteBuildWorkflow());
  engine.register(buildWebsiteUpdateWorkflow());
  engine.register(buildAdGrantsWorkflow());

  const deps: Deps = {
    adminPool,
    appPool,
    storage,
    provider,
    gateway,
    engine,
    grantSource: createGrantSource(),
    gcp: "gcp" in overrides ? (overrides.gcp ?? null) : createGcpGrantPlatform(),
  };
  const { executiveAssistant, attachEngineBridge } = await import("./assistant.js");
  await seedAgentDefinitions(adminPool, [
    ...ALL_AGENTS, ...WEBSITE_AGENTS, ...ALL_AD_GRANTS_AGENTS, executiveAssistant,
  ]);
  attachEngineBridge(deps);
  const { attachWorkspaceBridge } = await import("./workspace.js");
  attachWorkspaceBridge(deps);
  return deps;
}
