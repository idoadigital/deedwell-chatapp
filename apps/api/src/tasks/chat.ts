import type { PoolClient } from "pg";
import { uuidv7 } from "@deedwell/database";
import { TaskScheduleReplyOutput, type CreateTaskInput } from "@deedwell/schemas";
import { describeCron, isValidCron, nextCronRun } from "@deedwell/tasks-domain";
import type { Deps } from "../bootstrap.js";
import { TEAMMATES, teammateByKey } from "../teammates.js";
import { agentName as displayName, answerTaskQuestion, createTask, decideTaskApproval, type TaskView } from "./store.js";

/**
 * Tasks ⇄ chat. Two directions:
 *  - the runner posts progress into the task's channel as the assigned
 *    teammate (start, question, approval request, completion), each carrying
 *    a `taskId` so the app renders a task card;
 *  - a person can create a task from chat: the assistant recognises the
 *    intent, asks one-time vs recurring and the cadence, shows a summary,
 *    and creates the task on confirmation. The draft lives in the metadata
 *    of the assistant's own question, so nothing new has to be persisted and
 *    a conversation that moves on simply leaves the draft behind.
 */
export interface TaskCard {
  taskId: string; title: string; status: string; agentKey: string; agentName: string;
  isRecurring: boolean; scheduleLabel: string | null; nextRunAt: string | null; priority: string;
}

export function taskCard(task: TaskView): TaskCard {
  return {
    taskId: task.id, title: task.title, status: task.status, agentKey: task.agentKey, agentName: task.agentName,
    isRecurring: task.isRecurring, scheduleLabel: task.scheduleLabel,
    nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null, priority: task.priority,
  };
}

