import { AD_GRANTS_WORKFLOW } from "@deedwell/adgrants-domain";
import { withContext } from "@deedwell/database";
import { createDeps } from "./bootstrap.js";

/**
 * Standalone poller for external review latency (production entry, run as
 * its own process alongside worker.ts — NOT part of the tight 500ms worker
 * loop, since Google's and TechSoup's review can take days).
 *
 * This never determines review status itself — it only wakes any run
 * parked on await_google_review often enough that the step re-checks. The
 * actual live status check happens inside that step (via
 * ctx.services.google.checkGoogleReviewStatus), re-verified fresh every
 * time, same "never trust a cached signal" principle the rest of the
 * engine follows.
 */
const POLL_INTERVAL_MS = 15 * 60 * 1000; // review takes days, not seconds — no need to poll faster

async function pollOnce(deps: Awaited<ReturnType<typeof createDeps>>): Promise<number> {
  const { rows } = await deps.adminPool.query(
    `SELECT r.id, r.tenant_id FROM workflow_runs r
     WHERE r.definition = $1 AND r.status = 'waiting_for_info'
       AND r.state->'waiting'->>'payload' LIKE '%google_review_pending%'`,
    [AD_GRANTS_WORKFLOW]
  );
  for (const row of rows) {
    await withContext(deps.appPool, { tenantId: row.tenant_id, userId: null }, (client) =>
      deps.engine.signal(client, row.id, "info", {})
    ).catch(() => {
      // Already resolved by something else between the SELECT and here — fine to skip.
    });
  }
  return rows.length;
}

async function main(): Promise<void> {
  const deps = await createDeps();
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  process.on("SIGTERM", () => abort.abort());
  console.log("Ad Grants review poller started");
  while (!abort.signal.aborted) {
    const woken = await pollOnce(deps).catch((err) => {
      console.error("ad-grants-poller iteration failed:", err);
      return 0;
    });
    if (woken) console.log(`ad-grants-poller: woke ${woken} run(s) for a review-status re-check`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await deps.appPool.end();
  await deps.adminPool.end();
}

main().catch((err) => {
  console.error("Ad Grants poller crashed:", err);
  process.exit(1);
});
