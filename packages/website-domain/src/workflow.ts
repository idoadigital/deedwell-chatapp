import { z } from "zod";
import { audit, uuidv7, type StorageAdapter } from "@deedwell/database";
import { runAgentTask, type ModelProvider } from "@deedwell/agent-runtime";
import type { ToolGateway } from "@deedwell/tools";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import {
  SitePage,
  SiteTheme,
  type OrgFact,
  type SiteContentOutput,
  type SitePatchOutput,
  type WebsiteBriefOutput,
} from "@deedwell/schemas";
import { digitalStrategist, websiteCopywriter, websiteDeveloper } from "./agents.js";
import { renderSite } from "./renderer.js";
import { blockingFailures, runSiteChecks } from "./checks.js";

export const WEBSITE_BUILD_WORKFLOW = "website-build";
export const WEBSITE_UPDATE_WORKFLOW = "website-update";

export interface WebsiteServices {
  provider: ModelProvider;
  gateway: ToolGateway;
  storage: StorageAdapter;
}

type Ctx = StepContext<WebsiteServices>;

const BuildInput = z.object({
  siteId: z.string().uuid(),
  siteName: z.string(),
  donateUrl: z.string().nullable(),
});
const UpdateInput = z.object({ siteId: z.string().uuid(), instruction: z.string() });

async function fetchFacts(ctx: Ctx, agent: typeof websiteCopywriter): Promise<OrgFact[]> {
  const { facts } = await ctx.services.gateway.invoke<{ facts: OrgFact[] }>(
    ctx.client,
    { tenantId: ctx.tenantId, userId: null, agentKey: agent.agentKey, runId: ctx.runId },
    agent,
    "fetch_org_facts",
    {}
  );
  return facts;
}

