import { createAdminPool, migrate } from "@deedwell/database";
import { buildApp } from "./app.js";
import { createDeps } from "./bootstrap.js";
import { startPublishWorker } from "@deedwell/connectors";
import { sweepPendingWebhooks } from "./webhooks.js";

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

  // Webhook deliveries are enqueued transactionally from request handlers
  // and workflow steps that can't afford to await a slow third-party HTTP
  // call themselves (see packages/database's enqueueWebhookEvent) — this
  // sweep is what actually sends them. `busy` skips a tick rather than
  // overlapping runs against the same 'pending' rows.
  let webhookSweepBusy = false;
  const webhookSweep = setInterval(() => {
    if (webhookSweepBusy || abort.signal.aborted) return;
    webhookSweepBusy = true;
    sweepPendingWebhooks(deps.appPool)
      .catch((err) => console.error("webhook sweep failed:", err))
      .finally(() => { webhookSweepBusy = false; });
  }, 15_000);
  abort.signal.addEventListener("abort", () => clearInterval(webhookSweep));

  const port = Number(process.env.PORT ?? 3000);
  // Scheduled social publishing runs in-process alongside the API. It claims
  // work with SKIP LOCKED, so running several API instances is safe; set
  // PUBLISH_WORKER=off on instances that should not publish.
  const stopPublishWorker = process.env.PUBLISH_WORKER === "off" ? null : startPublishWorker({
    pool: deps.appPool,
    mediaUrlFor: (tenantId, fileId) =>
      `${process.env.API_ORIGIN ?? "https://coworkers.deedwell.org"}/v1/orgs/${tenantId}/files/${fileId}/content`,
    log: app.log,
  });
  if (stopPublishWorker) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => stopPublishWorker());
    }
  }

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
