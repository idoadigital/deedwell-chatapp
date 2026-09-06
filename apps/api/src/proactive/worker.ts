import type { Deps } from "../bootstrap.js";
import { runProactiveTick } from "./orchestrator.js";

/** Evaluates due proactive candidates on a timer — the same shape as the
 *  publish worker: a setTimeout chain, SKIP LOCKED claims, safe to run on
 *  several instances. PROACTIVE_WORKER=off disables it on an instance. */
export function startProactiveWorker(deps: Deps, opts: { intervalMs?: number; log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {}): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.PROACTIVE_POLL_MS ?? 60_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const stats = await runProactiveTick(deps);
      if (stats.claimed) opts.log?.info({ at: "proactive.tick", ...stats });
    } catch (err) {
      opts.log?.error({ at: "proactive.tick_failed", err });
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { void tick(); }, Math.min(intervalMs, 5_000));
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
