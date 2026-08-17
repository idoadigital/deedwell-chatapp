import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "@deedwell/database";
import type { AppContext } from "./app.js";
import { HttpError } from "./app.js";
import { getChannelLink } from "./gcp/links.js";
import { invalidateGcpWorkspace, resolveGcpIdsForRequest } from "./gcp/workspace.js";

/**
 * Structured controls for platform-backed grant workspaces. Every route
 * resolves the backend tenant identity server-side from RLS-scoped link
 * tables — a request can never name another organization's backend ids, and
 * downloads stream through this API so no storage URL is ever exposed.
 */

const AnswerInput = z.object({
  requestId: z.string().min(1),
  answer: z.string().min(1).max(8000),
});

export function registerGcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The Questions form: a structured answer feeds the same backend state as
  // answering in chat — one Evidence Library, one requirements engine.
  app.post("/v1/orgs/:orgId/projects/:projectId/gcp-answers", async (req, reply) => {
    ctx.requireRole(req, "member");
    if (!ctx.deps.gcp) throw new HttpError(404, "Grant platform is not enabled");
    const { projectId } = req.params as { projectId: string };
    const input = AnswerInput.parse(req.body);
    const out = await ctx.inOrg(req, async (client) => {
      const { rows: chan } = await client.query(
        "SELECT id FROM channels WHERE project_id = $1 LIMIT 1", [projectId]);
      if (!chan[0]) throw new HttpError(404, "Project not found");
      const link = await getChannelLink(client, chan[0].id);
      if (!link?.gcp_application_id) throw new HttpError(404, "No platform application for this project");
      const ids = await resolveGcpIdsForRequest(ctx.deps, client, req.orgId!, req.userId!);
      const result = await ctx.deps.gcp!.answerInformationRequest(
        link.gcp_application_id, input.requestId, ids, input.answer);
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "gcp.information_request_answered",
        entityType: "project", entityId: projectId,
        metadata: { requestId: input.requestId },
      });
      return result;
    });
    invalidateGcpWorkspace(projectId);
    return reply.status(201).send(out);
  });

  // Private, authenticated deliverable download — bytes stream through the
  // API; the platform's storage stays unreachable from the browser.
  app.get("/v1/orgs/:orgId/gcp-deliverables/:deliverableId/download", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    if (!ctx.deps.gcp) throw new HttpError(404, "Grant platform is not enabled");
    const { deliverableId } = req.params as { deliverableId: string };
    const file = await ctx.inOrg(req, async (client) => {
      const ids = await resolveGcpIdsForRequest(ctx.deps, client, req.orgId!, req.userId!);
      try {
        return await ctx.deps.gcp!.downloadDeliverable(deliverableId, ids);
      } catch {
        // The platform scopes the download by organization; whether the id is
        // wrong or belongs to another tenant is deliberately indistinguishable.
        throw new HttpError(404, "Deliverable not found");
      }
    });
    reply.header("content-type", file.contentType);
    if (file.filename) reply.header("content-disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`);
    return reply.send(file.bytes);
  });
}
