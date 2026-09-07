import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { loadMissionProfile, missionProfileBlock, tenantFileKey, uuidv7, withContext } from "@deedwell/database";
import { createImageGenerator, readProviderKey } from "@deedwell/content-domain";
import { getTaskHandler, nextCronRun, type TaskHandlerContext } from "@deedwell/tasks-domain";
import { billingState } from "../billing-gate.js";
import type { Deps } from "../bootstrap.js";
import { teammateByKey } from "../teammates.js";
import { emitTaskUpdated, postAgentMessage, taskCard } from "./chat.js";
import { addTaskEvent, agentName as displayName, deliverableView, taskView } from "./store.js";

/**
 * The task runner. One tick claims due tasks across every tenant (admin
 * pool, SKIP LOCKED — the same lease pattern as the workflow engine) and
 * executes each under its own tenant context:
 *
 *   claim → approval gate → billing gate → run → store deliverables →
 *   meter tokens → post to chat → schedule the next run (or finish)
 *
 * Failures retry with backoff a few times, then the task is marked failed
 * and the teammate says so in chat. Nothing here knows what a handler does.
 */
const MAX_ATTEMPTS = Number(process.env.TASKS_MAX_ATTEMPTS ?? 3);
const STALE_CLAIM_MINUTES = Number(process.env.TASKS_STALE_CLAIM_MINUTES ?? 20);
const backoffMs = (attempt: number) => Math.min(2 ** attempt * 60_000, 60 * 60_000);

export interface TaskTickStats { claimed: number; completed: number; waiting: number; blocked: number; failed: number }

