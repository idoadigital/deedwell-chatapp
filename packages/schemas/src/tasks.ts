import { z } from "zod";

/**
 * Agent tasks — work a person hands to an AI teammate, once or on a schedule.
 * These are the contracts shared by the API, the runner, the chat flow and
 * the dashboard. Statuses are the whole lifecycle a task can be in; a task
 * type picks the handler that does the work, so new kinds of automation are
 * a new handler plus a new literal here.
 */
export const TaskStatus = z.enum(["queued", "in_progress", "waiting_approval", "blocked", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["low", "normal", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** Handler keys. "general" is the model-driven default that writes a
 *  document; the others bias the same runner toward a deliverable shape. */
export const TaskType = z.enum(["general", "research", "report", "content", "outreach", "review"]);
export type TaskType = z.infer<typeof TaskType>;

export const CreateTaskInput = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(4000).optional().default(""),
  instructions: z.string().max(8000).optional().default(""),
  agentKey: z.string().min(1).max(80),
  taskType: TaskType.optional().default("general"),
  priority: TaskPriority.optional().default("normal"),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
  isRecurring: z.boolean().optional().default(false),
  /** Five-field cron, required when isRecurring. */
  cronExpression: z.string().max(120).nullable().optional(),
  timezone: z.string().max(64).optional(),
  /** One-off tasks: run at this time instead of right away. */
  runAt: z.string().datetime({ offset: true }).nullable().optional(),
  requiresApproval: z.boolean().optional().default(false),
  /** Chat channel that gets progress updates; defaults to the agent's DM. */
  channelId: z.string().uuid().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(4000).optional(),
  instructions: z.string().max(8000).optional(),
  agentKey: z.string().min(1).max(80).optional(),
  taskType: TaskType.optional(),
  priority: TaskPriority.optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  isRecurring: z.boolean().optional(),
  cronExpression: z.string().max(120).nullable().optional(),
  timezone: z.string().max(64).optional(),
  runAt: z.string().datetime({ offset: true }).nullable().optional(),
  requiresApproval: z.boolean().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

/** What the assigned teammate returns for one run. Deliverables are
 *  documents (markdown); image requests are rendered by the runner when an
 *  image generator is configured. `needsFromUser` parks the task as blocked
 *  with a question instead of guessing. */
export const AgentTaskResultOutput = z.object({
  summary: z.string().min(1).max(1200),
  progressNotes: z.array(z.string().min(1).max(300)).max(12).default([]),
  deliverables: z.array(z.object({
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(40000),
  })).max(6).default([]),
  imageRequests: z.array(z.object({
    title: z.string().min(1).max(120),
    prompt: z.string().min(8).max(2000),
  })).max(4).default([]),
  needsFromUser: z.string().max(600).nullable().default(null),
});
export type AgentTaskResultOutput = z.infer<typeof AgentTaskResultOutput>;

/** Chat: turning "set up a task…" plus follow-up answers into a schedule. */
export const TaskScheduleReplyOutput = z.object({
  /** null when the reply does not say. */
  recurring: z.boolean().nullable().default(null),
  /** Five-field cron when recurring and the reply pins a cadence. */
  cron: z.string().max(120).nullable().default(null),
  /** ISO datetime for a one-off run in the future, else null (run now). */
  runAt: z.string().nullable().default(null),
  /** "yes / go ahead / confirm" → true; "cancel / never mind" → false; else null. */
  confirm: z.boolean().nullable().default(null),
  /** Free-text edits to the draft ("make it high priority", "assign to Grace"). */
  changes: z.object({
    title: z.string().max(200).nullable().default(null),
    instructions: z.string().max(8000).nullable().default(null),
    agentKey: z.string().max(80).nullable().default(null),
    priority: TaskPriority.nullable().default(null),
    requiresApproval: z.boolean().nullable().default(null),
  }).default({}),
});
export type TaskScheduleReplyOutput = z.infer<typeof TaskScheduleReplyOutput>;