async function recordModelUsage(ctx: Ctx, agentKey: string, tokens: number): Promise<void> {
  await ctx.client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,$3,'model_tokens',$4,$5)`,
    [uuidv7(), ctx.tenantId, ctx.runId, tokens, JSON.stringify({ agentKey })]
  );
}

async function getSite(ctx: Ctx, siteId: string) {
  const { rows } = await ctx.client.query(
    "SELECT id, slug, name, theme, status, active_release_id FROM sites WHERE id = $1",
    [siteId]
  );
  if (!rows[0]) throw new Error(`Site ${siteId} not found in tenant scope`);
  return rows[0] as {
    id: string; slug: string; name: string; theme: Record<string, unknown>;
    status: string; active_release_id: string | null;
  };
}

/** A site must have a root page: if no page is slugged "home", the first
 *  page becomes it — deterministic, applied on both read and write so page
 *  sets written before this rule self-heal. */
function normalizeHome(pages: SitePage[]): SitePage[] {
  return pages.some((p) => p.slug === "home")
    ? pages
    : pages.map((p, i) => (i === 0 ? { ...p, slug: "home" } : p));
}

async function loadPages(ctx: Ctx, siteId: string): Promise<SitePage[]> {
  const { rows } = await ctx.client.query(
    "SELECT slug, title, blocks, seo FROM site_pages WHERE site_id = $1 ORDER BY order_idx",
    [siteId]
  );
  const pages = rows.map((r) =>
    SitePage.parse({
      slug: r.slug,
      title: r.title,
      blocks: r.blocks,
      seoDescription: r.seo?.description ?? "",
    })
  );
  return normalizeHome(pages);
}

/** Replace the site's page set (the CMS working copy) with `pages`. */
async function replacePages(ctx: Ctx, siteId: string, rawPages: SitePage[]): Promise<void> {
  const pages = normalizeHome(rawPages);
  const keep = pages.map((p) => p.slug);
  await ctx.client.query(
    "DELETE FROM site_pages WHERE site_id = $1 AND NOT (slug = ANY($2))",
    [siteId, keep]
  );
  for (const [idx, page] of pages.entries()) {
    await ctx.client.query(
      `INSERT INTO site_pages (id, tenant_id, site_id, slug, title, order_idx, blocks, seo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id, slug) DO UPDATE SET
         title = EXCLUDED.title, order_idx = EXCLUDED.order_idx,
         blocks = EXCLUDED.blocks, seo = EXCLUDED.seo`,
      [uuidv7(), ctx.tenantId, siteId, page.slug, page.title, idx,
       JSON.stringify(page.blocks), JSON.stringify({ description: page.seoDescription })]
    );
  }
}

// ---------------------------------------------------------------------------
// Shared steps: build a release from the CMS working copy, then gate publish.
// ---------------------------------------------------------------------------

async function buildRelease(ctx: Ctx, siteId: string): Promise<StepResult> {
  const site = await getSite(ctx, siteId);
  const pages = await loadPages(ctx, siteId);
  if (!pages.length) throw new Error("Site has no pages to build");
  const theme = SiteTheme.parse(site.theme);

  const files = renderSite({ siteName: site.name, slug: site.slug, pages, theme });
  const checks = runSiteChecks(files, pages);

  const { rows: versionRow } = await ctx.client.query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM site_releases WHERE site_id = $1",
    [siteId]
  );
  const version = Number(versionRow[0].next);
  const prefix = `tenants/${ctx.tenantId}/sites/${siteId}/releases/v${version}`;
  for (const file of files) {
    await ctx.services.storage.put(`${prefix}/${file.path}`, Buffer.from(file.content, "utf8"));
  }

  const releaseId = uuidv7();
  await ctx.client.query(
    `INSERT INTO site_releases (id, tenant_id, site_id, version, snapshot, storage_prefix, checks, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [releaseId, ctx.tenantId, siteId, version,
     JSON.stringify({ siteName: site.name, slug: site.slug, theme, pages }),
     prefix, JSON.stringify(checks), ctx.runId]
  );
  await ctx.client.query(
    `UPDATE sites SET preview_release_id = $2,
       status = CASE WHEN status = 'published' THEN 'published' ELSE 'preview' END
     WHERE id = $1`,
    [siteId, releaseId]
  );

  const failures = checks.filter((c) => !c.pass);
  const blocking = blockingFailures(checks);
  const describe = (f: (typeof checks)[number]) => `${f.name}${f.page ? ` (${f.page})` : ""}: ${f.detail}`;

  // Versioned test report artifact (spec §8/§10): the QA record of exactly
  // what was validated on this release, kept alongside every other artifact.
  const { rows: existingReport } = await ctx.client.query(
    "SELECT id, current_version FROM artifacts WHERE run_id = $1 AND type = 'website_test_report'",
    [ctx.runId]
  );
  const reportId = existingReport[0]?.id ?? uuidv7();
  const reportVersion = (existingReport[0]?.current_version ?? 0) + 1;
  if (!existingReport[0]) {
    await ctx.client.query(
      `INSERT INTO artifacts (id, tenant_id, project_id, run_id, type, title, current_version)
       VALUES ($1,$2,$3,$4,'website_test_report',$5,0)`,
      [reportId, ctx.tenantId, ctx.projectId, ctx.runId, `Site test report — ${site.name}`]
    );
  }
  await ctx.client.query(
    `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content,
       created_by_kind, created_by_agent, change_summary)
     VALUES ($1,$2,$3,$4,$5,'agent','website.qa_deployment',$6)`,
    [uuidv7(), ctx.tenantId, reportId, reportVersion, JSON.stringify({
      releaseId, version, checks,
      passed: checks.length - failures.length, failed: failures.length, blocking: blocking.length,
    }), `v${version}: ${checks.length - failures.length}/${checks.length} checks passed, ${blocking.length} blocking failure(s)`]
  );
  await ctx.client.query("UPDATE artifacts SET current_version = $2 WHERE id = $1", [reportId, reportVersion]);

  if (blocking.length) {
    // A broken site must never reach the publish gate (spec §8). The preview
    // stays inspectable; the run ends with the honest failure list.
    await audit(ctx.client, {
      tenantId: ctx.tenantId, actorAgent: "website.qa_deployment",
      action: "site.release_failed_validation", entityType: "site_release", entityId: releaseId,
      metadata: { version, blocking: blocking.length, failedChecks: failures.length },
    });
    return {
      state: {
        ...ctx.state, releaseId, version, published: false,
        failedChecks: failures.length,
        blockingChecks: blocking.map(describe),
        testReportArtifactId: reportId,
        previewPath: `/preview/${site.slug}/`,
      },
      complete: true,
    };
  }

  const approvalId = uuidv7();
  await ctx.client.query(
    `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'publish_site',$4)`,
    [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
      siteId, releaseId, version,
      previewPath: `/preview/${site.slug}/`,
      warnings: failures.map(describe),
      testReportArtifactId: reportId,
    })]
  );
  await audit(ctx.client, {
    tenantId: ctx.tenantId, actorAgent: "website.qa_deployment",
    action: "site.release_built", entityType: "site_release", entityId: releaseId,
    metadata: { version, failedChecks: failures.length },
  });
  return {
    state: { ...ctx.state, releaseId, version, failedChecks: failures.length, testReportArtifactId: reportId },
    wait: { kind: "approval", payload: { approvalId, kind: "publish_site" }, resumeStep: "publish_gate" },
  };
}

