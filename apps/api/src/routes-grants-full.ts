import type { FastifyInstance } from "fastify";
import { audit, uuidv7 } from "@deedwell/database";
import {
  GrantSearchInput,
  ImportOpportunityInput,
  RecordOutcomeInput,
  StartGrantApplicationInput,
} from "@deedwell/schemas";
import { GRANT_FULL_WORKFLOW, passportStatus } from "@deedwell/grant-domain";
import type { OrgFact } from "@deedwell/schemas";
import { HttpError, type AppContext } from "./app.js";

export function registerGrantFullRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Funding Passport ---------------------------------------------------

  app.get("/v1/orgs/:orgId/passport", async (req) => {
    ctx.requireRole(req, "viewer");
    const facts = await ctx.inOrg(req, async (client) => {
      const { rows } = await client.query("SELECT fact_key, value, status FROM org_facts");
      return rows.map((r) => ({ key: r.fact_key, value: r.value, status: r.status })) as OrgFact[];
    });
    return passportStatus(facts);
  });

  // ---- Opportunity discovery & intake ------------------------------------

  app.post("/v1/orgs/:orgId/grant-search", async (req) => {
    ctx.requireRole(req, "member");
    const input = GrantSearchInput.parse(req.body);
    let results;
    try {
      results = await ctx.deps.grantSource.search(input.keyword, 10);
    } catch (err) {
      // Honest failure state (BRD §15.3): source unavailable, not fake success.
      throw new HttpError(
        502,
        `Grant source "${ctx.deps.grantSource.name}" is unavailable: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
    return { source: ctx.deps.grantSource.name, results };
  });

  app.post("/v1/orgs/:orgId/projects/:projectId/opportunities", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = ImportOpportunityInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const project = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      const opportunityId = uuidv7();
      await client.query(
        `INSERT INTO grant_opportunities (id, tenant_id, project_id, title, funder, source,
           opportunity_number, agency, deadline, funding_min, funding_max, geography, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [opportunityId, req.orgId, projectId, input.title, input.funder, input.source,
         input.opportunityNumber ?? null, input.funder, input.deadline ?? null,
         input.fundingMin ?? null, input.fundingMax ?? null, input.geography ?? null,
         input.sourceUrl ?? null]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "opportunity.imported",
        entityType: "grant_opportunity", entityId: opportunityId,
        metadata: { source: input.source, title: input.title },
      });
      return { opportunityId };
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/orgs/:orgId/opportunities", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT o.id, o.project_id, p.name AS project_name, o.title, o.funder, o.source,
                o.opportunity_number, o.deadline::text AS deadline, o.funding_max, o.status,
                o.created_at,
                (SELECT overall FROM eligibility_results er
                  WHERE er.opportunity_id = o.id ORDER BY er.created_at DESC LIMIT 1) AS eligibility,
                (SELECT recommendation FROM bid_decisions bd
                  WHERE bd.opportunity_id = o.id ORDER BY bd.created_at DESC LIMIT 1) AS bid_recommendation
         FROM grant_opportunities o JOIN projects p ON p.id = o.project_id
         ORDER BY o.created_at DESC LIMIT 200`
      )
    );
    return { opportunities: rows };
  });

  app.get("/v1/orgs/:orgId/opportunities/:opportunityId", async (req) => {
    ctx.requireRole(req, "viewer");
    const { opportunityId } = req.params as { opportunityId: string };
    return ctx.inOrg(req, async (client) => {
      const opp = await client.query(
        `SELECT o.*, o.deadline::text AS deadline FROM grant_opportunities o WHERE o.id = $1`,
        [opportunityId]
      );
      if (!opp.rows[0]) throw new HttpError(404, "Opportunity not found");
      const eligibility = await client.query(
        `SELECT overall, rule_findings, missing_facts, created_at
         FROM eligibility_results WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [opportunityId]
      );
      const bid = await client.query(
        `SELECT id, scores, total, recommendation, rationale, decision, created_at
         FROM bid_decisions WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [opportunityId]
      );
      const application = await client.query(
        `SELECT id, run_id, status, created_at FROM grant_applications
         WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [opportunityId]
      );
      return {
        opportunity: opp.rows[0],
        eligibility: eligibility.rows[0] ?? null,
        bid: bid.rows[0] ?? null,
        application: application.rows[0] ?? null,
      };
    });
  });

  // ---- Full application workflow -----------------------------------------

  app.post("/v1/orgs/:orgId/projects/:projectId/grant-application", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { projectId } = req.params as { projectId: string };
    const input = StartGrantApplicationInput.parse(req.body);
    const result = await ctx.inOrg(req, async (client) => {
      const opp = await client.query(
        "SELECT id FROM grant_opportunities WHERE id = $1 AND project_id = $2",
        [input.opportunityId, projectId]
      );
      if (!opp.rows[0]) throw new HttpError(404, "Opportunity not found in this project");
      const file = await client.query(
        "SELECT id FROM files WHERE id = $1 AND project_id = $2",
        [input.fileId, projectId]
      );
      if (!file.rows[0]) throw new HttpError(404, "File not found in this project");
      await client.query(
        "UPDATE grant_opportunities SET file_id = $2 WHERE id = $1",
        [input.opportunityId, input.fileId]
      );
      const { activeRunFor } = await import("./assistant.js");
      const running = await activeRunFor(client, projectId, "grant");
      if (running) {
        throw new HttpError(409, `A grant application run is already active for this project (${running.status})`);
      }
      const runId = await ctx.deps.engine.start(client, {
        tenantId: req.orgId!,
        projectId,
        definition: GRANT_FULL_WORKFLOW,
        createdBy: req.userId!,
        input: { opportunityId: input.opportunityId, fileId: input.fileId },
      });
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "workflow.started",
        entityType: "workflow_run", entityId: runId,
        metadata: { definition: GRANT_FULL_WORKFLOW, opportunityId: input.opportunityId },
      });
      return { runId };
    });
    return reply.status(201).send(result);
  });

  // ---- Applications & outcomes -------------------------------------------

  app.get("/v1/orgs/:orgId/applications", async (req) => {
    ctx.requireRole(req, "viewer");
    const { rows } = await ctx.inOrg(req, (client) =>
      client.query(
        `SELECT a.id, a.project_id, a.opportunity_id, a.run_id, a.status, a.created_at,
                o.title AS opportunity_title, o.funder, o.deadline::text AS deadline,
                (SELECT status FROM grant_outcomes go WHERE go.application_id = a.id) AS outcome,
                (SELECT award_amount FROM grant_outcomes go WHERE go.application_id = a.id) AS award_amount
         FROM grant_applications a JOIN grant_opportunities o ON o.id = a.opportunity_id
         ORDER BY a.created_at DESC LIMIT 200`
      )
    );
    return { applications: rows };
  });

  app.post("/v1/orgs/:orgId/applications/:applicationId/outcome", async (req, reply) => {
    ctx.requireRole(req, "member");
    const { applicationId } = req.params as { applicationId: string };
    const input = RecordOutcomeInput.parse(req.body);
    await ctx.inOrg(req, async (client) => {
      const application = await client.query(
        "SELECT id, opportunity_id FROM grant_applications WHERE id = $1",
        [applicationId]
      );
      if (!application.rows[0]) throw new HttpError(404, "Application not found");
      await client.query(
        `INSERT INTO grant_outcomes (id, tenant_id, application_id, status, award_amount, feedback, lessons, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (application_id) DO UPDATE SET
           status = EXCLUDED.status, award_amount = EXCLUDED.award_amount,
           feedback = EXCLUDED.feedback, lessons = EXCLUDED.lessons,
           recorded_by = EXCLUDED.recorded_by`,
        [uuidv7(), req.orgId, applicationId, input.status, input.awardAmount ?? null,
         input.feedback ?? null, input.lessons ?? null, req.userId]
      );
      const oppStatus = input.status === "submitted" ? "submitted" : "closed";
      await client.query(
        "UPDATE grant_opportunities SET status = $2 WHERE id = $1",
        [application.rows[0].opportunity_id, oppStatus]
      );
      await audit(client, {
        tenantId: req.orgId!, actorUser: req.userId, action: "outcome.recorded",
        entityType: "grant_application", entityId: applicationId,
        metadata: { status: input.status, awardAmount: input.awardAmount ?? null },
      });
    });
    return reply.status(201).send({ ok: true });
  });
}
