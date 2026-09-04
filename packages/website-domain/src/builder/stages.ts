import { createHash } from "node:crypto";
import { uuidv7 } from "@deedwell/database";

/**
 * Stage runner: every generation stage goes through here so its structured
 * output is stored, logged, and reused when its input has not changed. A
 * stage is retried on its own by deleting its row (see resetStage) and
 * running the build again — everything downstream re-derives from it,
 * everything upstream is reused.
 */

export interface StageDb {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface StageContext {
  db: StageDb;
  tenantId: string;
  siteId: string;
  runId: string | null;
}

export function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function runStage<T>(
  ctx: StageContext,
  args: { stage: string; scope?: string; input: unknown; model?: string; force?: boolean },
  fn: () => Promise<T>
): Promise<{ output: T; reused: boolean; ms: number }> {
  const scope = args.scope ?? "";
  const inputHash = hashInput(args.input);
  if (!args.force) {
    const { rows } = await ctx.db.query(
      "SELECT output, input_hash FROM site_build_stages WHERE site_id = $1 AND stage = $2 AND scope = $3",
      [ctx.siteId, args.stage, scope]
    );
    if (rows[0] && rows[0].input_hash === inputHash) {
      console.log(JSON.stringify({ at: "site_stage_reused", stage: args.stage, scope, siteId: ctx.siteId }));
      return { output: rows[0].output as T, reused: true, ms: 0 };
    }
  }
  const started = Date.now();
  const output = await fn();
  const ms = Date.now() - started;
  await ctx.db.query(
    `INSERT INTO site_build_stages (id, tenant_id, site_id, run_id, stage, scope, input_hash, output, model, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (site_id, stage, scope) DO UPDATE SET
       run_id = EXCLUDED.run_id, input_hash = EXCLUDED.input_hash, output = EXCLUDED.output,
       model = EXCLUDED.model, duration_ms = EXCLUDED.duration_ms, created_at = now()`,
    [uuidv7(), ctx.tenantId, ctx.siteId, ctx.runId, args.stage, scope, inputHash, JSON.stringify(output), args.model ?? null, ms]
  );
  console.log(JSON.stringify({
    at: "site_stage", stage: args.stage, scope, siteId: ctx.siteId, ms,
    summary: summarizeOutput(output),
  }));
  return { output, reused: false, ms };
}

export async function readStage<T>(ctx: StageContext, stage: string, scope = ""): Promise<T | null> {
  const { rows } = await ctx.db.query(
    "SELECT output FROM site_build_stages WHERE site_id = $1 AND stage = $2 AND scope = $3",
    [ctx.siteId, stage, scope]
  );
  return (rows[0]?.output as T) ?? null;
}

export async function resetStage(ctx: StageContext, stage: string, scope?: string): Promise<number> {
  const { rows } = await ctx.db.query(
    scope === undefined
      ? "DELETE FROM site_build_stages WHERE site_id = $1 AND stage = $2 RETURNING id"
      : "DELETE FROM site_build_stages WHERE site_id = $1 AND stage = $2 AND scope = $3 RETURNING id",
    scope === undefined ? [ctx.siteId, stage] : [ctx.siteId, stage, scope]
  );
  return rows.length;
}

function summarizeOutput(output: unknown): string {
  const s = JSON.stringify(output);
  return s.length > 300 ? `${s.slice(0, 300)}…(${s.length} chars)` : s;
}