export async function postAgentMessage(deps: Deps, client: PoolClient, args: {
  tenantId: string; channelId: string; agentKey: string; body: string; metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO messages (id, tenant_id, channel_id, author_kind, author_user, author_agent, body, metadata)
     VALUES ($1,$2,$3,'agent',NULL,$4,$5,$6)`,
    [id, args.tenantId, args.channelId, args.agentKey, args.body, JSON.stringify(args.metadata ?? {})]
  );
  deps.engine.events.emit("event", { type: "message_created", tenantId: args.tenantId, channelId: args.channelId, agentReplies: 1 } as never);
  return id;
}

export function emitTaskUpdated(deps: Deps, tenantId: string, taskId: string, status: string): void {
  deps.engine.events.emit("event", { type: "task_updated", tenantId, taskId, status } as never);
}

// ---------------------------------------------------------------------------
// Creating a task from chat
// ---------------------------------------------------------------------------

export interface TaskDraft {
  title: string; instructions: string; agentKey: string; priority: "low" | "normal" | "high" | "urgent";
  recurring: boolean | null; cron: string | null; runAt: string | null; requiresApproval: boolean; timezone: string;
}
type Stage = "schedule" | "cadence" | "confirm";

type Say = (text: string, metadata?: Record<string, unknown>, agent?: string) => Promise<void>;

function pickAgent(hint: string | null | undefined, text: string, fallback: string): string {
  if (hint && teammateByKey.has(hint)) return hint;
  const lower = `${hint ?? ""} ${text}`.toLowerCase();
  for (const t of TEAMMATES) if (lower.includes(t.name.toLowerCase())) return t.agentKey;
  if (/\b(grant|funder|funding|foundation)\b/.test(lower)) return "grant.opportunity_researcher";
  if (/\b(website|page|seo)\b/.test(lower)) return "website.digital_strategist";
  if (/\b(budget|cost)\b/.test(lower)) return "grant.budget_specialist";
  if (/\b(write|draft|newsletter|email|letter|post)\b/.test(lower)) return "grant.writer";
  return fallback;
}

export function describeDraft(d: TaskDraft): string {
  const when = d.recurring
    ? (d.cron ? describeCron(d.cron) : "on a schedule (to be set)")
    : d.runAt ? `once, on ${new Date(d.runAt).toLocaleString("en-US", { timeZone: d.timezone, dateStyle: "medium", timeStyle: "short" })}` : "once, starting right away";
  return [
    `**${d.title}**`,
    `Assigned to ${displayName(d.agentKey)} · ${d.priority} priority${d.requiresApproval ? " · asks for approval before each run" : ""}`,
    `Runs ${when}${d.recurring ? ` (${d.timezone})` : ""}`,
    d.instructions && d.instructions !== d.title ? `Instructions: ${d.instructions.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
}

async function userTimezone(client: PoolClient, userId: string): Promise<string> {
  const { rows } = await client.query("SELECT timezone FROM users WHERE id = $1", [userId]);
  return rows[0]?.timezone || "UTC";
}

/** Called for a fresh `create_task` intent: fills what it can and asks for the rest. */
export async function startTaskDraft(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; channelId: string; agentKeyFallback: string; say: Say;
  intent: { title: string; instructions: string | null; agentKey: string | null; priority: string | null; recurring: boolean | null; cron: string | null; runAt: string | null; requiresApproval: boolean | null };
}): Promise<void> {
  const draft: TaskDraft = {
    title: args.intent.title.trim().slice(0, 200),
    instructions: (args.intent.instructions ?? args.intent.title).trim(),
    agentKey: pickAgent(args.intent.agentKey, `${args.intent.title} ${args.intent.instructions ?? ""}`, args.agentKeyFallback),
    priority: (args.intent.priority as TaskDraft["priority"]) ?? "normal",
    recurring: args.intent.recurring,
    cron: args.intent.cron && isValidCron(args.intent.cron) ? args.intent.cron : null,
    runAt: args.intent.runAt ?? null,
    requiresApproval: Boolean(args.intent.requiresApproval),
    timezone: await userTimezone(client, args.userId),
  };
  await advanceDraft(deps, client, { ...args, draft });
}

async function advanceDraft(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; channelId: string; say: Say; draft: TaskDraft;
}): Promise<void> {
  const { draft, say } = args;
  const who = displayName(draft.agentKey);
  if (draft.recurring === null) {
    await say(
      `Happy to set that up for ${who}. Should this be a one-time task, or a recurring one? If recurring, tell me how often — for example "every Monday at 9am" or "the first of each month".`,
      { taskDraft: draft, taskDraftStage: "schedule" satisfies Stage }
    );
    return;
  }
  if (draft.recurring && !draft.cron) {
    await say(
      `Got it — a routine for ${who}. How often should it run? Something like "every weekday at 8am", "every Friday", or "monthly on the 1st" works.`,
      { taskDraft: draft, taskDraftStage: "cadence" satisfies Stage }
    );
    return;
  }
  await say(
    `Here's the task I'll create:\n\n${describeDraft(draft)}\n\nReply **confirm** to create it, or tell me what to change.`,
    { taskDraft: draft, taskDraftStage: "confirm" satisfies Stage }
  );
}

/** The newest assistant message in this channel, if it is an open task
 *  conversation (a draft awaiting an answer, or a question from a blocked task). */
async function pendingTaskMessage(client: PoolClient, channelId: string): Promise<{ id: string; metadata: Record<string, any> } | null> {
  const { rows } = await client.query(
    `SELECT id, metadata FROM messages WHERE channel_id = $1 AND author_kind = 'agent'
      ORDER BY created_at DESC LIMIT 1`,
    [channelId]
  );
  const m = rows[0];
  if (!m) return null;
  const meta = m.metadata ?? {};
  if (meta.taskDraftStage && meta.taskDraftStage !== "closed") return { id: m.id, metadata: meta };
  if (meta.taskQuestion && meta.taskId) return { id: m.id, metadata: meta };
  return null;
}

