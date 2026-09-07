import type { FastifyInstance } from "fastify";
import { CreateTaskInput, TaskPriority, TaskStatus, UpdateTaskInput } from "@deedwell/schemas";
import { buildZip, describeCron, isValidCron, listTaskHandlers, nextCronRun } from "@deedwell/tasks-domain";
import { HttpError, type AppContext } from "./app.js";
import { renderArtifactPdf } from "./artifact-pdf.js";
import { requireTokens } from "./billing-gate.js";
import { emitTaskUpdated } from "./tasks/chat.js";
import {
  answerTaskQuestion, cancelTask, createTask, decideTaskApproval, getTaskDetail, listTasks, runTaskNow, setTaskPaused, updateTask,
  type TaskFilters,
} from "./tasks/store.js";
import { TEAMMATES } from "./teammates.js";

/** Tasks: assign work to AI teammates, one-off or on a schedule. */
export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Everything the UI needs to build the form: teammates, types, enums. */
  app.get("/v1/orgs/:orgId/tasks/meta", async (req) => {
    ctx.requireRole(req, "viewer");
    return {
      agents: TEAMMATES.map((t) => ({ agentKey: t.agentKey, name: t.name, role: t.role, team: t.team, skills: t.skills })),
      types: listTaskHandlers(),
      priorities: TaskPriority.options,
      statuses: TaskStatus.options,
      presets: [
        { label: "Every weekday at 9am", cron: "0 9 * * 1-5" },
        { label: "Every Monday at 9am", cron: "0 9 * * 1" },
        { label: "Every day at 8am", cron: "0 8 * * *" },
        { label: "First of the month at 9am", cron: "0 9 1 * *" },
        { label: "Every Friday at 4pm", cron: "0 16 * * 5" },
      ],
    };
  });

  /** Validate a cron and say when it next fires — for the form's live preview. */
  app.get("/v1/orgs/:orgId/tasks/schedule-preview", async (req) => {
    ctx.requireRole(req, "viewer");
    const { cron = "", timezone = "UTC" } = req.query as { cron?: string; timezone?: string };
    if (!isValidCron(cron)) return { valid: false, label: null, next: [] };
    const next: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < 3; i += 1) {
      const n = nextCronRun(cron, cursor, timezone);
      if (!n) break;
      next.push(n.toISOString());
      cursor = n;
    }
    return { valid: true, label: describeCron(cron), next };
  });

  app.get("/v1/orgs/:orgId/tasks", async (req) => {
    ctx.requireRole(req, "viewer");
    const q = req.query as Record<string, string | undefined>;
    const filters: TaskFilters = {
      q: q.q?.trim() || undefined,
      status: q.status ? q.status.split(",").filter((s) => TaskStatus.options.includes(s as never)) : undefined,
      agentKey: q.agent || undefined,
      priority: q.priority || undefined,
      recurring: q.recurring === "true" || q.recurring === "false" ? q.recurring : undefined,
      tag: q.tag || undefined,
      due: (["overdue", "today", "week", "none"] as const).find((d) => d === q.due),
      taskType: q.type || undefined,
    };
    const tasks = await ctx.inOrg(req, (client) => listTasks(client, req.orgId!, filters));
    return { tasks };
  });

  app.post("/v1/orgs/:orgId/tasks", async (req, reply) => {
    ctx.requireRole(req, "member");
    await requireTokens(ctx, req);
    const input = CreateTaskInput.parse(req.body);
    const task = await ctx.inOrg(req, (client) => createTask(client, { tenantId: req.orgId!, userId: req.userId!, input, createdFrom: "dashboard" }));
    emitTaskUpdated(ctx.deps, req.orgId!, task.id, task.status);
    return reply.status(201).send({ task });
  });

  app.get("/v1/orgs/:orgId/tasks/:taskId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { taskId } = req.params as { taskId: string };
    return ctx.inOrg(req, (client) => getTaskDetail(client, taskId));
  });

  app.patch("/v1/orgs/:orgId/tasks/:taskId", async (req) => {
    ctx.requireRole(req, "member");
    const { taskId } = req.params as { taskId: string };
    const patch = UpdateTaskInput.parse(req.body);
    const task = await ctx.inOrg(req, (client) => updateTask(client, { tenantId: req.orgId!, userId: req.userId!, taskId, patch }));
    emitTaskUpdated(ctx.deps, req.orgId!, task.id, task.status);
    return { task };
  });

  const transition = (name: string, fn: (client: Parameters<Parameters<AppContext["inOrg"]>[1]>[0], args: { tenantId: string; userId: string; taskId: string; body: Record<string, any> }) => Promise<{ id: string; status: string }>) => {
    app.post(`/v1/orgs/:orgId/tasks/:taskId/${name}`, async (req) => {
      ctx.requireRole(req, "member");
      const { taskId } = req.params as { taskId: string };
      if (name === "run" || name === "approve" || name === "answer" || name === "resume") await requireTokens(ctx, req);
      const task = await ctx.inOrg(req, (client) => fn(client, { tenantId: req.orgId!, userId: req.userId!, taskId, body: (req.body ?? {}) as Record<string, any> }));
      emitTaskUpdated(ctx.deps, req.orgId!, task.id, task.status);
      return { task };
    });
  };
  transition("cancel", (client, a) => cancelTask(client, a));
  transition("run", (client, a) => runTaskNow(client, a));
  transition("approve", (client, a) => decideTaskApproval(client, { ...a, decision: "approved", always: Boolean(a.body.always), note: a.body.note ?? null }));
  transition("reject", (client, a) => decideTaskApproval(client, { ...a, decision: "rejected", note: a.body.note ?? null }));
  transition("pause", (client, a) => setTaskPaused(client, { ...a, paused: true }));
  transition("resume", (client, a) => setTaskPaused(client, { ...a, paused: false }));
  transition("answer", (client, a) => {
    const answer = String(a.body.answer ?? "").trim();
    if (!answer) throw new HttpError(400, "An answer is required");
    return answerTaskQuestion(client, { ...a, answer });
  });

  /** One deliverable: markdown as a file, a PDF rendered on demand, or the image bytes. */
  app.get("/v1/orgs/:orgId/tasks/:taskId/deliverables/:deliverableId", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { taskId, deliverableId } = req.params as { taskId: string; deliverableId: string };
    const format = (req.query as { format?: string }).format ?? "";
    const file = await ctx.inOrg(req, (client) => loadDeliverable(client, ctx, req.orgId!, taskId, deliverableId, format === "pdf" ? "pdf" : "native"));
    reply.header("content-type", file.mime);
    reply.header("content-disposition", `${(req.query as { download?: string }).download === "1" ? "attachment" : "inline"}; filename="${file.filename.replace(/"/g, "")}"`);
    return reply.send(file.bytes);
  });

  /** Every deliverable of the task in one archive: markdown + PDF per document, images as-is. */
  app.get("/v1/orgs/:orgId/tasks/:taskId/deliverables.zip", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { taskId } = req.params as { taskId: string };
    const { zip, title } = await ctx.inOrg(req, async (client) => {
      const detail = await getTaskDetail(client, taskId);
      const entries: Array<{ name: string; data: Buffer; modified?: Date }> = [];
      for (const d of detail.deliverables) {
        const native = await loadDeliverable(client, ctx, req.orgId!, taskId, d.id, "native");
        entries.push({ name: native.filename, data: native.bytes, modified: new Date(d.createdAt) });
        if (d.kind === "markdown") {
          const pdf = await loadDeliverable(client, ctx, req.orgId!, taskId, d.id, "pdf");
          entries.push({ name: pdf.filename, data: pdf.bytes, modified: new Date(d.createdAt) });
        }
      }
      if (!entries.length) throw new HttpError(404, "This task has no deliverables yet");
      return { zip: buildZip(entries), title: detail.task.title };
    });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="${slug(title)}-deliverables.zip"`);
    return reply.send(zip);
  });
}

/** Platform Admin: every task across organizations, for oversight. */
export function registerAdminTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/admin/tasks", async (req) => {
    ctx.requirePlatformAdmin(req);
    const { rows } = await ctx.deps.adminPool.query(
      `SELECT t.id, t.title, t.status, t.agent_key, t.task_type, t.priority, t.is_recurring, t.cron_expression, t.paused,
              t.parent_id, t.run_count, t.tokens_used, t.last_run_at, t.last_run_status, t.next_run_at, t.created_from, t.created_at, t.updated_at,
              t.blocked_reason, o.id AS org_id, o.name AS org_name,
              (SELECT count(*)::int FROM agent_tasks s WHERE s.parent_id = t.id) AS step_count
         FROM agent_tasks t JOIN organizations o ON o.id = t.tenant_id
        WHERE t.parent_id IS NULL
        ORDER BY t.updated_at DESC LIMIT 500`
    );
    const totals = await ctx.deps.adminPool.query(
      `SELECT count(*)::int AS tasks, count(*) FILTER (WHERE status = 'in_progress')::int AS running,
              count(*) FILTER (WHERE status IN ('failed','blocked'))::int AS attention,
              count(*) FILTER (WHERE is_recurring)::int AS routines,
              coalesce(sum(tokens_used), 0)::bigint AS tokens,
              (SELECT count(*)::int FROM agent_task_runs WHERE started_at > now() - interval '7 days') AS runs_week
         FROM agent_tasks WHERE parent_id IS NULL`
    );
    return { tasks: rows, totals: totals.rows[0] };
  });
}

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "task";

async function loadDeliverable(
  client: Parameters<Parameters<AppContext["inOrg"]>[1]>[0], ctx: AppContext, orgId: string, taskId: string, deliverableId: string, format: "native" | "pdf"
): Promise<{ bytes: Buffer; mime: string; filename: string }> {
  const { rows } = await client.query("SELECT * FROM agent_task_deliverables WHERE id = $1 AND task_id = $2", [deliverableId, taskId]);
  const d = rows[0];
  if (!d) throw new HttpError(404, "Deliverable not found");
  if (d.kind === "image" || d.kind === "file") {
    const file = await client.query("SELECT filename, mime, storage_key FROM files WHERE id = $1", [d.file_id]);
    if (!file.rows[0]) throw new HttpError(404, "File not found");
    const bytes = await ctx.deps.storage.get(file.rows[0].storage_key);
    return { bytes, mime: file.rows[0].mime, filename: file.rows[0].filename };
  }
  const version = await client.query(
    `SELECT v.content, v.created_at, v.version, a.title FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      WHERE v.artifact_id = $1 ORDER BY v.version DESC LIMIT 1`,
    [d.artifact_id]
  );
  const v = version.rows[0];
  if (!v) throw new HttpError(404, "Document not found");
  const body = String(v.content?.body ?? "");
  if (format === "pdf") {
    const org = await client.query("SELECT name FROM organizations WHERE id = $1", [orgId]);
    const bytes = await renderArtifactPdf({ title: d.title, type: "task_deliverable", orgName: org.rows[0]?.name ?? "Deedwell", createdAt: v.created_at, version: v.version, content: v.content });
    return { bytes, mime: "application/pdf", filename: `${slug(d.title)}.pdf` };
  }
  return { bytes: Buffer.from(body, "utf8"), mime: "text/markdown; charset=utf-8", filename: `${slug(d.title)}.md` };
}
