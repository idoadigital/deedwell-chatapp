import type { PoolClient } from "pg";
import { audit, uuidv7 } from "@deedwell/database";
import type { CreateTaskInput, UpdateTaskInput } from "@deedwell/schemas";
import { CronError, describeCron, isValidCron, isValidTimeZone, nextCronRun } from "@deedwell/tasks-domain";
import { HttpError } from "../app.js";
import { teammateByKey } from "../teammates.js";

/** First name only — the roster's displayName carries the role too. */
export const agentName = (agentKey: string | null | undefined): string => (agentKey && teammateByKey.get(agentKey)?.name) || agentKey || "Teammate";

/** Row → the one shape the API returns. Internal claim columns stay out. */
export function taskView(row: Record<string, any>) {
  const mate = teammateByKey.get(row.agent_key);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    agentKey: row.agent_key,
    agentName: agentName(row.agent_key),
    agentRole: mate?.role ?? null,
    taskType: row.task_type,
    priority: row.priority,
    status: row.status,
    tags: row.tags ?? [],
    dueAt: row.due_at,
    isRecurring: row.is_recurring,
    cronExpression: row.cron_expression,
    scheduleLabel: row.is_recurring && row.cron_expression ? describeCron(row.cron_expression) : null,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    requiresApproval: row.requires_approval,
    channelId: row.channel_id,
    createdFrom: row.created_from,
    createdBy: row.created_by,
    tokensUsed: Number(row.tokens_used ?? 0),
    blockedReason: row.blocked_reason,
    parentId: row.parent_id ?? null,
    dependsOn: row.depends_on ?? [],
    position: row.position ?? 0,
    paused: Boolean(row.paused),
    stepCount: row.step_count != null ? Number(row.step_count) : 0,
    stepsDone: row.steps_done != null ? Number(row.steps_done) : 0,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}
export type TaskView = ReturnType<typeof taskView>;

function scheduleFor(input: { isRecurring?: boolean; cronExpression?: string | null; timezone?: string; runAt?: string | null }, now: Date) {
  const timezone = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : "UTC";
  if (input.isRecurring) {
    const cron = (input.cronExpression ?? "").trim();
    if (!cron || !isValidCron(cron)) throw new HttpError(400, "A recurring task needs a valid schedule (five-field cron, e.g. \"0 9 * * 1\").");
    const next = nextCronRun(cron, now, timezone);
    if (!next) throw new HttpError(400, "That schedule never comes due.");
    return { cron, timezone, nextRunAt: next };
  }
  const runAt = input.runAt ? new Date(input.runAt) : null;
  if (runAt && Number.isNaN(runAt.getTime())) throw new HttpError(400, "runAt must be a date");
  return { cron: null, timezone, nextRunAt: runAt && runAt > now ? runAt : now };
}

async function defaultChannel(client: PoolClient, tenantId: string, agentKey: string): Promise<string | null> {
  // An org that has never opened chat has no channels yet; the teammate
  // still needs somewhere to report, so provision the defaults first.
  const { ensureChannels } = await import("../assistant.js");
  await ensureChannels(client, tenantId).catch(() => undefined);
  const dm = await client.query("SELECT id FROM channels WHERE tenant_id = $1 AND key = $2", [tenantId, `dm:${agentKey}`]);
  if (dm.rows[0]) return dm.rows[0].id;
  const general = await client.query("SELECT id FROM channels WHERE tenant_id = $1 AND key = 'general'", [tenantId]);
  return general.rows[0]?.id ?? null;
}

export async function addTaskEvent(client: PoolClient, args: {
  tenantId: string; taskId: string; runId?: string | null; kind: string; message: string;
  level?: "info" | "progress" | "warn" | "error"; actorKind?: "agent" | "user" | "system";
  actorAgent?: string | null; actorUser?: string | null; metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO agent_task_events (id, tenant_id, task_id, run_id, kind, level, message, actor_kind, actor_agent, actor_user, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, args.tenantId, args.taskId, args.runId ?? null, args.kind, args.level ?? "info", args.message,
     args.actorKind ?? "system", args.actorAgent ?? null, args.actorUser ?? null, JSON.stringify(args.metadata ?? {})]
  );
  return id;
}

