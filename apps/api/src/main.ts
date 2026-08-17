import { createAdminPool, migrate } from "@deedwell/database";
import { buildApp } from "./app.js";
import { createDeps } from "./bootstrap.js";

async function main(): Promise<void> {
  // Migrate before createDeps — dependency wiring seeds agent definitions.
  const migratePool = createAdminPool();
  await migrate(migratePool);
  await migratePool.end();
  const deps = await createDeps();

  const app = buildApp(deps);

  // Dev/single-node: the workflow worker runs in-process. In production the
  // worker runs as its own process (`pnpm worker`) and this loop is disabled.
  const abort = new AbortController();
  if (process.env.INLINE_WORKER !== "false") {
    void deps.engine.runWorkerLoop(`api-${process.pid}`, {
      intervalMs: 500,
      signal: abort.signal,
    });
  }

  // External grant platform: the async bridge turns finished platform tasks
  // into teammate messages. Only runs when the platform is configured.
  if (deps.gcp) {
    const { startGcpBridge } = await import("./gcp/bridge.js");
    startGcpBridge(deps);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });

  const shutdown = async () => {
    abort.abort();
    await app.close();
    await deps.appPool.end();
    await deps.adminPool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("API failed to start:", err);
  process.exit(1);
});
