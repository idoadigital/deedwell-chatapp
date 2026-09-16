import { z } from "zod";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import type { WebsiteServices } from "../workflow.js";
import { JobProgress, loadJob } from "./jobs.js";
import { runQaPass, type QaOutcome } from "./qa.js";

/** "Run QA" as its own background run: one step, because the QA pass keeps
 *  its own fine-grained, truthful timeline on the job row. */
export const WEBSITE_QA_WORKFLOW = "website-qa";
type Ctx = StepContext<WebsiteServices>;
const Input = z.object({ siteId: z.string().uuid(), jobId: z.string().uuid() });

export function summarizeQa(o: QaOutcome): string {
  if (o.status === "failed") return "QA could not inspect the website in a browser.";
  const parts = [`${o.checks} checks completed`, `${o.detected} issue${o.detected === 1 ? "" : "s"} detected`, `${o.repaired} automatically repaired`, `${o.review} require${o.review === 1 ? "s" : ""} review`];
  return `${o.status === "passed" ? "QA passed" : "QA completed — review required"}: ${parts.join(", ")}.`;
}

export function buildWebsiteQaWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_QA_WORKFLOW,
    version: 1,
    initialStep: "qa",
    stepBudget: 3,
    steps: {
      async qa(ctx: Ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const job = await loadJob(ctx.client, input.jobId);
        if (!job) throw new Error("QA job not found");
        const progress = ctx.services.studio ? new JobProgress(ctx.services.studio, { id: job.id, tenantId: ctx.tenantId, siteId: input.siteId, kind: "qa" }, job.steps ?? [], "testing") : null;
        try {
          const outcome = await runQaPass({ client: ctx.client, storage: ctx.services.storage, tenantId: ctx.tenantId, siteId: input.siteId, jobId: job.id, runId: ctx.runId, progress, provider: ctx.services.provider, critic: ctx.services.designer, instruction: job.instruction, createdBy: job.created_by });
          await progress?.complete({ status: outcome.status === "failed" ? "failed" : "complete", summary: summarizeQa(outcome), result: { outcome }, releaseAfter: outcome.releaseId });
          return { state: { ...ctx.state, outcome }, complete: true };
        } catch (err) {
          // An honest failure, not a retry: re-running would repeat minutes of browser work.
          await progress?.complete({ status: "failed", error: String((err as Error).message ?? err).slice(0, 300) });
          await ctx.client.query("UPDATE sites SET qa_status = 'failed' WHERE id = $1", [input.siteId]);
          return { state: { ...ctx.state, failed: true, error: String((err as Error).message ?? err).slice(0, 300) }, complete: true };
        }
      },
    },
  };
}
