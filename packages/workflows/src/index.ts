import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { uuidv7, withContext } from "@deedwell/database";
import { summarize } from "@deedwell/observability";
import type { WorkflowRunStatus } from "@deedwell/schemas";

/**
 * Durable workflow engine on Postgres (ADR-0002), behind an interface a
 * Temporal-backed implementation can satisfy later.
 *
 * Semantics:
 * - One step per claim. Step execution and its state/journal writes commit in
 *   ONE tenant-scoped transaction — a crash mid-step re-runs the step cleanly.
 * - Claims are leases (`claimed_at`); a dead worker's run is reclaimable after
 *   the lease expires.
 * - `wait()` parks the run (approval / info); an API `signal()` re-enqueues it.
 * - Bounded per-step retries with backoff; exhaustion => resumable `failed`.
 * - A per-run step budget suspends runaway runs (`suspended_budget`).
 */

export type JsonState = Record<string, unknown>;

export type StepResult =
  | { state: JsonState; next: string }
  | { state: JsonState; wait: { kind: "info" | "approval"; payload: unknown; resumeStep: string } }
  | { state: JsonState; complete: true };

export interface StepContext<S> {
  /** Tenant-scoped client: RLS is active for everything this step touches. */
  client: PoolClient;
  runId: string;
  tenantId: string;
  projectId: string;
  createdBy: string;
  state: JsonState;
  services: S;
  signals: JsonState;
}

export interface WorkflowDefinition<S> {
  name: string;
  version: number;
  initialStep: string;
  stepBudget: number;
  steps: Record<string, (ctx: StepContext<S>) => Promise<StepResult>>;
}

export interface WorkflowEvent {
  type: "run_updated";
  tenantId: string;
  runId: string;
  status: WorkflowRunStatus;
  step: string;
}

export interface WorkflowEngine {
  start(
    client: PoolClient,
    args: { tenantId: string; projectId: string; definition: string; createdBy: string; input: JsonState }
  ): Promise<string>;
  signal(client: PoolClient, runId: string, kind: "info" | "approval", payload: unknown): Promise<void>;
  runPendingOnce(workerId: string): Promise<boolean>;
}

const CLAIM_LEASE_SECONDS = 90;

class LeaseLostError extends Error {
  constructor(runId: string, step: string) {
    super(`Lease on run ${runId} lost during step "${step}"`);
    this.name = "LeaseLostError";
  }
}
const WAIT_STATUS: Record<"info" | "approval", WorkflowRunStatus> = {
  info: "waiting_for_info",
  approval: "waiting_approval",
};

export class PgWorkflowEngine<S> implements WorkflowEngine {
  readonly events = new EventEmitter();
  private readonly definitions = new Map<string, WorkflowDefinition<S>>();

  constructor(
    /** Admin pool: used ONLY to claim runs across tenants and record failures. */
    private readonly adminPool: Pool,
    /** App pool: RLS-bound; all step logic runs on it under the run's tenant. */
    private readonly appPool: Pool,
    private readonly services: S,
    private readonly backoffMs: (attempt: number) => number = (a) => a * a * 1000
  ) {}

  register(def: WorkflowDefinition<S>): void {
    this.definitions.set(def.name, def);
  }

  async start(
    client: PoolClient,
    args: { tenantId: string; projectId: string; definition: string; createdBy: string; input: JsonState }
  ): Promise<string> {
    const def = this.definitions.get(args.definition);
    if (!def) throw new Error(`Unknown workflow definition: ${args.definition}`);
    const id = uuidv7();
    await client.query(
      `INSERT INTO workflow_runs (id, tenant_id, project_id, definition, definition_version,
         status, current_step, state, step_budget, created_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)`,
      [id, args.tenantId, args.projectId, def.name, def.version, def.initialStep,
       JSON.stringify({ input: args.input }), def.stepBudget, args.createdBy]
    );
    return id;
  }