async function publishGate(ctx: Ctx, siteId: string): Promise<StepResult> {
  const { rows } = await ctx.client.query(
    `SELECT id, status, decided_by FROM approvals
     WHERE run_id = $1 AND kind = 'publish_site' ORDER BY created_at DESC LIMIT 1`,
    [ctx.runId]
  );
  const approval = rows[0];
  if (!approval || approval.status === "pending") {
    return {
      state: ctx.state,
      wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "publish_gate" },
    };
  }
  if (approval.status === "rejected") {
    // Site stays in preview; the user iterates via conversational updates.
    return { state: { ...ctx.state, published: false }, complete: true };
  }
  const releaseId = z.string().uuid().parse(ctx.state.releaseId);
  await ctx.client.query(
    `UPDATE site_releases SET status = 'superseded'
     WHERE site_id = $1 AND status = 'published' AND id <> $2`,
    [siteId, releaseId]
  );
  await ctx.client.query(
    `UPDATE site_releases SET status = 'published', published_at = now(), approved_by = $2
     WHERE id = $1`,
    [releaseId, approval.decided_by]
  );
  await ctx.client.query(
    "UPDATE sites SET active_release_id = $2, status = 'published' WHERE id = $1",
    [siteId, releaseId]
  );
  await audit(ctx.client, {
    tenantId: ctx.tenantId, actorUser: approval.decided_by,
    actorAgent: "website.qa_deployment", action: "site.published",
    entityType: "site_release", entityId: releaseId, metadata: { siteId },
  });
  return { state: { ...ctx.state, published: true }, complete: true };
}

// ---------------------------------------------------------------------------