async function closeDraftMessage(client: PoolClient, messageId: string): Promise<void> {
  await client.query(
    `UPDATE messages SET metadata = (metadata - 'taskQuestion') || '{"taskDraftStage":"closed"}'::jsonb WHERE id = $1`,
    [messageId]
  );
}

/**
 * Runs before intent classification. Returns true when the message was an
 * answer in an open task conversation and has been fully handled.
 */
export async function handleTaskConversation(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; channelId: string; body: string; agentKey: string; say: Say;
}): Promise<boolean> {
  const pending = await pendingTaskMessage(client, args.channelId);
  if (!pending) return false;
  const meta = pending.metadata;

  // A blocked task asked something; this is the answer.
  if (meta.taskQuestion && meta.taskId) {
    const check = await client.query("SELECT status FROM agent_tasks WHERE id = $1", [meta.taskId]);
    if (check.rows[0]?.status !== "blocked") { await closeDraftMessage(client, pending.id); return false; }
    if (/^(cancel|never ?mind|stop|forget it)\b/i.test(args.body.trim())) {
      await closeDraftMessage(client, pending.id);
      await say(args, `Okay — I'll leave that task blocked. You can pick it up any time from Tasks.`);
      return true;
    }
    const task = await answerTaskQuestion(client, { tenantId: args.tenantId, userId: args.userId, taskId: meta.taskId, answer: args.body });
    await closeDraftMessage(client, pending.id);
    await say(args, `Thanks — I'm back on "${task.title}" with that.`, { taskId: task.id, taskCard: taskCard(task) }, task.agentKey);
    emitTaskUpdated(deps, args.tenantId, task.id, task.status);
    return true;
  }

  const draft = meta.taskDraft as TaskDraft;
  const stage = meta.taskDraftStage as Stage;
  const res = await deps.provider.complete({
    system: "You read one chat reply in a conversation about scheduling a task for an AI teammate and extract only what the reply states. Do not invent a cadence or a confirmation that is not there.",
    task: `The assistant asked: ${stage === "schedule" ? "one-time or recurring, and how often" : stage === "cadence" ? "how often the routine should run" : "confirm the task summary, or say what to change"}. Extract the answer.`,
    outputSchemaRef: "task_schedule_reply",
    dataBlocks: [
      { label: "reply", content: args.body },
      { label: "draft", content: JSON.stringify(draft) },
      { label: "teammates", content: TEAMMATES.map((t) => `${t.agentKey}: ${t.name}, ${t.role}`).join("\n") },
      { label: "now", content: `${new Date().toISOString()} (user time zone ${draft.timezone})` },
    ],
  });
  await client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,NULL,'model_tokens',$3,$4)`,
    [uuidv7(), args.tenantId, res.tokensEstimated, JSON.stringify({ source: "chat", agentKey: args.agentKey, purpose: "task_schedule" })]
  );
  let reply: TaskScheduleReplyOutput;
  try { reply = TaskScheduleReplyOutput.parse(JSON.parse(res.text)); }
  catch { reply = TaskScheduleReplyOutput.parse({}); }

  if (reply.confirm === false) {
    await closeDraftMessage(client, pending.id);
    await say(args, "No problem — I won't create that task.");
    return true;
  }
  const next: TaskDraft = { ...draft };
  if (reply.recurring !== null) next.recurring = reply.recurring;
  if (reply.cron && isValidCron(reply.cron)) { next.cron = reply.cron; next.recurring = true; }
  if (reply.runAt && !Number.isNaN(new Date(reply.runAt).getTime())) { next.runAt = reply.runAt; if (next.recurring === null) next.recurring = false; }
  const c = reply.changes;
  if (c.title) next.title = c.title.slice(0, 200);
  if (c.instructions) next.instructions = c.instructions;
  if (c.agentKey && teammateByKey.has(c.agentKey)) next.agentKey = c.agentKey;
  if (c.priority) next.priority = c.priority;
  if (c.requiresApproval !== null) next.requiresApproval = c.requiresApproval;
  const changed = JSON.stringify(next) !== JSON.stringify(draft);

  await closeDraftMessage(client, pending.id);
  if (stage === "confirm" && reply.confirm === true && !changed) {
    await createFromDraft(deps, client, { ...args, draft: next });
    return true;
  }
  if (stage === "confirm" && !changed && reply.confirm === null) {
    // Not an answer to us at all — let the normal assistant handle it.
    await client.query(`UPDATE messages SET metadata = metadata || $2::jsonb WHERE id = $1`, [pending.id, JSON.stringify({ taskDraftStage: stage })]);
    return false;
  }
  if (next.recurring !== null && (!next.recurring || next.cron) && reply.confirm === true && stage !== "confirm") {
    await createFromDraft(deps, client, { ...args, draft: next });
    return true;
  }
  await advanceDraft(deps, client, { ...args, draft: next });
  return true;
}

async function say(args: { say: Say }, text: string, metadata?: Record<string, unknown>, agent?: string) {
  await args.say(text, metadata, agent);
}

async function createFromDraft(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; channelId: string; say: Say; draft: TaskDraft;
}): Promise<void> {
  const d = args.draft;
  const input: CreateTaskInput = {
    title: d.title, description: "", instructions: d.instructions, agentKey: d.agentKey, taskType: "general",
    priority: d.priority, dueAt: null, tags: [], isRecurring: Boolean(d.recurring), cronExpression: d.cron,
    timezone: d.timezone, runAt: d.runAt, requiresApproval: d.requiresApproval, channelId: args.channelId,
    steps: [], stepsInParallel: false,
  };
  const task = await createTask(client, { tenantId: args.tenantId, userId: args.userId, input, createdFrom: "chat" });
  const when = task.isRecurring
    ? `${task.scheduleLabel}${task.nextRunAt ? ` — first run ${new Date(task.nextRunAt).toLocaleString("en-US", { timeZone: d.timezone, dateStyle: "medium", timeStyle: "short" })}` : ""}`
    : task.nextRunAt && new Date(task.nextRunAt).getTime() > Date.now() + 60_000
      ? `on ${new Date(task.nextRunAt).toLocaleString("en-US", { timeZone: d.timezone, dateStyle: "medium", timeStyle: "short" })}`
      : "starting now";
  await args.say(
    `Done — "${task.title}" is set up for ${task.agentName}, ${when}. I'll post updates here as it runs; you can follow it under Tasks.`,
    { taskId: task.id, taskCard: taskCard(task) }
  );
  emitTaskUpdated(deps, args.tenantId, task.id, task.status);
}