  /** Wake a parked run. Facts/decisions live in the DB; the signal re-enqueues. */
  async signal(client: PoolClient, runId: string, kind: "info" | "approval", payload: unknown): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE workflow_runs
         SET status = 'pending', attempts = 0, next_attempt_at = NULL,
             state = jsonb_set(state, '{signals}',
               COALESCE(state->'signals', '{}'::jsonb) || $3::jsonb)
       WHERE id = $1 AND status = $2`,
      [runId, WAIT_STATUS[kind], JSON.stringify({ [kind]: summarize(payload) })]
    );
    if (!rowCount) {
      throw new Error(`Run ${runId} is not waiting for ${kind}`);
    }
  }

  /** Claims and executes at most one step. Returns true if work was done. */
  async runPendingOnce(workerId: string): Promise<boolean> {
    const { rows } = await this.adminPool.query(
      `UPDATE workflow_runs SET claimed_by = $1, claimed_at = now()
       WHERE id = (
         SELECT id FROM workflow_runs
         WHERE status IN ('pending','running')
           AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $2))
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY updated_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, project_id, definition, current_step, state,
                 attempts, max_attempts, step_budget, steps_used, created_by`,
      [workerId, CLAIM_LEASE_SECONDS]
    );
    const run = rows[0];
    if (!run) return false;

    const def = this.definitions.get(run.definition);
    if (!def) {
      await this.markFailed(run, `No registered definition "${run.definition}" (deploy mismatch)`);
      return true;
    }
    const stepFn = def.steps[run.current_step];
    if (!stepFn) {
      await this.markFailed(run, `Unknown step "${run.current_step}" in "${run.definition}"`);
      return true;
    }
    if (run.steps_used >= run.step_budget) {
      await this.adminPool.query(
        `UPDATE workflow_runs SET status = 'suspended_budget', claimed_by = NULL, claimed_at = NULL,
           last_error = 'Step budget exhausted; human resume required' WHERE id = $1`,
        [run.id]
      );
      this.emit(run.tenant_id, run.id, "suspended_budget", run.current_step);
      return true;
    }

    const started = Date.now();
    // Steps now run for minutes (a site build writes and designs pages
    // concurrently), far past the claim lease. The lease is renewed while
    // the step runs, and the step's commit is refused if the lease was lost
    // to another worker in the meantime — so a step never executes twice
    // with both results landing.
    const heartbeat = setInterval(() => {
      this.adminPool.query(
        "UPDATE workflow_runs SET claimed_at = now() WHERE id = $1 AND claimed_by = $2",
        [run.id, workerId]
      ).catch(() => { /* renewed on the next beat */ });
    }, Math.max(5, Math.floor(CLAIM_LEASE_SECONDS / 3)) * 1000);
    try {
      await withContext(this.appPool, { tenantId: run.tenant_id, userId: run.created_by }, async (client) => {
        const state: JsonState = run.state ?? {};
        const result = await stepFn({
          client,
          runId: run.id,
          tenantId: run.tenant_id,
          projectId: run.project_id,
          createdBy: run.created_by,
          state,
          services: this.services,
          signals: (state.signals as JsonState) ?? {},
        });

        let status: WorkflowRunStatus;
        let nextStep = run.current_step as string;
        if ("complete" in result) {
          status = "completed";
        } else if ("wait" in result) {
          status = WAIT_STATUS[result.wait.kind];
          nextStep = result.wait.resumeStep;
          result.state.waiting = { kind: result.wait.kind, payload: summarize(result.wait.payload) };
        } else {
          status = "pending";
          nextStep = result.next;
        }

        // State, journal, usage, and run status commit atomically with the
        // step's own writes — durability comes from this single transaction.
        const committed = await client.query(
          `UPDATE workflow_runs SET status = $2, current_step = $3, state = $4,
             attempts = 0, steps_used = steps_used + 1, next_attempt_at = NULL,
             claimed_by = NULL, claimed_at = NULL, last_error = NULL
           WHERE id = $1 AND claimed_by = $5`,
          [run.id, status, nextStep, JSON.stringify(result.state), workerId]
        );
        if (committed.rowCount === 0) {
          throw new LeaseLostError(run.id, run.current_step);
        }
        await this.journal(client, run, "completed", Date.now() - started, summarize(result));
        await client.query(
          `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
           VALUES ($1,$2,$3,'steps',1,$4)`,
          [uuidv7(), run.tenant_id, run.id, JSON.stringify({ step: run.current_step })]
        );
        this.emit(run.tenant_id, run.id, status, nextStep);
      });
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // Another worker took the run over; its result stands, ours rolled back.
        console.log(JSON.stringify({ at: "workflow_lease_lost", runId: run.id, step: run.current_step, worker: workerId }));
        return true;
      }
      await this.recordStepFailure(run, err, Date.now() - started);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  /** Drain helper used by tests and the dev server: run until idle. */
  async drain(workerId: string, maxSteps = 100): Promise<number> {
    let steps = 0;
    while (steps < maxSteps && (await this.runPendingOnce(workerId))) steps++;
    return steps;
  }

  async runWorkerLoop(workerId: string, opts: { intervalMs: number; signal: AbortSignal }): Promise<void> {
    while (!opts.signal.aborted) {
      const didWork = await this.runPendingOnce(workerId).catch((err) => {
        console.error("worker iteration failed:", err);
        return false;
      });
      if (!didWork) {
        await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
    }
  }

  private async journal(
    client: PoolClient | Pool,
    run: { id: string; tenant_id: string; current_step: string; attempts: number },
    status: "completed" | "failed",
    durationMs: number,
    outputSummary: string | null,
    error?: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO workflow_steps (id, tenant_id, run_id, seq, step, attempt, status,
         output_summary, error, duration_ms)
       VALUES ($1,$2,$3,
         (SELECT COALESCE(MAX(seq),0)+1 FROM workflow_steps WHERE run_id = $3),
         $4,$5,$6,$7,$8,$9)`,
      [uuidv7(), run.tenant_id, run.id, run.current_step, run.attempts + 1, status,
       outputSummary, error ?? null, durationMs]
    );
  }

  private async recordStepFailure(
    run: { id: string; tenant_id: string; current_step: string; attempts: number; max_attempts: number },
    err: unknown,
    durationMs: number
  ): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const attempts = run.attempts + 1;
    const exhausted = attempts >= run.max_attempts;
    // next_attempt_at is computed in DATABASE time — mixing in the JS clock
    // can push a 0ms-backoff retry microseconds past the claim query's now().
    await this.adminPool.query(
      `UPDATE workflow_runs SET status = $2, attempts = $3, last_error = $4,
         next_attempt_at = CASE WHEN $5::int IS NULL THEN NULL
                                ELSE now() + make_interval(secs => $5::int / 1000.0) END,
         claimed_by = NULL, claimed_at = NULL
       WHERE id = $1`,
      [run.id, exhausted ? "failed" : "pending", attempts, message,
       exhausted ? null : Math.round(this.backoffMs(attempts))]
    );
    await this.journal(this.adminPool, run, "failed", durationMs, null, message);
    this.emit(run.tenant_id, run.id, exhausted ? "failed" : "pending", run.current_step);
  }

  private async markFailed(run: { id: string; tenant_id: string; current_step: string }, message: string): Promise<void> {
    await this.adminPool.query(
      `UPDATE workflow_runs SET status = 'failed', last_error = $2, claimed_by = NULL, claimed_at = NULL
       WHERE id = $1`,
      [run.id, message]
    );
    this.emit(run.tenant_id, run.id, "failed", run.current_step);
  }

  private emit(tenantId: string, runId: string, status: WorkflowRunStatus, step: string): void {
    const event: WorkflowEvent = { type: "run_updated", tenantId, runId, status, step };
    this.events.emit("event", event);
  }
}
