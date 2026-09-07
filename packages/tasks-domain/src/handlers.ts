import type { ModelProvider } from "@deedwell/agent-runtime";

/**
 * Task handlers — the extension point. A handler owns one task type: given
 * the task, the assigned teammate and the organization's mission profile it
 * returns deliverables, notes, optional image requests, and (if it truly
 * cannot proceed) one question for the user. Storing the outputs, posting
 * updates, metering tokens and scheduling the next run are the runner's job,
 * so a new kind of automation is only a new handler.
 */
export interface TaskHandlerTask {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  instructions: string;
  agentKey: string;
  taskType: string;
  priority: string;
  tags: string[];
  isRecurring: boolean;
  runNumber: number;
  metadata: Record<string, unknown>;
  /** For a coordinating task: what each finished step produced. */
  steps?: Array<{ title: string; agentName: string; status: string; summary: string | null; deliverables: Array<{ title: string; body: string }> }>;
}

export interface TaskHandlerAgent { agentKey: string; name: string; role: string; team: string; bio?: string }

export interface TaskHandlerContext {
  task: TaskHandlerTask;
  agent: TaskHandlerAgent;
  /** The organization's Mission Profile, rendered for a prompt. */
  missionProfile: string;
  model: ModelProvider;
  now: Date;
  /** Progress line → activity timeline (and chat, when the runner decides). */
  progress(message: string): Promise<void>;
}

export interface TaskHandlerResult {
  summary: string;
  progressNotes: string[];
  deliverables: Array<{ title: string; body: string }>;
  imageRequests: Array<{ title: string; prompt: string }>;
  needsFromUser: string | null;
  /** Delegations the runner turns into steps of this task. */
  handoffs: Array<{ agentKey: string; title: string; instructions: string }>;
  tokensUsed: number;
}

export interface TaskHandler {
  type: string;
  label: string;
  description: string;
  run(ctx: TaskHandlerContext): Promise<TaskHandlerResult>;
}

const registry = new Map<string, TaskHandler>();

export function registerTaskHandler(handler: TaskHandler): void {
  registry.set(handler.type, handler);
}

/** Unknown types fall back to "general" so a task never strands on a
 *  handler that was renamed or removed. */
export function getTaskHandler(type: string): TaskHandler {
  const h = registry.get(type) ?? registry.get("general");
  if (!h) throw new Error("No task handler registered");
  return h;
}

export function listTaskHandlers(): Array<Pick<TaskHandler, "type" | "label" | "description">> {
  return [...registry.values()].map(({ type, label, description }) => ({ type, label, description }));
}