/** Chat "approve" / "reject" with no workflow approval pending falls through
 *  to the newest task waiting in this channel. */
export async function decideTaskFromChat(deps: Deps, client: PoolClient, args: {
  tenantId: string; userId: string; channelId: string; decision: "approved" | "rejected"; note: string | null; say: Say;
}): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT id FROM agent_tasks WHERE tenant_id = $1 AND status = 'waiting_approval' AND (channel_id = $2 OR $2 IS NULL)
      ORDER BY updated_at DESC LIMIT 1`,
    [args.tenantId, args.channelId]
  );
  if (!rows[0]) return false;
  const task = await decideTaskApproval(client, { tenantId: args.tenantId, userId: args.userId, taskId: rows[0].id, decision: args.decision, note: args.note });
  await args.say(
    args.decision === "approved" ? `Approved — ${task.agentName} is starting on "${task.title}".` : `Understood — "${task.title}" won't run${task.isRecurring ? " this time" : ""}.`,
    { taskId: task.id, taskCard: taskCard(task) }
  );
  emitTaskUpdated(deps, args.tenantId, task.id, task.status);
  return true;
}

export function nextRunLabel(cron: string | null, timezone: string): string | null {
  if (!cron) return null;
  const next = nextCronRun(cron, new Date(), timezone);
  return next ? next.toISOString() : null;
}
