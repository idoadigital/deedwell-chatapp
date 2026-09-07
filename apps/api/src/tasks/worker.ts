import type { Deps } from "../bootstrap.js";
import { runTaskTick } from "./runner.js";

/** Same shape as the proactive worker: a setTimeout chain, an env-tunable
 *  poll, a stop closure. TASKS_WORKER=off disables it on an instance. */
export function startTaskWorker(deps: Deps, opts: { intervalMs?: number; log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {}): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.TASKS_POLL_MS ?? 30_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const stats = await runTaskTick(deps);
      if (stats.claimed) opts.log?.info({ at: "tasks.tick", ...stats });
    } catch (err) {
      opts.log?.error({ at: "tasks.tick_failed", err: String((err as Error)?.message ?? err) });
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { void tick(); }, Math.min(intervalMs, 5_000));
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
