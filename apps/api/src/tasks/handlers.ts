import { runAgentTask } from "@deedwell/agent-runtime";
import { AgentDefinition, type AgentTaskResultOutput } from "@deedwell/schemas";
import { registerTaskHandler, type TaskHandler, type TaskHandlerContext, type TaskHandlerResult } from "@deedwell/tasks-domain";

/**
 * The built-in handlers: one model-driven runner, shaped per task type. The
 * assigned teammate speaks in their own role; the type only changes what a
 * good deliverable looks like. Everything returns the same contract, so the
 * runner stores, meters and reports the work identically.
 */
const GUIDANCE: Record<string, { label: string; description: string; guidance: string }> = {
  general: {
    label: "General",
    description: "Any piece of work with a written result.",
    guidance: "Produce the most useful written deliverable for the request, in complete markdown with headings.",
  },
  research: {
    label: "Research",
    description: "Find, compare and summarise — funders, programs, options.",
    guidance: "Deliver a research memo: what was looked at, findings as a table or list with specifics, a short recommendation, and open questions. Never invent sources; say what would need verifying.",
  },
  report: {
    label: "Report",
    description: "A structured status, progress or summary document.",
    guidance: "Deliver a report with an executive summary, sections for each area, concrete numbers where the profile provides them, and next steps.",
  },
  content: {
    label: "Content",
    description: "Copy for posts, newsletters, pages, or an image brief.",
    guidance: "Deliver ready-to-use copy in the organization's voice, plus an imageRequest when a visual would naturally accompany it.",
  },
  outreach: {
    label: "Outreach",
    description: "Emails, letters and messages to funders, donors or partners.",
    guidance: "Deliver a complete draft (subject line, greeting, body, sign-off) that a person can send as-is, with two alternative subject lines.",
  },
  review: {
    label: "Review",
    description: "Check something against requirements and report gaps.",
    guidance: "Deliver a review: what was checked, what passes, what fails with the reason, and the fixes in priority order.",
  },
};

function agentDefinition(ctx: TaskHandlerContext): AgentDefinition {
  const team = ctx.agent.team === "website" ? "website" : ctx.agent.team === "grant" ? "grant" : "core";
  return AgentDefinition.parse({
    agentKey: ctx.agent.agentKey, version: 1, displayName: ctx.agent.name, team, role: ctx.agent.role,
    instructions: `You are ${ctx.agent.name}, the ${ctx.agent.role} on a nonprofit's AI team. ${ctx.agent.bio ?? ""}
You have been assigned a task by a person on the team. Do the work yourself, completely, from the Mission Profile and the task's instructions.
Rules: never fabricate facts about the organization — if something needed is missing from the profile, either work around it and say so in the deliverable, or (only if the task is impossible without it) ask ONE question via needsFromUser. Write in plain, warm, professional English. Deliverables are markdown documents a person will download as a PDF, so give them a title, headings and complete content — no placeholders.`,
    allowedTools: [], outputSchemaRef: "agent_task_result", maxOutputRetries: 2,
  });
}

async function runModelTask(ctx: TaskHandlerContext, type: string): Promise<TaskHandlerResult> {
  const shape = GUIDANCE[type] ?? GUIDANCE.general!;
  await ctx.progress(`Reading the mission profile and the task${ctx.task.isRecurring ? ` (run #${ctx.task.runNumber})` : ""}`);
  const task = [
    `Title: ${ctx.task.title}`,
    `Type: ${type}`,
    `Priority: ${ctx.task.priority}`,
    ctx.task.tags.length ? `Tags: ${ctx.task.tags.join(", ")}` : "",
    ctx.task.isRecurring ? `Schedule: recurring, this is run #${ctx.task.runNumber}; make this run's output current as of today.` : "Schedule: one-time",
    ctx.task.description ? `Description: ${ctx.task.description}` : "",
    `Instructions: ${ctx.task.instructions || ctx.task.title}`,
    `Today: ${ctx.now.toISOString().slice(0, 10)}`,
  ].filter(Boolean).join("\n");
  const result = await runAgentTask<AgentTaskResultOutput>(ctx.model, agentDefinition(ctx), `Carry out the task below. ${shape.guidance}`, [
    { label: "task", content: task },
    { label: "mission_profile", content: ctx.missionProfile || "(no mission profile yet)" },
  ]);
  return {
    summary: result.output.summary,
    progressNotes: result.output.progressNotes,
    deliverables: result.output.deliverables,
    imageRequests: result.output.imageRequests,
    needsFromUser: result.output.needsFromUser,
    tokensUsed: result.tokensEstimated,
  };
}

export function registerBuiltInTaskHandlers(): void {
  for (const [type, meta] of Object.entries(GUIDANCE)) {
    const handler: TaskHandler = {
      type, label: meta.label, description: meta.description,
      run: (ctx) => runModelTask(ctx, type),
    };
    registerTaskHandler(handler);
  }
}
