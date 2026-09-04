import type { FastifyInstance } from "fastify";
import { audit, uuidv7 } from "@deedwell/database";
import { ApprovalDecisionInput, ProvideInfoInput, StartGrantSliceInput } from "@deedwell/schemas";
import { GRANT_SLICE_WORKFLOW, writeOrgFact } from "@deedwell/grant-domain";
import type { WorkflowEvent } from "@deedwell/workflows";
import { HttpError, type AppContext } from "./app.js";
import { resolveInfoRequest } from "./fact-fields.js";
import { PASSPORT_FIELDS } from "@deedwell/grant-domain";
import { WEBSITE_INTAKE_KEYS } from "@deedwell/website-domain";

const passportKeys = new Set(PASSPORT_FIELDS.map((f) => f.key));

export function registerGrantRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- agent directory (platform-level, versioned definitions) -----------

  app.get("/v1/agents", async () => {
    const { rows } = await ctx.deps.appPool.query(
      `SELECT DISTINCT ON (agent_key) agent_key, version, display_name, team, role, allowed_tools
       FROM agent_definitions ORDER BY agent_key, version DESC`
    );
    return { agents: rows };
  });

  // ---- org-wide run and approval lists (workspace dashboard) --------------

  app.get("/v1/orgs/:orgId/runs", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT r.id, r.project_id, p.name AS project_name, r.definition, r.status,
                r.current_step, r.steps_used, r.step_budget, r.last_error,
                r.state->'waiting' AS waiting, r.created_at, r.updated_at
         FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         ORDER BY r.updated_at DESC LIMIT 100`
      )
    );
    return { runs: rows };
  });

  app.get("/v1/orgs/:orgId/approvals", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT a.id, a.run_id, a.kind, a.payload, a.status, a.note, a.created_at,
                p.name AS project_name, r.project_id
         FROM approvals a
         JOIN workflow_runs r ON r.id = a.run_id
         JOIN projects p ON p.id = r.project_id
         ORDER BY a.created_at DESC LIMIT 100`
      )
    );
    return { approvals: rows };
  });

  // ---- start the vertical slice ------------------------------------------

  app.post("/v1/orgs/:orgId/projects/:projectId/grant-slice", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = StartGrantSliceInput.parse(req.body);

    const result = await ctx.inOrg(req, async (client) => {
      const file = await client.query(
        "SELECT id FROM files WHERE id = $1 AND project_id = $2",
        [input.fileId, projectId]
      );
      if (!file.rows[0]) throw new HttpError(404, "File not found in this project");

      const opportunityId = uuidv7();
      await client.query(
        `INSERT INTO grant_opportunities (id, tenant_id, project_id, title, funder, source, file_id)
         VALUES ($1,$2,$3,$4,$5,'upload',$6)`,
        [opportunityId, req.orgId, projectId, input.opportunityTitle, input.funder, input.fileId]
      );
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!,
        projectId,
        definition: GRANT_SLICE_WORKFLOW,
        createdBy: req.userId!,
        input: {
          opportunityId,
          fileId: input.fileId,
          sectionTitle: input.sectionTitle,
          opportunityTitle: input.opportunityTitle,
          funder: input.funder,
        },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.started",
        entityType: "workflow_run", entityId: runId,
        metadata: { definition: GRANT_SLICE_WORKFLOW, opportunityId },
      });
      return { runId, opportunityId };
    });
    return reply.status(201).send(result);
  });

  // ---- run visibility -----------------------------------------------------

  app.get("/v1/orgs/:orgId/runs/:runId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { runId } = req.params as { runId: string };
    return ctx.inOrg(req, async (client) => {
      const run = await client.query(
        `SELECT id, definition, definition_version, status, current_step, steps_used,
                step_budget, last_error, state->'waiting' AS waiting,
                state->'applied' AS applied, state->'reason' AS reason,
                state->'changeSummary' AS change_summary, state->'published' AS published,
                created_at, updated_at
         FROM workflow_runs WHERE id = $1`,
        [runId]
      );
      if (!run.rows[0]) throw new HttpError(404, "Run not found");
      const steps = await client.query(
        `SELECT seq, step, attempt, status, error, duration_ms, created_at
         FROM workflow_steps WHERE run_id = $1 ORDER BY seq`,
        [runId]
      );
      const approvals = await client.query(
        `SELECT id, kind, payload, status, decided_by, decided_at, note, created_at
         FROM approvals WHERE run_id = $1 ORDER BY created_at`,
        [runId]
      );
      const artifacts = await client.query(
        `SELECT id, type, title, current_version, updated_at
         FROM artifacts WHERE run_id = $1 ORDER BY created_at`,
        [runId]
      );
      // What a parked run is actually asking for, in field form, so a client
      // can render the questions instead of guessing from the raw payload.
      const infoRequest = run.rows[0].status === "waiting_for_info"
        ? await resolveInfoRequest(client, runId)
        : null;
      return {
        run: run.rows[0],
        steps: steps.rows,
        approvals: approvals.rows,
        artifacts: artifacts.rows,
        infoRequest,
      };
    });
  });

  // ---- supply missing information ----------------------------------------

  app.post("/v1/orgs/:orgId/runs/:runId/provide-info", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { runId } = req.params as { runId: string };
    const input = ProvideInfoInput.parse(req.body);
    let result: { ok: true; accepted: string[]; ignored: string[]; conflicts: string[] } =
      { ok: true, accepted: [], ignored: [], conflicts: [] };
    await ctx.inOrg(req, async (client) => {
      const run = await client.query(
        `SELECT status, state->'input'->>'siteId' AS site_id FROM workflow_runs WHERE id = $1`,
        [runId]
      );
      if (!run.rows[0]) throw new HttpError(404, "Run not found");
      if (run.rows[0].status !== "waiting_for_info") {
        throw new HttpError(409, `Run is not waiting for information (status: ${run.rows[0].status})`);
      }
      // Where an answer lands is decided HERE, from the catalogs — never from
      // anything the client sends. A stale or tampered client must not be able
      // to write a website design preference into the Funding Passport, which
      // is the evidence base grant narratives are cited from.
      const siteId: string | null = run.rows[0].site_id ?? null;
      const accepted: string[] = [];
      const ignored: string[] = [];
      const conflicts: string[] = [];

      for (const fact of input.facts) {
        if (passportKeys.has(fact.key)) {
          // org_facts.value is text, so typed answers are flattened on the way
          // in. The canonical form matches what a user would have typed.
          const value = Array.isArray(fact.value)
            ? fact.value.join(", ")
            : typeof fact.value === "boolean"
              ? fact.value ? "yes" : "no"
              : fact.value;
          const { conflict } = await writeOrgFact(client, {
            tenantId: req.orgId!, factKey: fact.key, value, status: "user_certified",
            certifiedBy: req.userId,
          });
          if (conflict) conflicts.push(fact.key); else accepted.push(fact.key);
        } else if (WEBSITE_INTAKE_KEYS.has(fact.key) && siteId) {
          // Kept as jsonb: a multiselect stays an array and a yes/no stays a
          // boolean, so the workflow reads back exactly what was chosen.
          await client.query(
            `INSERT INTO site_intake_answers (id, tenant_id, site_id, question_key, value, answered_by)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)
             ON CONFLICT (site_id, question_key)
             DO UPDATE SET value = EXCLUDED.value, answered_by = EXCLUDED.answered_by, updated_at = now()`,
            [uuidv7(), req.orgId, siteId, fact.key, JSON.stringify(fact.value), req.userId]
          );
          accepted.push(fact.key);
        } else {
          // Reported back rather than silently dropped into org_facts.
          ignored.push(fact.key);
        }
      }

      if (!accepted.length) {
        throw new HttpError(
          400,
          conflicts.length
            ? `These answers conflict with existing verified data and were not applied: ${conflicts.join(", ")}. Resolve the conflict first.`
            : `No recognised answers (unknown keys: ${ignored.join(", ")})`
        );
      }

      await ctx.deps.engine.signal(client, runId, "info", { keys: accepted });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.info_provided",
        entityType: "workflow_run", entityId: runId,
        metadata: { keys: accepted, ignored, conflicts },
      });
      result = { ok: true, accepted, ignored, conflicts };
    });
    return reply.status(200).send(result);
  });

  // ---- approvals ----------------------------------------------------------

  app.post("/v1/orgs/:orgId/approvals/:approvalId", async (req) => {
    ctx.requireRole(req, "admin");
    const { approvalId } = req.params as { approvalId: string };
    const input = ApprovalDecisionInput.parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), note = $4
         WHERE id = $1 AND status = 'pending'
         RETURNING run_id`,
        [approvalId, input.decision, req.userId, input.note ?? null]
      );
      if (!rows[0]) throw new HttpError(404, "No pending approval with that id");
      await ctx.deps.engine.signal(client, rows[0].run_id, "approval", {
        approvalId, decision: input.decision,
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: `approval.${input.decision}`,
        entityType: "approval", entityId: approvalId, metadata: { note: input.note },
      });
    });
    return { ok: true };
  });

  // ---- artifacts ----------------------------------------------------------

  app.get("/v1/orgs/:orgId/artifacts/:artifactId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { artifactId } = req.params as { artifactId: string };
    return ctx.inOrg(req, async (client) => {
      const artifact = await client.query(
        "SELECT id, type, title, current_version, project_id, run_id FROM artifacts WHERE id = $1",
        [artifactId]
      );
      if (!artifact.rows[0]) throw new HttpError(404, "Artifact not found");
      const versions = await client.query(
        `SELECT version, content, created_by_kind, created_by_agent, change_summary, created_at
         FROM artifact_versions WHERE artifact_id = $1 ORDER BY version`,
        [artifactId]
      );
      return { artifact: artifact.rows[0], versions: versions.rows };
    });
  });

  app.get("/v1/orgs/:orgId/artifacts/:artifactId/export", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    const { artifactId } = req.params as { artifactId: string };
    const { format } = req.query as { format?: string };

    if (format === "docx" || format === "pdf") {
      const storageKey = await ctx.inOrg(req, async (client) => {
        const { rows } = await client.query(
          `SELECT av.content->>'docxStorageKey' AS docx_key, av.content->>'pdfStorageKey' AS pdf_key
           FROM artifacts a
           JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = a.current_version
           WHERE a.id = $1 AND a.type = 'export_package'`,
          [artifactId]
        );
        const key = format === "docx" ? rows[0]?.docx_key : rows[0]?.pdf_key;
        if (!key) throw new HttpError(404, "No export available for this artifact");
        return key as string;
      });
      const buf = await ctx.deps.storage.get(storageKey);
      const contentType = format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf";
      return reply
        .header("content-disposition", `attachment; filename="application.${format}"`)
        .type(contentType)
        .send(buf);
    }

    const markdown = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query(
        `SELECT av.content->>'markdown' AS markdown
         FROM artifacts a
         JOIN artifact_versions av ON av.artifact_id = a.id AND av.version = a.current_version
         WHERE a.id = $1 AND a.type = 'export_package'`,
        [artifactId]
      );
      if (!rows[0]?.markdown) throw new HttpError(404, "No export available for this artifact");
      return rows[0].markdown as string;
    });
    return reply.type("text/markdown; charset=utf-8").send(markdown);
  });

  // ---- realtime events (SSE) ---------------------------------------------

  app.get("/v1/orgs/:orgId/events", async (req, reply) => {
    ctx.requireRole(req, "viewer");
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(`: connected\n\n`);
    const listener = (event: WorkflowEvent) => {
      if (event.tenantId === req.orgId) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    ctx.deps.engine.events.on("event", listener);
    req.raw.on("close", () => ctx.deps.engine.events.off("event", listener));
    return reply;
  });
}