export async function createTask(client: PoolClient, args: {
  tenantId: string; userId: string; input: CreateTaskInput; createdFrom: "dashboard" | "chat"; now?: Date;
}): Promise<TaskView> {
  const { input } = args;
  const now = args.now ?? new Date();
  if (!teammateByKey.has(input.agentKey)) throw new HttpError(400, "Choose a teammate to assign this to.");
  let schedule;
  try { schedule = scheduleFor(input, now); } catch (err) { if (err instanceof CronError) throw new HttpError(400, err.message); throw err; }
  const id = uuidv7();
  const channelId = input.channelId ?? (await defaultChannel(client, args.tenantId, input.agentKey));
  const steps = input.steps ?? [];
  if (steps.length && input.isRecurring) throw new HttpError(400, "A multi-step workflow runs once; make the steps a routine individually if they repeat.");
  for (const s of steps) if (!teammateByKey.has(s.agentKey)) throw new HttpError(400, `Unknown teammate for step "${s.title}"`);
  // A coordinator with steps waits for them: it has no run time of its own
  // until the last step finishes, when the runner schedules its synthesis.
  const { rows } = await client.query(
    `INSERT INTO agent_tasks
       (id, tenant_id, title, description, instructions, agent_key, task_type, priority, status, tags, due_at,
        is_recurring, cron_expression, timezone, next_run_at, requires_approval, channel_id, created_from, created_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [id, args.tenantId, input.title, input.description ?? "", input.instructions ?? "", input.agentKey,
     steps.length ? "workflow" : (input.taskType ?? "general"),
     input.priority ?? "normal", input.tags ?? [], input.dueAt ? new Date(input.dueAt) : null,
     Boolean(input.isRecurring), schedule.cron, schedule.timezone, steps.length ? null : schedule.nextRunAt, Boolean(input.requiresApproval),
     channelId, args.createdFrom, args.userId, JSON.stringify(steps.length ? { awaitingSteps: true } : {})]
  );
  let previous: string | null = null;
  for (const [i, step] of steps.entries()) {
    const stepId = uuidv7();
    await client.query(
      `INSERT INTO agent_tasks
         (id, tenant_id, parent_id, position, depends_on, title, description, instructions, agent_key, task_type, priority, status, tags,
          timezone, next_run_at, requires_approval, channel_id, created_from, created_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,'queued',$11,$12,$13,false,$14,$15,$16,'{}')`,
      [stepId, args.tenantId, id, i, input.stepsInParallel || !previous ? [] : [previous], step.title, step.instructions ?? "",
       step.agentKey, step.taskType ?? "general", input.priority ?? "normal", input.tags ?? [], schedule.timezone, schedule.nextRunAt,
       channelId, args.createdFrom, args.userId]
    );
    await addTaskEvent(client, { tenantId: args.tenantId, taskId: stepId, kind: "created", actorKind: "user", actorUser: args.userId, message: `Step ${i + 1} of "${input.title}"`, metadata: { parentId: id } });
    previous = stepId;
  }
  rows[0].step_count = steps.length;
  rows[0].steps_done = 0;
  await addTaskEvent(client, {
    tenantId: args.tenantId, taskId: id, kind: "created", actorKind: "user", actorUser: args.userId,
    message: steps.length
      ? `Workflow created — ${steps.length} step${steps.length === 1 ? "" : "s"} across ${new Set(steps.map((s) => agentName(s.agentKey))).size} teammate(s), ${input.stepsInParallel ? "in parallel" : "in sequence"}`
      : input.isRecurring
      ? `Task created — ${describeCron(schedule.cron!)}, first run ${schedule.nextRunAt.toISOString()}`
      : schedule.nextRunAt > now ? `Task created — scheduled for ${schedule.nextRunAt.toISOString()}` : "Task created and queued",
    metadata: { from: args.createdFrom },
  });
  await audit(client, {
    tenantId: args.tenantId, actorUser: args.userId, action: "task.created", entityType: "agent_tasks", entityId: id,
    metadata: { agentKey: input.agentKey, recurring: Boolean(input.isRecurring), from: args.createdFrom },
  });
  return taskView(rows[0]);
}

export interface TaskFilters {
  q?: string; status?: string[]; agentKey?: string; priority?: string; recurring?: "true" | "false";
  tag?: string; due?: "overdue" | "today" | "week" | "none"; taskType?: string;
}

export async function listTasks(client: PoolClient, tenantId: string, f: TaskFilters = {}): Promise<TaskView[]> {
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.q) {
    params.push(`%${f.q}%`);
    const n = params.length;
    where.push(`(title ILIKE $${n} OR description ILIKE $${n} OR instructions ILIKE $${n} OR array_to_string(tags, ' ') ILIKE $${n})`);
  }
  if (f.status?.length) add("status = ANY(?::text[])", f.status);
  if (f.agentKey) add("agent_key = ?", f.agentKey);
  if (f.priority) add("priority = ?", f.priority);
  if (f.taskType) add("task_type = ?", f.taskType);
  if (f.recurring === "true") where.push("is_recurring = true");
  if (f.recurring === "false") where.push("is_recurring = false");
  if (f.tag) add("? = ANY(tags)", f.tag);
  if (f.due === "overdue") where.push("due_at IS NOT NULL AND due_at < now() AND status NOT IN ('completed','cancelled')");
  if (f.due === "today") where.push("due_at IS NOT NULL AND due_at::date = now()::date");
  if (f.due === "week") where.push("due_at IS NOT NULL AND due_at >= now() AND due_at < now() + interval '7 days'");
  if (f.due === "none") where.push("due_at IS NULL");
  where.push("parent_id IS NULL");
  const { rows } = await client.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM agent_tasks s WHERE s.parent_id = t.id) AS step_count,
            (SELECT count(*)::int FROM agent_tasks s WHERE s.parent_id = t.id AND s.status = 'completed') AS steps_done
       FROM agent_tasks t WHERE ${where.join(" AND ")}
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'waiting_approval' THEN 1 WHEN 'blocked' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
               CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               coalesce(due_at, next_run_at, created_at) ASC, created_at DESC
      LIMIT 500`,
    params
  );
  return rows.map(taskView);
}