export function buildWebsiteBuildWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_BUILD_WORKFLOW,
    version: 2,
    initialStep: "discovery",
    stepBudget: 25,
    steps: {
      // Stage 1 (spec §5): confirm what we know, ask only for what's missing.
      // No page is generated until the essentials exist and the brief is approved.
      async discovery(ctx): Promise<StepResult> {
        const facts = await fetchFacts(ctx, digitalStrategist);
        const usable = new Set(
          facts.filter((f) => f.status === "verified" || f.status === "user_certified").map((f) => f.key)
        );
        const needed = ["mission", "programs", "beneficiaries", "service_area", "headquarters"];
        const missing = needed.filter((k) => !usable.has(k));
        if (missing.length) {
          return {
            state: { ...ctx.state, missingFacts: missing },
            wait: { kind: "info", payload: { missingFacts: missing, context: "website_discovery" }, resumeStep: "discovery" },
          };
        }
        return { state: ctx.state, next: "intake_brief" };
      },

      async intake_brief(ctx): Promise<StepResult> {
        const input = BuildInput.parse(ctx.state.input);
        const facts = await fetchFacts(ctx, digitalStrategist);
        const result = await runAgentTask<WebsiteBriefOutput>(
          ctx.services.provider, digitalStrategist,
          "Produce a website brief for this organization.",
          [
            { label: "org_facts", content: JSON.stringify(facts) },
            { label: "intake", content: JSON.stringify({ siteName: input.siteName, donateUrl: input.donateUrl }) },
          ]
        );
        await recordModelUsage(ctx, digitalStrategist.agentKey, result.tokensEstimated);
        await ctx.client.query("UPDATE sites SET theme = $2 WHERE id = $1", [
          input.siteId, JSON.stringify(result.output.theme),
        ]);
        // Artifact for the workspace panel (versioned like everything else).
        const { rows: existing } = await ctx.client.query(
          "SELECT id, current_version FROM artifacts WHERE run_id = $1 AND type = 'website_brief'",
          [ctx.runId]
        );
        const artifactId = existing[0]?.id ?? uuidv7();
        const version = (existing[0]?.current_version ?? 0) + 1;
        if (!existing[0]) {
          await ctx.client.query(
            `INSERT INTO artifacts (id, tenant_id, project_id, run_id, type, title, current_version)
             VALUES ($1,$2,$3,$4,'website_brief',$5,0)`,
            [artifactId, ctx.tenantId, ctx.projectId, ctx.runId, `Website brief — ${input.siteName}`]
          );
        }
        await ctx.client.query(
          `INSERT INTO artifact_versions (id, tenant_id, artifact_id, version, content,
             created_by_kind, created_by_agent, change_summary)
           VALUES ($1,$2,$3,$4,$5,'agent',$6,$7)`,
          [uuidv7(), ctx.tenantId, artifactId, version, JSON.stringify(result.output),
           digitalStrategist.agentKey, `Brief with ${result.output.sitemap.length}-page sitemap`]
        );
        await ctx.client.query("UPDATE artifacts SET current_version = $2 WHERE id = $1", [artifactId, version]);
        // Stage 2 (spec §5): the brief must be approved before any build starts.
        const approvalId = uuidv7();
        await ctx.client.query(
          `INSERT INTO approvals (id, tenant_id, run_id, kind, payload) VALUES ($1,$2,$3,'website_brief',$4)`,
          [approvalId, ctx.tenantId, ctx.runId, JSON.stringify({
            artifactId, sitemap: result.output.sitemap.map((s) => s.title),
          })]
        );
        return {
          state: { ...ctx.state, brief: result.output, briefArtifactId: artifactId },
          wait: { kind: "approval", payload: { approvalId, kind: "website_brief" }, resumeStep: "brief_gate" },
        };
      },

      async brief_gate(ctx): Promise<StepResult> {
        const { rows } = await ctx.client.query(
          `SELECT id, status FROM approvals WHERE run_id = $1 AND kind = 'website_brief'
           ORDER BY created_at DESC LIMIT 1`,
          [ctx.runId]
        );
        const approval = rows[0];
        if (!approval || approval.status === "pending") {
          return {
            state: ctx.state,
            wait: { kind: "approval", payload: { approvalId: approval?.id ?? null }, resumeStep: "brief_gate" },
          };
        }
        if (approval.status === "rejected") {
          // Honest stop: the user shapes the brief conversationally and re-asks.
          return { state: { ...ctx.state, briefRejected: true }, complete: true };
        }
        return { state: ctx.state, next: "generate_content" };
      },

      async generate_content(ctx): Promise<StepResult> {
        const input = BuildInput.parse(ctx.state.input);
        const facts = await fetchFacts(ctx, websiteCopywriter);
        const result = await runAgentTask<SiteContentOutput>(
          ctx.services.provider, websiteCopywriter,
          "Write the site's pages using only the approved organizational facts.",
          [
            { label: "org_facts", content: JSON.stringify(facts) },
            { label: "intake", content: JSON.stringify({ siteName: input.siteName, donateUrl: input.donateUrl }) },
            { label: "brief", content: JSON.stringify(ctx.state.brief ?? {}) },
          ]
        );
        await recordModelUsage(ctx, websiteCopywriter.agentKey, result.tokensEstimated);
        await replacePages(ctx, input.siteId, result.output.pages);
        if (result.output.placeholders.length) {
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: websiteCopywriter.agentKey,
            action: "site.placeholders_flagged", entityType: "site", entityId: input.siteId,
            metadata: { placeholders: result.output.placeholders },
          });
        }
        return {
          state: { ...ctx.state, placeholders: result.output.placeholders },
          next: "build_release",
        };
      },

      async build_release(ctx): Promise<StepResult> {
        return buildRelease(ctx, BuildInput.parse(ctx.state.input).siteId);
      },
      async publish_gate(ctx): Promise<StepResult> {
        return publishGate(ctx, BuildInput.parse(ctx.state.input).siteId);
      },
    },
  };
}

