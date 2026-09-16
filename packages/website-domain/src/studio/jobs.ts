import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";

/**
 * Agent jobs and their live timelines. A step is written the moment it
 * starts and the moment it ends — on a connection outside the workflow's
 * transaction, so the dashboard sees progress while a step is still
 * running — and mirrored onto the org's event stream. Nothing here is
 * scheduled for effect: a step appears because the code reached it.
 */

export type JobStatus = "queued" | "analyzing" | "editing" | "building" | "testing" | "repairing" | "verifying" | "complete" | "failed";
export interface JobStep { key: string; label: string; status: "pending" | "running" | "done" | "failed" | "skipped"; startedAt?: string; finishedAt?: string; detail?: string }

/** The one query shape the progress writer needs; a pg Pool satisfies it. */
export interface QueryLike { query: (text: string, params?: unknown[]) => Promise<unknown> }

export interface StudioServices {
  /** Platform pool for progress writes outside the step transaction. */
  pool: QueryLike;
  /** The org event bus (the SSE stream forwards anything with a tenantId). */
  emit: (event: Record<string, unknown>) => void;
}

export interface JobRow {
  id: string; tenant_id: string; site_id: string; run_id: string | null; kind: "edit" | "qa"; status: JobStatus;
  instruction: string | null; context: Record<string, unknown>; steps: JobStep[]; summary: string | null; error: string | null;
  result: Record<string, unknown>; release_before: string | null; release_after: string | null; created_by: string | null;
}

export async function createJob(client: QueryLike | PoolClient, args: { tenantId: string; siteId: string; kind: "edit" | "qa"; instruction?: string | null; context?: Record<string, unknown>; createdBy?: string | null; releaseBefore?: string | null }): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO site_jobs (id, tenant_id, site_id, kind, instruction, context, created_by, release_before) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, args.tenantId, args.siteId, args.kind, args.instruction ?? null, JSON.stringify(args.context ?? {}), args.createdBy ?? null, args.releaseBefore ?? null]);
  return id;
}

export async function loadJob(client: QueryLike, jobId: string): Promise<JobRow | null> {
  const { rows } = (await client.query("SELECT * FROM site_jobs WHERE id = $1", [jobId])) as { rows: JobRow[] };
  return rows[0] ?? null;
}

/** Progress writer for one job. Every mutation is a single UPDATE on the
 *  platform pool followed by an event, so it is visible immediately. */
export class JobProgress {
  private steps: JobStep[] = [];
  private status: JobStatus = "queued";
  constructor(private readonly services: StudioServices, private readonly job: { id: string; tenantId: string; siteId: string; kind: "edit" | "qa" }, initial: JobStep[] = [], status: JobStatus = "queued") {
    this.steps = initial;
    this.status = status;
  }

  get current(): JobStep[] { return this.steps; }

  /** Declares the steps the work will actually go through, all pending. */
  async plan(steps: Array<{ key: string; label: string }>, keep = true): Promise<void> {
    const existing = keep ? this.steps : [];
    const known = new Set(existing.map((s) => s.key));
    this.steps = [...existing, ...steps.filter((s) => !known.has(s.key)).map((s) => ({ ...s, status: "pending" as const }))];
    await this.flush();
  }

  async start(key: string, label?: string, status?: JobStatus): Promise<void> {
    const now = new Date().toISOString();
    const step = this.steps.find((s) => s.key === key);
    if (step) { step.status = "running"; step.startedAt = now; if (label) step.label = label; }
    else this.steps.push({ key, label: label ?? key, status: "running", startedAt: now });
    if (status) this.status = status;
    await this.flush();
  }

  async done(key: string, detail?: string): Promise<void> { await this.finish(key, "done", detail); }
  async fail(key: string, detail?: string): Promise<void> { await this.finish(key, "failed", detail); }
  async skip(key: string, detail?: string): Promise<void> { await this.finish(key, "skipped", detail); }

  private async finish(key: string, status: JobStep["status"], detail?: string): Promise<void> {
    const now = new Date().toISOString();
    const step = this.steps.find((s) => s.key === key);
    if (step) { step.status = status; step.finishedAt = now; if (detail !== undefined) step.detail = detail; }
    else this.steps.push({ key, label: key, status, startedAt: now, finishedAt: now, detail });
    await this.flush();
  }

  async setStatus(status: JobStatus): Promise<void> { this.status = status; await this.flush(); }

  async complete(args: { status: "complete" | "failed"; summary?: string | null; error?: string | null; result?: Record<string, unknown>; releaseAfter?: string | null }): Promise<void> {
    this.status = args.status;
    // Whatever was still running when the job ended is closed honestly.
    for (const s of this.steps) if (s.status === "running") { s.status = args.status === "complete" ? "done" : "failed"; s.finishedAt = new Date().toISOString(); }
    for (const s of this.steps) if (s.status === "pending") s.status = "skipped";
    await this.services.pool.query(
      `UPDATE site_jobs SET status = $2, steps = $3, summary = COALESCE($4, summary), error = $5, result = result || $6::jsonb,
              release_after = COALESCE($7, release_after), finished_at = now() WHERE id = $1`,
      [this.job.id, args.status, JSON.stringify(this.steps), args.summary ?? null, args.error ?? null, JSON.stringify(args.result ?? {}), args.releaseAfter ?? null]);
    this.emit();
  }

  async merge(result: Record<string, unknown>): Promise<void> {
    await this.services.pool.query("UPDATE site_jobs SET result = result || $2::jsonb WHERE id = $1", [this.job.id, JSON.stringify(result)]);
  }

  private async flush(): Promise<void> {
    await this.services.pool.query("UPDATE site_jobs SET status = $2, steps = $3 WHERE id = $1", [this.job.id, this.status, JSON.stringify(this.steps)]);
    this.emit();
  }

  private emit(): void {
    try { this.services.emit({ type: `site_job:${this.job.kind}`, tenantId: this.job.tenantId, siteId: this.job.siteId, jobId: this.job.id, status: this.status, steps: this.steps }); } catch { /* best effort */ }
  }
}