export async function getTaskRow(client: PoolClient, taskId: string): Promise<Record<string, any>> {
  const { rows } = await client.query("SELECT * FROM agent_tasks WHERE id = $1", [taskId]);
  if (!rows[0]) throw new HttpError(404, "Task not found");
  return rows[0];
}

export async function getTaskDetail(client: PoolClient, taskId: string) {
  const row = await getTaskRow(client, taskId);
  const [runs, events, deliverables, steps, parent] = await Promise.all([
    client.query(`SELECT * FROM agent_task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT 50`, [taskId]),
    client.query(`SELECT * FROM agent_task_events WHERE task_id = $1 ORDER BY created_at ASC LIMIT 500`, [taskId]),
    client.query(`SELECT d.*, a.current_version, t.title AS task_title FROM agent_task_deliverables d
                   LEFT JOIN artifacts a ON a.id = d.artifact_id JOIN agent_tasks t ON t.id = d.task_id
                   WHERE d.task_id = $1 OR t.parent_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [taskId]),
    client.query(`SELECT * FROM agent_tasks WHERE parent_id = $1 ORDER BY position, created_at`, [taskId]),
    row.parent_id ? client.query(`SELECT id, title, status FROM agent_tasks WHERE id = $1`, [row.parent_id]) : Promise.resolve({ rows: [] }),
  ]);
  row.step_count = steps.rows.length;
  row.steps_done = steps.rows.filter((s) => s.status === "completed").length;
  return {
    task: taskView(row),
    steps: steps.rows.map(taskView),
    parent: parent.rows[0] ? { id: parent.rows[0].id, title: parent.rows[0].title, status: parent.rows[0].status } : null,
    runs: runs.rows.map((r) => ({
      id: r.id, status: r.status, summary: r.summary, error: r.error, tokensUsed: Number(r.tokens_used ?? 0),
      startedAt: r.started_at, finishedAt: r.finished_at,
    })),
    events: events.rows.map((e) => ({
      id: e.id, runId: e.run_id, kind: e.kind, level: e.level, message: e.message, actorKind: e.actor_kind,
      actorAgent: e.actor_agent, actorName: e.actor_agent ? agentName(e.actor_agent) : null, actorUser: e.actor_user,
      metadata: e.metadata ?? {}, createdAt: e.created_at,
    })),
    deliverables: deliverables.rows.map(deliverableView),
  };
}

export function deliverableView(d: Record<string, any>) {
  return {
    id: d.id, runId: d.run_id, taskId: d.task_id, taskTitle: d.task_title ?? null, kind: d.kind, title: d.title, artifactId: d.artifact_id, fileId: d.file_id,
    mime: d.mime, sizeBytes: d.size_bytes != null ? Number(d.size_bytes) : null, metadata: d.metadata ?? {}, createdAt: d.created_at,
  };
}

export async function updateTask(client: PoolClient, args: { tenantId: string; userId: string; taskId: string; patch: UpdateTaskInput }): Promise<TaskView> {
  const row = await getTaskRow(client, args.taskId);
  if (["completed", "cancelled"].includes(row.status) && !("runAt" in args.patch)) {
    // Finished tasks can still be edited for the record, but never re-run implicitly.
  }
  const p = args.patch;
  const now = new Date();
  const isRecurring = p.isRecurring ?? row.is_recurring;
  const wantsReschedule = p.isRecurring !== undefined || p.cronExpression !== undefined || p.timezone !== undefined || p.runAt !== undefined;
  let schedule: { cron: string | null; timezone: string; nextRunAt: Date } | null = null;
  if (wantsReschedule) {
    try {
      schedule = scheduleFor({
        isRecurring, cronExpression: p.cronExpression !== undefined ? p.cronExpression : row.cron_expression,
        timezone: p.timezone ?? row.timezone, runAt: p.runAt !== undefined ? p.runAt : null,
      }, now);
    } catch (err) { if (err instanceof CronError) throw new HttpError(400, err.message); throw err; }
  }
  if (p.agentKey && !teammateByKey.has(p.agentKey)) throw new HttpError(400, "Unknown teammate");
  const { rows } = await client.query(
    `UPDATE agent_tasks SET
       title = coalesce($2, title), description = coalesce($3, description), instructions = coalesce($4, instructions),
       agent_key = coalesce($5, agent_key), task_type = coalesce($6, task_type), priority = coalesce($7, priority),
       due_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE due_at END,
       tags = coalesce($10::text[], tags), requires_approval = coalesce($11, requires_approval),
       is_recurring = coalesce($12, is_recurring), cron_expression = CASE WHEN $13::boolean THEN $14 ELSE cron_expression END,
       timezone = coalesce($15, timezone),
       next_run_at = CASE WHEN $13::boolean AND status IN ('queued','blocked','completed','failed') THEN $16::timestamptz ELSE next_run_at END,
       status = CASE WHEN $13::boolean AND status IN ('completed','failed') THEN 'queued' ELSE status END,
       completed_at = CASE WHEN $13::boolean AND status IN ('completed','failed') THEN NULL ELSE completed_at END
     WHERE id = $1 RETURNING *`,
    [args.taskId, p.title ?? null, p.description ?? null, p.instructions ?? null, p.agentKey ?? null, p.taskType ?? null, p.priority ?? null,
     p.dueAt !== undefined, p.dueAt ? new Date(p.dueAt) : null, p.tags ?? null, p.requiresApproval ?? null,
     p.isRecurring ?? null, schedule !== null, schedule?.cron ?? null, p.timezone ?? null, schedule?.nextRunAt ?? null]
  );
  await addTaskEvent(client, {
    tenantId: args.tenantId, taskId: args.taskId, kind: "updated", actorKind: "user", actorUser: args.userId,
    message: schedule ? `Task updated — ${schedule.cron ? describeCron(schedule.cron) : `next run ${schedule.nextRunAt.toISOString()}`}` : "Task updated",
    metadata: { fields: Object.keys(p) },
  });
  return taskView(rows[0]);
}

export async function cancelTask(client: PoolClient, args: { tenantId: string; userId: string; taskId: string }): Promise<TaskView> {
  const { rows } = await client.query(
    `UPDATE agent_tasks SET status = 'cancelled', cancelled_at = now(), next_run_at = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE id = $1 AND status <> 'cancelled' RETURNING *`,
    [args.taskId]
  );
  if (!rows[0]) throw new HttpError(409, "That task is already cancelled.");
  await client.query(`UPDATE agent_task_runs SET status = 'cancelled', finished_at = now() WHERE task_id = $1 AND status = 'in_progress'`, [args.taskId]);
  await client.query(
    `UPDATE agent_tasks SET status = 'cancelled', cancelled_at = now(), next_run_at = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE parent_id = $1 AND status NOT IN ('completed','cancelled')`,
    [args.taskId]
  );
  await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, kind: "cancelled", actorKind: "user", actorUser: args.userId, message: "Task cancelled" });
  await audit(client, { tenantId: args.tenantId, actorUser: args.userId, action: "task.cancelled", entityType: "agent_tasks", entityId: args.taskId, metadata: {} });
  return taskView(rows[0]);
}

/** Routines can be put on hold without losing their schedule. */
export async function setTaskPaused(client: PoolClient, args: { tenantId: string; userId: string; taskId: string; paused: boolean }): Promise<TaskView> {
  const row = await getTaskRow(client, args.taskId);
  if (!row.is_recurring) throw new HttpError(409, "Only routines can be paused; cancel a one-off task instead.");
  const next = !args.paused && row.cron_expression ? nextCronRun(row.cron_expression, new Date(), row.timezone || "UTC") : row.next_run_at;
  const { rows } = await client.query(
    `UPDATE agent_tasks SET paused = $2, next_run_at = $3, claimed_by = NULL, claimed_at = NULL WHERE id = $1 RETURNING *`,
    [args.taskId, args.paused, next]
  );
  await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, kind: args.paused ? "paused" : "resumed", actorKind: "user", actorUser: args.userId, message: args.paused ? "Routine paused" : `Routine resumed — next run ${next ? new Date(next).toISOString() : "unscheduled"}` });
  return taskView(rows[0]);
}

/** Queue the task to run at once — a first run, a retry, or an extra run of
 *  a recurring task ahead of its schedule. */
export async function runTaskNow(client: PoolClient, args: { tenantId: string; userId: string; taskId: string }): Promise<TaskView> {
  const steps = await client.query("SELECT id, status FROM agent_tasks WHERE parent_id = $1", [args.taskId]);
  if (steps.rows.length && steps.rows.some((s) => s.status !== "completed")) {
    // A workflow: put its unfinished steps back in the queue and wait for them.
    await client.query(
      `UPDATE agent_tasks SET status = 'queued', next_run_at = now(), blocked_reason = NULL, claimed_by = NULL, claimed_at = NULL, attempts = 0
        WHERE parent_id = $1 AND status IN ('blocked','failed','cancelled','queued')`,
      [args.taskId]
    );
    const { rows } = await client.query(
      `UPDATE agent_tasks SET status = 'in_progress', next_run_at = NULL, blocked_reason = NULL, claimed_by = NULL, claimed_at = NULL, completed_at = NULL,
              metadata = (metadata - 'synthesis') || '{"awaitingSteps": true}'::jsonb
        WHERE id = $1 RETURNING *`,
      [args.taskId]
    );
    await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, kind: "queued", actorKind: "user", actorUser: args.userId, message: "Unfinished steps queued again" });
    return taskView(rows[0]);
  }
  const { rows } = await client.query(
    `UPDATE agent_tasks SET status = 'queued', next_run_at = now(), blocked_reason = NULL, claimed_by = NULL, claimed_at = NULL,
            completed_at = NULL, metadata = metadata - 'question'
      WHERE id = $1 AND status IN ('queued','blocked','completed','failed','cancelled') RETURNING *`,
    [args.taskId]
  );
  if (!rows[0]) throw new HttpError(409, "That task is running or waiting for approval.");
  await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, kind: "queued", actorKind: "user", actorUser: args.userId, message: "Run requested" });
  return taskView(rows[0]);
}

export async function decideTaskApproval(client: PoolClient, args: {
  tenantId: string; userId: string; taskId: string; decision: "approved" | "rejected"; always?: boolean; note?: string | null;
}): Promise<TaskView> {
  const row = await getTaskRow(client, args.taskId);
  if (row.status !== "waiting_approval") throw new HttpError(409, "That task is not waiting for approval.");
  const approved = args.decision === "approved";
  const { rows } = await client.query(
    approved
      ? `UPDATE agent_tasks SET status = 'queued', next_run_at = now(), claimed_by = NULL, claimed_at = NULL,
           requires_approval = CASE WHEN $2::boolean THEN false ELSE requires_approval END,
           metadata = metadata || jsonb_build_object('approvedForRun', true, 'approvedBy', $3::text, 'approvedAt', now()::text)
         WHERE id = $1 RETURNING *`
      : `UPDATE agent_tasks SET status = CASE WHEN is_recurring THEN 'queued' ELSE 'cancelled' END,
           cancelled_at = CASE WHEN is_recurring THEN NULL ELSE now() END,
           next_run_at = CASE WHEN is_recurring AND cron_expression IS NOT NULL THEN next_run_at ELSE NULL END,
           claimed_by = NULL, claimed_at = NULL,
           metadata = metadata || jsonb_build_object('rejectedBy', $3::text, 'rejectedAt', now()::text, 'skipRun', is_recurring)
         WHERE id = $1 AND $2::boolean IS NOT NULL RETURNING *`,
    [args.taskId, Boolean(args.always), args.userId]
  );
  const task = rows[0];
  if (!approved && task.is_recurring && task.cron_expression) {
    // A rejected run of a routine is skipped; the schedule itself lives on.
    const next = nextCronRun(task.cron_expression, new Date(), task.timezone) ?? null;
    await client.query(`UPDATE agent_tasks SET next_run_at = $2 WHERE id = $1`, [args.taskId, next]);
    task.next_run_at = next;
  }
  await addTaskEvent(client, {
    tenantId: args.tenantId, taskId: args.taskId, kind: approved ? "approved" : "rejected", actorKind: "user", actorUser: args.userId,
    message: approved ? (args.always ? "Approved — future runs will not ask again" : "Approved") : (task.is_recurring ? "This run was rejected — the schedule continues" : "Rejected — task cancelled"),
    metadata: { note: args.note ?? null },
  });
  await audit(client, { tenantId: args.tenantId, actorUser: args.userId, action: `task.${args.decision}`, entityType: "agent_tasks", entityId: args.taskId, metadata: { always: Boolean(args.always) } });
  return taskView(task);
}

/** A blocked task gets its answer: the reply becomes part of the instructions
 *  and the task goes back in the queue. */
export async function answerTaskQuestion(client: PoolClient, args: { tenantId: string; userId: string; taskId: string; answer: string }): Promise<TaskView> {
  const { rows } = await client.query(
    `UPDATE agent_tasks SET
       instructions = instructions || E'\\n\\nAnswer from the team: ' || $2,
       status = 'queued', next_run_at = now(), blocked_reason = NULL, claimed_by = NULL, claimed_at = NULL,
       metadata = metadata - 'question'
     WHERE id = $1 AND status = 'blocked' RETURNING *`,
    [args.taskId, args.answer]
  );
  if (!rows[0]) throw new HttpError(409, "That task is not waiting on an answer.");
  await addTaskEvent(client, { tenantId: args.tenantId, taskId: args.taskId, kind: "comment", actorKind: "user", actorUser: args.userId, message: args.answer });
  return taskView(rows[0]);
}

/** Notification bell items: things a person should look at. */
export async function taskNotificationItems(client: PoolClient, tenantId: string) {
  const { rows } = await client.query(
    `SELECT id, title, status, agent_key, blocked_reason, updated_at, completed_at, is_recurring, last_run_status
       FROM agent_tasks WHERE tenant_id = $1
        AND (status IN ('waiting_approval','blocked','failed') OR (status = 'completed' AND completed_at > now() - interval '3 days'))
      ORDER BY updated_at DESC LIMIT 20`,
    [tenantId]
  );
  return rows.map((t) => ({
    id: `task:${t.id}:${t.status}`,
    kind: t.status === "waiting_approval" ? "waiting_approval" : t.status === "blocked" ? "waiting_info" : "task",
    projectName: "Tasks",
    title: t.status === "waiting_approval" ? `${agentName(t.agent_key)} needs your approval: ${t.title}`
      : t.status === "blocked" ? `${agentName(t.agent_key)} has a question about: ${t.title}`
      : t.status === "failed" ? `Task failed: ${t.title}`
      : `${agentName(t.agent_key)} finished: ${t.title}`,
    detail: t.status === "blocked" && t.blocked_reason === "out_of_tokens" ? "Out of tokens" : null,
    href: `/dashboard/tasks?task=${t.id}`,
    createdAt: t.completed_at ?? t.updated_at,
  }));
}