export function buildWebsiteUpdateWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_UPDATE_WORKFLOW,
    version: 1,
    initialStep: "apply_patch",
    stepBudget: 15,
    steps: {
      async apply_patch(ctx): Promise<StepResult> {
        const input = UpdateInput.parse(ctx.state.input);
        const pages = await loadPages(ctx, input.siteId);
        const result = await runAgentTask<SitePatchOutput>(
          ctx.services.provider, websiteDeveloper,
          "Translate the user's change request into a patch against the structured page model.",
          [
            { label: "pages", content: JSON.stringify(pages) },
            { label: "instruction", content: input.instruction },
          ]
        );
        await recordModelUsage(ctx, websiteDeveloper.agentKey, result.tokensEstimated);
        if (!result.output.applied) {
          // Honest failure surface — no fake success (BRD §15.3).
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
            action: "site.update_not_understood", entityType: "site", entityId: input.siteId,
            metadata: { instruction: input.instruction, reason: result.output.reason },
          });
          return {
            state: { ...ctx.state, applied: false, reason: result.output.reason },
            complete: true,
          };
        }
        // Destructive-output guard: a patch that silently drops pages the
        // user never asked to remove must not delete them — small models
        // sometimes return only the page they edited. Removals are honored
        // only when the instruction actually asks for one.
        const wantsRemoval = /\b(remove|delete|drop|take (down|off))\b/i.test(input.instruction);
        const returnedSlugs = new Set(result.output.pages.map((p) => p.slug));
        const preserved = wantsRemoval ? [] : pages.filter((p) => !returnedSlugs.has(p.slug));
        const mergedPages = [...result.output.pages, ...preserved];
        if (preserved.length) {
          await audit(ctx.client, {
            tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
            action: "site.patch_pages_preserved", entityType: "site", entityId: input.siteId,
            metadata: { preserved: preserved.map((p) => p.slug), instruction: input.instruction },
          });
        }
        await replacePages(ctx, input.siteId, mergedPages);
        await audit(ctx.client, {
          tenantId: ctx.tenantId, actorAgent: websiteDeveloper.agentKey,
          action: "site.pages_updated", entityType: "site", entityId: input.siteId,
          metadata: { changeSummary: result.output.changeSummary },
        });
        return {
          state: { ...ctx.state, applied: true, changeSummary: result.output.changeSummary },
          next: "build_release",
        };
      },
      async build_release(ctx): Promise<StepResult> {
        return buildRelease(ctx, UpdateInput.parse(ctx.state.input).siteId);
      },
      async publish_gate(ctx): Promise<StepResult> {
        return publishGate(ctx, UpdateInput.parse(ctx.state.input).siteId);
      },
    },
  };
}