export async function runTaskTick(deps: Deps, now = new Date(), limit = 3, workerId = `tasks-${process.pid}`): Promise<TaskTickStats> {
  const stats: TaskTickStats = { claimed: 0, completed: 0, waiting: 0, blocked: 0, failed: 0 };
  const { rows } = await deps.adminPool.query(
    `UPDATE agent_tasks SET claimed_by = $3, claimed_at = $1
      WHERE id IN (
        SELECT id FROM agent_tasks
         WHERE status = 'queued' AND next_run_at IS NOT NULL AND next_run_at <= $1 AND paused = false
           AND (claimed_at IS NULL OR claimed_at < $1 - make_interval(mins => $4))
           AND NOT EXISTS (SELECT 1 FROM agent_tasks d WHERE d.id = ANY(agent_tasks.depends_on) AND d.status <> 'completed')
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, next_run_at
         LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now, limit, workerId, STALE_CLAIM_MINUTES]
  );
  stats.claimed = rows.length;
  for (const row of rows) {
    try {
      const outcome = await executeTask(deps, row, now, workerId);
      stats[outcome] += 1;
    } catch (err) {
      console.error(JSON.stringify({ at: "tasks.tick_error", taskId: row.id, err: String((err as Error)?.message ?? err) }));
      await deps.adminPool.query(`UPDATE agent_tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = $1`, [row.id]).catch(() => undefined);
    }
  }
  return stats;
}

type Outcome = "completed" | "waiting" | "blocked" | "failed";

async function executeTask(deps: Deps, row: Record<string, any>, now: Date, workerId: string): Promise<Outcome> {
  const tenantId: string = row.tenant_id;
  const userId: string = row.created_by;
  const agentKey: string = row.agent_key;
  const mate = teammateByKey.get(agentKey);
  const agentName = displayName(agentKey);

  return withContext(deps.appPool, { tenantId, userId }, async (client): Promise<Outcome> => {
    const post = async (body: string, metadata: Record<string, unknown> = {}) => {
      if (!row.channel_id) return;
      await postAgentMessage(deps, client, { tenantId, channelId: row.channel_id, agentKey, body, metadata: { taskId: row.id, ...metadata } });
    };
    const card = async () => taskCard(taskView((await client.query("SELECT * FROM agent_tasks WHERE id = $1", [row.id])).rows[0]));

    // Approval gate: sensitive work waits for a person, every run unless
    // they approved "always".
    if (row.requires_approval && !row.metadata?.approvedForRun) {
      await client.query(`UPDATE agent_tasks SET status = 'waiting_approval', claimed_by = NULL, claimed_at = NULL WHERE id = $1`, [row.id]);
      await addTaskEvent(client, { tenantId, taskId: row.id, kind: "approval_requested", actorKind: "agent", actorAgent: agentKey, message: `${agentName} is asking for approval before starting` });
      await post(`Before I start on "${row.title}", I need your go-ahead. Approve when you're ready, or reject to skip it.`, { taskApproval: true, taskCard: await card() });
      emitTaskUpdated(deps, tenantId, row.id, "waiting_approval");
      return "waiting";
    }

    // Billing gate: no tokens, no work — the task waits, nothing is lost.
    if ((await billingState(client, tenantId)).blocked) {
      await client.query(`UPDATE agent_tasks SET status = 'blocked', blocked_reason = 'out_of_tokens', claimed_by = NULL, claimed_at = NULL WHERE id = $1`, [row.id]);
      await addTaskEvent(client, { tenantId, taskId: row.id, kind: "blocked", level: "warn", message: "Out of tokens — the task resumes after a top-up" });
      emitTaskUpdated(deps, tenantId, row.id, "blocked");
      return "blocked";
    }

    const runId = uuidv7();
    const runNumber = Number(row.run_count ?? 0) + 1;
    await client.query(`INSERT INTO agent_task_runs (id, tenant_id, task_id, status) VALUES ($1,$2,$3,'in_progress')`, [runId, tenantId, row.id]);
    await client.query(`UPDATE agent_tasks SET status = 'in_progress', attempts = attempts + 1, blocked_reason = NULL, last_run_at = $2 WHERE id = $1`, [row.id, now]);
    const synthesis = Boolean(row.metadata?.synthesis);
    await addTaskEvent(client, { tenantId, taskId: row.id, runId, kind: "started", actorKind: "agent", actorAgent: agentKey, message: synthesis ? "Every step is in — bringing the results together" : row.is_recurring ? `Run #${runNumber} started` : "Started working" });
    emitTaskUpdated(deps, tenantId, row.id, "in_progress");
    if (row.parent_id) await stepStarted(deps, client, row);
    if (!row.is_recurring || runNumber === 1) {
      await post(synthesis ? `All the steps of "${row.title}" are done — I'm pulling them together now.` : `I've started on "${row.title}". I'll post here when it's done.`, { taskUpdate: "started", taskCard: await card() });
    }

    const profile = await loadMissionProfile(client, deps.storage, tenantId).catch(() => null);
    const steps = synthesis ? await finishedSteps(client, row.id) : undefined;
    const ctx: TaskHandlerContext = {
      task: {
        id: row.id, tenantId, title: row.title, description: row.description ?? "", instructions: row.instructions ?? "",
        agentKey, taskType: row.task_type, priority: row.priority, tags: row.tags ?? [], isRecurring: row.is_recurring, runNumber,
        metadata: row.metadata ?? {}, steps,
      },
      agent: { agentKey, name: agentName, role: mate?.role ?? "Teammate", team: mate?.team ?? "core", bio: mate?.bio },
      missionProfile: profile ? missionProfileBlock(profile) : "",
      model: deps.provider,
      now,
      progress: (message) => addTaskEvent(client, { tenantId, taskId: row.id, runId, kind: "progress", level: "progress", actorKind: "agent", actorAgent: agentKey, message }).then(() => undefined),
    };

    try {
      const handler = getTaskHandler(synthesis ? "workflow" : row.task_type);
      const result = await handler.run(ctx);
      for (const note of result.progressNotes) await ctx.progress(note);

      // Token usage: one ledger row per run; the billing trigger debits it.
      if (result.tokensUsed > 0) {
        await client.query(
          `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',$3,$4)`,
          [uuidv7(), tenantId, result.tokensUsed, JSON.stringify({ source: "task", taskId: row.id, taskRunId: runId, agentKey })]
        );
      }

      if (result.needsFromUser) {
        await client.query(
          `UPDATE agent_task_runs SET status = 'blocked', finished_at = now(), tokens_used = $2, summary = $3 WHERE id = $1`,
          [runId, result.tokensUsed, result.needsFromUser]
        );
        await client.query(
          `UPDATE agent_tasks SET status = 'blocked', blocked_reason = 'needs_input', claimed_by = NULL, claimed_at = NULL,
                  tokens_used = tokens_used + $2, metadata = metadata || jsonb_build_object('question', $3::text) WHERE id = $1`,
          [row.id, result.tokensUsed, result.needsFromUser]
        );
        await addTaskEvent(client, { tenantId, taskId: row.id, runId, kind: "blocked", level: "warn", actorKind: "agent", actorAgent: agentKey, message: `Needs an answer: ${result.needsFromUser}` });
        await post(`Quick question before I can finish "${row.title}": ${result.needsFromUser}`, { taskQuestion: result.needsFromUser, taskCard: await card() });
        emitTaskUpdated(deps, tenantId, row.id, "blocked");
        return "blocked";
      }

      const stored = await storeDeliverables(deps, client, { tenantId, userId, taskId: row.id, runId, agentKey, title: row.title, result, log: ctx.progress });

      await client.query(
        `UPDATE agent_task_runs SET status = 'completed', finished_at = now(), tokens_used = $2, summary = $3 WHERE id = $1`,
        [runId, result.tokensUsed, result.summary]
      );

      // Delegation: the teammate handed parts to others. Those become steps
      // of this task; it stays in progress and synthesises once they finish.
      const handoffs = row.is_recurring ? [] : result.handoffs.filter((h) => teammateByKey.has(h.agentKey) && h.agentKey !== agentKey);
      if (handoffs.length) {
        const { rows: existing } = await client.query("SELECT count(*)::int AS n FROM agent_tasks WHERE parent_id = $1", [row.id]);
        const names: string[] = [];
        for (const [i, h] of handoffs.entries()) {
          const stepId = uuidv7();
          await client.query(
            `INSERT INTO agent_tasks (id, tenant_id, parent_id, position, title, instructions, agent_key, task_type, priority, status, tags, timezone, next_run_at, channel_id, created_from, created_by, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'general',$8,'queued',$9,$10,now(),$11,$12,$13,'{"handoff":true}')`,
            [stepId, tenantId, row.id, Number(existing[0]?.n ?? 0) + i, h.title, h.instructions, h.agentKey, row.priority, row.tags ?? [], row.timezone || "UTC", row.channel_id, row.created_from, userId]
          );
          await addTaskEvent(client, { tenantId, taskId: stepId, kind: "created", actorKind: "agent", actorAgent: agentKey, message: `Handed off by ${agentName}: ${h.title}`, metadata: { parentId: row.id } });
          names.push(`${displayName(h.agentKey)} — ${h.title}`);
        }
        await client.query(
          `UPDATE agent_tasks SET status = 'in_progress', next_run_at = NULL, tokens_used = tokens_used + $2, attempts = 0, claimed_by = NULL, claimed_at = NULL,
                  metadata = (metadata - 'synthesis') || '{"awaitingSteps": true}'::jsonb WHERE id = $1`,
          [row.id, result.tokensUsed]
        );
        await addTaskEvent(client, { tenantId, taskId: row.id, runId, kind: "delegated", actorKind: "agent", actorAgent: agentKey, message: `${result.summary} Handed off: ${names.join("; ")}`, metadata: { steps: handoffs.length } });
        await post(`${result.summary} I've handed part of this to ${handoffs.map((h) => displayName(h.agentKey)).join(" and ")}; I'll wrap it up once they're done.`, { taskUpdate: "delegated", taskCard: await card() });
        emitTaskUpdated(deps, tenantId, row.id, "in_progress");
        return "completed";
      }
      const next = row.is_recurring && row.cron_expression ? nextCronRun(row.cron_expression, new Date(), row.timezone || "UTC") : null;
      await client.query(
        `UPDATE agent_tasks SET
           status = $2, next_run_at = $3, last_run_status = 'completed', run_count = run_count + 1, attempts = 0,
           tokens_used = tokens_used + $4, claimed_by = NULL, claimed_at = NULL,
           completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
           metadata = (CASE WHEN requires_approval THEN metadata - 'approvedForRun' ELSE metadata END) - 'synthesis' - 'awaitingSteps'
         WHERE id = $1`,
        [row.id, next ? "queued" : "completed", next, result.tokensUsed]
      );
      if (row.parent_id) await stepFinished(deps, client, row, "completed");
      await addTaskEvent(client, {
        tenantId, taskId: row.id, runId, kind: "completed", actorKind: "agent", actorAgent: agentKey,
        message: result.summary, metadata: { deliverables: stored.length, tokens: result.tokensUsed, nextRunAt: next?.toISOString() ?? null },
      });
      const list = stored.length ? `\n\n${stored.map((d) => `• ${d.title}`).join("\n")}` : "";
      await post(
        `${row.is_recurring ? `Run #${runNumber} of "${row.title}" is done.` : `"${row.title}" is done.`} ${result.summary}${list}${next ? `\n\nNext run: ${next.toLocaleString("en-US", { timeZone: row.timezone || "UTC", dateStyle: "medium", timeStyle: "short" })}.` : ""}`,
        { taskUpdate: "completed", taskCard: await card(), taskDeliverables: stored }
      );
      emitTaskUpdated(deps, tenantId, row.id, next ? "queued" : "completed");
      return "completed";
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      const attempts = Number(row.attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await client.query(`UPDATE agent_task_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [runId, message]);
      await client.query(
        `UPDATE agent_tasks SET status = $2, next_run_at = $3, last_run_status = 'failed', claimed_by = NULL, claimed_at = NULL, blocked_reason = NULL WHERE id = $1`,
        [row.id, giveUp ? "failed" : "queued", giveUp ? null : new Date(Date.now() + backoffMs(attempts))]
      );
      await addTaskEvent(client, {
        tenantId, taskId: row.id, runId, kind: "failed", level: "error", actorKind: "system",
        message: giveUp ? `Failed after ${attempts} attempts: ${message}` : `Attempt ${attempts} failed, retrying: ${message}`,
      });
      if (giveUp) await post(`I couldn't finish "${row.title}": ${message}. You can retry it from Tasks once that's sorted.`, { taskUpdate: "failed", taskCard: await card() });
      if (giveUp && row.parent_id) await stepFinished(deps, client, row, "failed");
      emitTaskUpdated(deps, tenantId, row.id, giveUp ? "failed" : "queued");
      console.error(JSON.stringify({ at: "tasks.run_failed", taskId: row.id, runId, attempts, giveUp, worker: workerId, err: message }));
      return "failed";
    }
  });
}

/** A coordinating task moves to in_progress the moment its first step starts. */
async function stepStarted(deps: Deps, client: PoolClient, step: Record<string, any>): Promise<void> {
  const { rows } = await client.query(
    `UPDATE agent_tasks SET status = 'in_progress', last_run_at = coalesce(last_run_at, now()) WHERE id = $1 AND status = 'queued' RETURNING id`,
    [step.parent_id]
  );
  if (rows[0]) emitTaskUpdated(deps, step.tenant_id, step.parent_id, "in_progress");
}

/** When the last step finishes, the parent is scheduled to synthesise; a
 *  failed step blocks the parent and every step that depended on it. */
async function stepFinished(deps: Deps, client: PoolClient, step: Record<string, any>, outcome: "completed" | "failed"): Promise<void> {
  const tenantId: string = step.tenant_id;
  const parentId: string = step.parent_id;
  if (outcome === "failed") {
    await client.query(
      `UPDATE agent_tasks SET status = 'blocked', blocked_reason = 'dependency_failed', next_run_at = NULL
        WHERE parent_id = $1 AND status = 'queued' AND $2 = ANY(depends_on)`,
      [parentId, step.id]
    );
    await client.query(`UPDATE agent_tasks SET status = 'blocked', blocked_reason = 'step_failed', claimed_by = NULL, claimed_at = NULL WHERE id = $1 AND status IN ('queued','in_progress')`, [parentId]);
    await addTaskEvent(client, { tenantId, taskId: parentId, kind: "blocked", level: "warn", message: `Step "${step.title}" failed — fix or retry it, then run the workflow again` });
    emitTaskUpdated(deps, tenantId, parentId, "blocked");
    return;
  }
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE status <> 'completed')::int AS open, count(*)::int AS total FROM agent_tasks WHERE parent_id = $1`,
    [parentId]
  );
  await addTaskEvent(client, { tenantId, taskId: parentId, kind: "progress", level: "progress", actorKind: "agent", actorAgent: step.agent_key, message: `Step done: ${step.title} (${rows[0].total - rows[0].open}/${rows[0].total})` });
  if (rows[0]?.open === 0) {
    await client.query(
      `UPDATE agent_tasks SET status = 'queued', next_run_at = now(), blocked_reason = NULL, claimed_by = NULL, claimed_at = NULL,
              metadata = (metadata - 'awaitingSteps') || '{"synthesis": true}'::jsonb
        WHERE id = $1 AND status IN ('queued','in_progress','blocked')`,
      [parentId]
    );
  }
  emitTaskUpdated(deps, tenantId, parentId, rows[0]?.open === 0 ? "queued" : "in_progress");
}

/** Everything the steps produced, for the synthesis prompt. */
async function finishedSteps(client: PoolClient, parentId: string) {
  const { rows } = await client.query(
    `SELECT t.id, t.title, t.agent_key, t.status,
            (SELECT r.summary FROM agent_task_runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC LIMIT 1) AS summary
       FROM agent_tasks t WHERE t.parent_id = $1 ORDER BY t.position, t.created_at`,
    [parentId]
  );
  const out = [];
  for (const s of rows) {
    const docs = await client.query(
      `SELECT d.title, v.content->>'body' AS body FROM agent_task_deliverables d
         JOIN artifact_versions v ON v.artifact_id = d.artifact_id
        WHERE d.task_id = $1 AND d.kind = 'markdown' ORDER BY d.created_at`,
      [s.id]
    );
    out.push({ title: s.title, agentName: displayName(s.agent_key), status: s.status, summary: s.summary ?? null,
      deliverables: docs.rows.map((d) => ({ title: d.title, body: String(d.body ?? "").slice(0, 20000) })) });
  }
  return out;
}

async function ensureTasksProject(client: PoolClient, tenantId: string, userId: string): Promise<string> {
  const existing = await client.query("SELECT id FROM projects WHERE tenant_id = $1 AND name = 'Agent Tasks' LIMIT 1", [tenantId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = uuidv7();
  await client.query("INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,'Agent Tasks','other',$3)", [id, tenantId, userId]);
  return id;
}

async function storeDeliverables(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; taskId: string; runId: string; agentKey: string; title: string;
  result: { deliverables: Array<{ title: string; body: string }>; imageRequests: Array<{ title: string; prompt: string }> };
  log: (m: string) => Promise<void>;
}) {
  const out: Array<ReturnType<typeof deliverableView>> = [];
  const projectId = args.result.deliverables.length ? await ensureTasksProject(client, args.tenantId, args.userId) : null;
  for (const doc of args.result.deliverables) {
    const artifactId = uuidv7();
    await client.query(
      `INSERT INTO artifacts (id, tenant_id, project_id, run_id, type, title, current_version) VALUES ($1,$2,$3,NULL,'task_deliverable',$4,1)`,
      [artifactId, args.tenantId, projectId, doc.title]
    );
    await client.query(
      `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content, created_by_kind, created_by_agent, change_summary)
       VALUES ($1,$2,$3,1,$4,'agent',$5,$6)`,
      [uuidv7(), args.tenantId, artifactId, JSON.stringify({ body: doc.body, wordCount: doc.body.split(/\s+/).length, taskId: args.taskId, runId: args.runId }), args.agentKey, `Deliverable for task "${args.title}"`]
    );
    const id = uuidv7();
    const { rows } = await client.query(
      `INSERT INTO agent_task_deliverables (id, tenant_id, task_id, run_id, kind, title, artifact_id, mime, size_bytes)
       VALUES ($1,$2,$3,$4,'markdown',$5,$6,'text/markdown',$7) RETURNING *`,
      [id, args.tenantId, args.taskId, args.runId, doc.title, artifactId, Buffer.byteLength(doc.body, "utf8")]
    );
    out.push(deliverableView(rows[0]));
    await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, runId: args.runId, kind: "deliverable", actorKind: "agent", actorAgent: args.agentKey, message: `Delivered "${doc.title}"`, metadata: { deliverableId: id, kind: "markdown" } });
  }
  if (args.result.imageRequests.length) {
    const generator = createImageGenerator({ apiKey: await readProviderKey(deps.appPool, "openai").catch(() => null) });
    for (const req of args.result.imageRequests) {
      try {
        await args.log(`Rendering image: ${req.title}`);
        const image = await generator.generate(req.prompt, "1024x1024");
        const fileId = uuidv7();
        const ext = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
        const filename = `${req.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "image"}.${ext}`;
        const key = tenantFileKey(args.tenantId, fileId, filename);
        await deps.storage.put(key, image.bytes);
        await client.query(
          `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
          [fileId, args.tenantId, filename, image.mime, image.bytes.length, createHash("sha256").update(image.bytes).digest("hex"), key, args.userId]
        );
        const id = uuidv7();
        const { rows } = await client.query(
          `INSERT INTO agent_task_deliverables (id, tenant_id, task_id, run_id, kind, title, file_id, mime, size_bytes, metadata)
           VALUES ($1,$2,$3,$4,'image',$5,$6,$7,$8,$9) RETURNING *`,
          [id, args.tenantId, args.taskId, args.runId, req.title, fileId, image.mime, image.bytes.length, JSON.stringify({ prompt: req.prompt, model: generator.model })]
        );
        out.push(deliverableView(rows[0]));
        await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, runId: args.runId, kind: "deliverable", actorKind: "agent", actorAgent: args.agentKey, message: `Delivered image "${req.title}"`, metadata: { deliverableId: id, kind: "image" } });
      } catch (err) {
        await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, runId: args.runId, kind: "log", level: "warn", message: `Image "${req.title}" could not be rendered: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
      }
    }
  }
  return out;
}
