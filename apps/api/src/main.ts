import { createAdminPool, migrate } from "@deedwell/database";
import { buildApp } from "./app.js";
import { createDeps } from "./bootstrap.js";
import { startPublishWorker } from "@deedwell/connectors";
import { sweepPendingWebhooks } from "./webhooks.js";
import { publishingMediaPath } from "./routes-content.js";

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
  // The queue spans every tenant, so the worker runs on the admin pool (on the
  // app pool RLS hides all of it) and hands Meta a public share link per image.
  const stopPublishWorker = process.env.PUBLISH_WORKER === "off" ? null : startPublishWorker({
    pool: deps.adminPool,
    mediaUrlFor: async (ref) =>
      `${process.env.API_ORIGIN ?? "https://coworkers.deedwell.org"}${await publishingMediaPath(deps.adminPool, ref)}`,
    log: app.log,
  });
  if (stopPublishWorker) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => stopPublishWorker());
    }
  }

  // Agent tasks: runs due tasks (one-off and cron). TASKS_WORKER=off disables it.
  if (process.env.TASKS_WORKER !== "off") {
    const { startTaskWorker } = await import("./tasks/worker.js");
    const stopTasks = startTaskWorker(deps, { log: app.log });
    abort.signal.addEventListener("abort", () => stopTasks());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopTasks());
  }

  // Proactive messaging: evaluates due follow-up candidates. Same claim
  // pattern as the publish worker; PROACTIVE_WORKER=off disables it here.
  if (process.env.PROACTIVE_WORKER !== "off") {
    const { startProactiveWorker } = await import("./proactive/worker.js");
    const stopProactive = startProactiveWorker(deps, { log: app.log });
    abort.signal.addEventListener("abort", () => stopProactive());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopProactive());
  }

  // Ad Grants: reads the connected Gmail inbox for Google's and Goodstack's
  // emails about the application. AD_GRANTS_INBOX=off disables it.
  if (process.env.AD_GRANTS_INBOX !== "off") {
    const { startAdGrantsInboxWorker } = await import("./ad-grants-inbox.js");
    const stopInbox = startAdGrantsInboxWorker(deps, { log: app.log });
    abort.signal.addEventListener("abort", () => stopInbox());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopInbox());
  }

  // Google Ads: publish jobs, snapshot sync, manager-link retries.
  // GOOGLE_ADS_WORKER=off disables it.
  if (process.env.GOOGLE_ADS_WORKER !== "off") {
    const { startGoogleAdsWorker } = await import("./google-ads/worker.js");
    const { setGoogleAdsLogger } = await import("./google-ads/access.js");
    setGoogleAdsLogger({ warn: (o, m) => app.log.warn(o as object, m), info: (o, m) => app.log.info(o as object, m) });
    const stopAds = startGoogleAdsWorker(deps, { log: app.log });
    abort.signal.addEventListener("abort", () => stopAds());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopAds());
  }

  // Transactional email: drains the outbox every few seconds and runs the
  // low-balance / unread-digest sweeps. EMAIL_WORKER=off disables it.
  if (process.env.EMAIL_WORKER !== "off") {
    const { startEmailWorker } = await import("./email-worker.js");
    const stopEmail = startEmailWorker(deps, { log: app.log });
    abort.signal.addEventListener("abort", () => stopEmail());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopEmail());
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

// A rejected promise nobody awaited must never take the whole API instance
// down (Node's default): it is logged with its origin instead. Every
// workspace on the instance would otherwise lose its requests over one
// stray browser-automation or provider callback error.
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ at: "process.unhandled_rejection", err: String((reason as Error)?.stack ?? reason).slice(0, 2000) }));
});

main().catch((err) => {
  console.error("API failed to start:", err);
  process.exit(1);
});
