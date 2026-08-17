import type { Pool } from "pg";
import {
  createAdminPool,
  createAppPool,
  LocalFsStorage,
  type StorageAdapter,
} from "@deedwell/database";
import {
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

export interface Deps {
  adminPool: Pool;
  appPool: Pool;
  storage: StorageAdapter;
  provider: ModelProvider;
  gateway: ToolGateway;
  engine: PgWorkflowEngine<GrantServices>;
  grantSource: GrantSourceProvider;
}

export async function createDeps(overrides: Partial<{
  adminPool: Pool;
  appPool: Pool;
  storage: StorageAdapter;
  provider: ModelProvider;
  research: GrantServices["research"];
  backoffMs: (attempt: number) => number;
}> = {}): Promise<Deps> {
  const adminPool = overrides.adminPool ?? createAdminPool();
  const appPool = overrides.appPool ?? createAppPool();
  const storage = overrides.storage ?? new LocalFsStorage(process.env.DATA_DIR ?? "./.data");
  const provider = overrides.provider ?? createModelProvider();

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

  const services: GrantServices = { provider, gateway, storage, research };
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

  const deps: Deps = {
    adminPool,
    appPool,
    storage,
    provider,
    gateway,
    engine,
    grantSource: createGrantSource(),
  };
  const { executiveAssistant, attachEngineBridge } = await import("./assistant.js");
  await seedAgentDefinitions(adminPool, [...ALL_AGENTS, ...WEBSITE_AGENTS, executiveAssistant]);
  attachEngineBridge(deps);
  const { attachWorkspaceBridge } = await import("./workspace.js");
  attachWorkspaceBridge(deps);
  return deps;
}
