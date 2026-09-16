import { z } from "zod";
import { audit, loadMissionProfile, missionProfileBlock, uuidv7 } from "@deedwell/database";
import { runAgentTask, type ModelDataBlock } from "@deedwell/agent-runtime";
import type { StepContext, StepResult, WorkflowDefinition } from "@deedwell/workflows";
import { SiteEditPlan, type SiteEditOp } from "@deedwell/schemas";
import { CATALOG } from "../builder/index.js";
import { websiteEditor } from "../agents.js";
import type { WebsiteServices } from "../workflow.js";
import { loadSiteLogoFrom } from "../workflow.js";
import { describeMap, inspectPages, type InspectedPage, type Measurement } from "./inspect.js";
import { JobProgress, loadJob, type JobStep } from "./jobs.js";
import { assembleRelease, restoreRelease } from "./releases.js";
import { applyOperations, loadWorkingState, renderWorkingPage, saveWorkingState, siteAssets, type WorkingState } from "./state.js";

/**
 * The editor's workflow — one customer request, carried out for real:
 *
 *   understand   inspect the page they are looking at in a browser, then plan
 *                the smallest change against what was measured
 *   apply        measure the targets before, apply the operations, re-render
 *                the affected pages deterministically, build a preview release
 *   verify       load the new pages in the browser at the planned widths,
 *                check every expectation and the page's integrity; on a hard
 *                failure put the previous version back
 *
 * Each step's progress is written as it happens; the dashboard timeline is
 * a view of this job row, not an animation.
 */

export const WEBSITE_EDIT_WORKFLOW = "website-edit";
type Ctx = StepContext<WebsiteServices>;
const Input = z.object({ siteId: z.string().uuid(), jobId: z.string().uuid() });

const VIEWPORT_PX: Record<string, number> = { mobile: 390, tablet: 768, desktop: 1440 };
const nearby = (w: number) => (w <= 400 ? [w, 360] : w <= 800 ? [w] : [w]);

function progressFor(ctx: Ctx, job: { id: string; site_id: string; steps: JobStep[]; status: string }): JobProgress | null {
  if (!ctx.services.studio) return null;
  return new JobProgress(ctx.services.studio, { id: job.id, tenantId: ctx.tenantId, siteId: job.site_id, kind: "edit" }, job.steps ?? [], job.status as never);
}

async function say(ctx: Ctx, siteId: string, jobId: string, body: string, context: Record<string, unknown> = {}): Promise<void> {
  await ctx.client.query(
    "INSERT INTO site_edit_messages (id, tenant_id, site_id, job_id, role, body, context) VALUES ($1,$2,$3,$4,'assistant',$5,$6)",
    [uuidv7(), ctx.tenantId, siteId, jobId, body, JSON.stringify(context)]);
}

function measurementsOf(pages: InspectedPage[]): Record<string, Measurement> {
  const out: Record<string, Measurement> = {};
  for (const p of pages) for (const m of p.measurements) out[`${p.slug}|${p.viewport}|${m.selector}`] = m;
  return out;
}

const px = (m: Measurement | undefined, prop: string): number | string | null => {
  if (!m?.found) return null;
  switch (prop) {
    case "fontSize": return m.fontSize; case "lineHeight": return m.lineHeight; case "height": return m.box?.height ?? null; case "width": return m.box?.width ?? null;
    case "top": return m.box?.y ?? null; case "marginTop": return m.margin?.top ?? null; case "marginBottom": return m.margin?.bottom ?? null;
    case "paddingTop": return m.padding?.top ?? null; case "paddingBottom": return m.padding?.bottom ?? null; case "color": return m.color; case "backgroundColor": return m.backgroundColor; case "display": return m.display;
    default: return null;
  }
};

export function buildWebsiteEditWorkflow(): WorkflowDefinition<WebsiteServices> {
  return {
    name: WEBSITE_EDIT_WORKFLOW,
    version: 1,
    initialStep: "understand",
    stepBudget: 12,
    steps: {
      async understand(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const job = await loadJob(ctx.client, input.jobId);
        if (!job) throw new Error("Edit job not found");
        const progress = progressFor(ctx, job);
        const context = (job.context ?? {}) as { page?: string; viewport?: string; selection?: { label?: string; selector?: string; sectionId?: string | null; text?: string } | null };
        const state = await loadWorkingState(ctx.client, input.siteId);
        const pageSlug = state.pages.some((p) => p.page.slug === context.page) ? context.page! : "home";
        const width = VIEWPORT_PX[context.viewport ?? "desktop"] ?? 1440;

        await progress?.plan([{ key: "inspect", label: `Inspecting ${pageSlug === "home" ? "homepage" : `the ${pageSlug} page`}${width < 700 ? " on mobile" : width < 1100 ? " on tablet" : ""}` }, { key: "plan", label: "Planning the change" }]);
        await progress?.start("inspect", undefined, "analyzing");

        // 1. Look at the actual page at the width the customer sees.
        const html = renderWorkingPage(state, pageSlug, { withScript: true });
        const assets = await siteAssets(ctx.services.storage, state);
        const targets = context.selection?.selector ? [context.selection.selector] : [];
        const looked = await inspectPages({ pages: [{ slug: pageSlug, html }], assets, viewports: [width], targets, siteName: state.site.name });
        const inspected = looked.pages[0] ?? null;
        await progress?.done("inspect", inspected ? `${inspected.map.sections.length} sections, ${inspected.map.height}px tall at ${width}px${inspected.checks.horizontalOverflow ? "; horizontal overflow present" : ""}` : `Browser inspection unavailable (${looked.reason ?? "unknown"}); planning from the page structure`);

        // 2. Plan against what was measured.
        await progress?.start("plan");
        const wp = state.pages.find((p) => p.page.slug === pageSlug)!;
        const { rows: history } = await ctx.client.query("SELECT role, body, context FROM site_edit_messages WHERE site_id = $1 AND created_at < now() ORDER BY created_at DESC LIMIT 12", [input.siteId]);
        const profile = await loadMissionProfile(ctx.client, ctx.services.storage, ctx.tenantId).catch(() => null);
        const { rows: lastEdits } = await ctx.client.query("SELECT result->'plan' AS plan FROM site_jobs WHERE site_id = $1 AND kind = 'edit' AND status = 'complete' AND id <> $2 ORDER BY created_at DESC LIMIT 3", [input.siteId, job.id]);
        // What the CMS holds: the editor connects pages to these records
        // (a "feed" block) instead of copying them into the page.
        const { rows: cmsPosts } = await ctx.client.query("SELECT slug, title, excerpt, status, published_at FROM site_posts WHERE site_id = $1 ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20", [input.siteId]);
        const { rows: cmsEvents } = await ctx.client.query("SELECT slug, title, status, starts_at, ends_at, location, mode FROM site_events WHERE site_id = $1 ORDER BY starts_at DESC LIMIT 20", [input.siteId]);
        const blocks: ModelDataBlock[] = [
          { label: "instruction", content: job.instruction ?? "" },
          { label: "site_content", content: JSON.stringify({ note: "Blog posts and events managed in the dashboard CMS. Only status=published ones show on the site; the router renders them at /blog/<slug>/ and /events/<slug>/ and fills feed sections from them.", posts: cmsPosts, events: cmsEvents, now: new Date().toISOString() }) },
          { label: "context", content: JSON.stringify({ page: pageSlug, viewport: context.viewport ?? "desktop", viewportWidth: width, selection: context.selection ?? null }) },
          { label: "page_map", content: inspected ? JSON.stringify({ slug: pageSlug, width, sections: inspected.map.sections.map((s) => ({ id: s.id, component: wp.composition.sections.find((x) => x.id === s.id)?.component ?? s.component, top: s.top, height: s.height, heading: s.heading, elements: s.elements })), checks: inspected.checks, description: describeMap(inspected.map) }) : JSON.stringify({ slug: pageSlug, width, unavailable: true, sections: wp.composition.sections.map((s) => ({ id: s.id, component: s.component })) }) },
          { label: "page_blocks", content: JSON.stringify(wp.page.blocks.map((b, i) => ({ index: i, ...b }))) },
          { label: "composition", content: wp.designedHtml ? JSON.stringify({ designed: true, note: "This page keeps hand-designed markup: ONLY \"style\" operations apply to it (selectors from page_map). section/copy/section-add/move/remove/tokens/page-cta are not available for this page — if the request needs them, set understood=false and explain that the page would need to be regenerated." }) : JSON.stringify(wp.composition) },
          { label: "site_pages", content: JSON.stringify(state.pages.map((p) => ({ slug: p.page.slug, title: p.page.title, sections: p.composition.sections.map((s) => `${s.id}:${s.component}`) }))) },
          { label: "design_tokens", content: JSON.stringify(state.tokens) },
          { label: "component_catalog", content: JSON.stringify(Object.entries(CATALOG).map(([name, spec]) => ({ name, family: spec.family, accepts: spec.accepts, variants: spec.variants }))) },
          { label: "existing_overrides", content: JSON.stringify(state.overrides) },
          { label: "conversation", content: JSON.stringify(history.reverse().map((m) => ({ role: m.role, body: m.body, page: m.context?.page ?? null, viewport: m.context?.viewport ?? null }))) },
          { label: "recent_changes", content: JSON.stringify(lastEdits.map((r) => r.plan).filter(Boolean)) },
          { label: "mission_profile", content: profile ? missionProfileBlock(profile) : "(no mission profile available)" },
        ];
        const planner = ctx.services.designer ?? ctx.services.provider;
        let plan: SiteEditPlan;
        try {
          const res = await runAgentTask<SiteEditPlan>(planner, websiteEditor, `The customer asked: "${job.instruction ?? ""}". Plan the smallest change that does it on the "${pageSlug}" page as seen at ${width}px.`, blocks);
          plan = SiteEditPlan.parse(res.output);
          await ctx.client.query("INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata) VALUES ($1,$2,$3,'model_tokens',$4,$5)", [uuidv7(), ctx.tenantId, ctx.runId, res.tokensEstimated, JSON.stringify({ agentKey: websiteEditor.agentKey, source: "website-edit" })]);
        } catch (err) {
          await progress?.fail("plan", String((err as Error).message ?? err).slice(0, 200));
          await progress?.complete({ status: "failed", error: "Couldn't work out how to make this change.", result: { reason: String((err as Error).message ?? err).slice(0, 300) } });
          await say(ctx, input.siteId, job.id, "Couldn't complete this change — I could not work out a safe way to do it. Try describing the section and what you want differently.", { failed: true });
          return { state: { ...ctx.state, failed: true }, complete: true };
        }
        if (!plan.understood || !plan.operations.length) {
          await progress?.done("plan", "Needs clarification");
          await progress?.complete({ status: "complete", summary: plan.clarification ?? "Nothing to change.", result: { plan, clarification: plan.clarification } });
          await say(ctx, input.siteId, job.id, plan.clarification ?? "I could not map that to a change on this page. Could you tell me which section and what should change?", { clarification: true });
          return { state: { ...ctx.state, clarification: true }, complete: true };
        }
        const viewports = [...new Set([...plan.viewports, width, ...(width < 700 ? nearby(width) : [])])].filter((v) => v >= 320 && v <= 1920).slice(0, 5);
        const affected = [...new Set([...plan.affectedPages.filter((s) => state.pages.some((p) => p.page.slug === s)), ...plan.operations.map((o) => ("page" in o ? o.page : "*")).filter((s) => s !== "*" && state.pages.some((p) => p.page.slug === s))])];
        if (plan.operations.some((o) => "page" in o && o.page === "*") || plan.operations.some((o) => o.kind === "tokens")) affected.splice(0, affected.length, ...state.pages.map((p) => p.page.slug));
        if (!affected.length) affected.push(pageSlug);
        await progress?.done("plan", plan.summary);
        await progress?.plan([
          { key: "measure", label: "Measuring the current layout" },
          { key: "apply", label: plan.title || "Applying the change" },
          { key: "build", label: `Rebuilding ${affected.length === 1 ? (affected[0] === "home" ? "the homepage" : `the ${affected[0]} page`) : `${affected.length} pages`}` },
          ...viewports.map((v) => ({ key: `verify:${v}`, label: `Checking ${v <= 480 ? "mobile" : v <= 1024 ? "tablet" : "desktop"} layout (${v}px)` })),
          { key: "preview", label: "Previewing changes" },
        ]);
        await progress?.merge({ plan, viewports, affected, page: pageSlug, width });
        await audit(ctx.client, { tenantId: ctx.tenantId, actorAgent: websiteEditor.agentKey, action: "site.edit_planned", entityType: "site", entityId: input.siteId, metadata: { jobId: job.id, title: plan.title, operations: plan.operations.length } });
        return { state: { ...ctx.state, plan, viewports, affected, pageSlug, width }, next: "apply" };
      },

      async apply(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const job = await loadJob(ctx.client, input.jobId);
        if (!job) throw new Error("Edit job not found");
        const progress = progressFor(ctx, job);
        const plan = SiteEditPlan.parse(ctx.state.plan);
        const viewports = (ctx.state.viewports as number[]) ?? [1440];
        const affected = (ctx.state.affected as string[]) ?? ["home"];
        const before = await loadWorkingState(ctx.client, input.siteId);

        // Measure the expectations' targets before anything changes.
        await progress?.start("measure", undefined, "editing");
        const targets = [...new Set(plan.expectations.map((e) => e.selector))];
        const assets = await siteAssets(ctx.services.storage, before);
        const pagesBefore = affected.map((slug) => ({ slug, html: renderWorkingPage(before, slug, { withScript: true }) }));
        const lookedBefore = await inspectPages({ pages: pagesBefore, assets, viewports, targets, siteName: before.site.name });
        await progress?.done("measure", lookedBefore.available ? `${targets.length} element${targets.length === 1 ? "" : "s"} measured at ${viewports.join("/")}px` : "Browser unavailable; verification will compare markup only");

        await progress?.start("apply");
        const applied = applyOperations(before, plan.operations as SiteEditOp[]);
        if (!applied.changed.size) {
          await progress?.fail("apply", applied.rejected.join("; ").slice(0, 300) || "Nothing changed");
          await progress?.complete({ status: "failed", error: "Couldn't complete this change.", result: { rejected: applied.rejected } });
          await say(ctx, input.siteId, job.id, `Couldn't complete this change — ${applied.rejected[0] ?? "the operations did not apply to this page"}.`, { failed: true });
          return { state: { ...ctx.state, failed: true }, complete: true };
        }
        await saveAndBuild(ctx, applied.state, applied.changed, job, plan, progress);
        const detail = [...applied.notes.slice(0, 4), ...(applied.rejected.length ? [`skipped: ${applied.rejected.slice(0, 2).join("; ")}`] : [])].join(" · ");
        await progress?.done("apply", detail.slice(0, 400));
        return {
          state: { ...ctx.state, before: { checks: lookedBefore.pages.map((p) => ({ slug: p.slug, viewport: p.viewport, checks: p.checks })), measurements: measurementsOf(lookedBefore.pages), available: lookedBefore.available }, notes: applied.notes, rejected: applied.rejected, changed: [...applied.changed] },
          next: "verify",
        };
      },

      async verify(ctx): Promise<StepResult> {
        const input = Input.parse(ctx.state.input);
        const job = await loadJob(ctx.client, input.jobId);
        if (!job) throw new Error("Edit job not found");
        const progress = progressFor(ctx, job);
        const plan = SiteEditPlan.parse(ctx.state.plan);
        const viewports = (ctx.state.viewports as number[]) ?? [1440];
        const affected = (ctx.state.affected as string[]) ?? ["home"];
        const beforeState = ctx.state.before as { checks: Array<{ slug: string; viewport: number; checks: InspectedPage["checks"] }>; measurements: Record<string, Measurement>; available: boolean };
        const state = await loadWorkingState(ctx.client, input.siteId);
        const assets = await siteAssets(ctx.services.storage, state);
        const targets = [...new Set(plan.expectations.map((e) => e.selector))];
        const pages = affected.map((slug) => ({ slug, html: renderWorkingPage(state, slug, { withScript: true }) }));

        const problems: string[] = [];
        const passed: string[] = [];
        const afterMeasurements: Record<string, Measurement> = {};
        await progress?.setStatus("verifying");
        for (const vp of viewports) {
          await progress?.start(`verify:${vp}`);
          const looked = await inspectPages({ pages, assets, viewports: [vp], targets, siteName: state.site.name, interactions: vp < 900 });
          if (!looked.available) { await progress?.skip(`verify:${vp}`, `Browser unavailable (${looked.reason ?? "unknown"})`); continue; }
          Object.assign(afterMeasurements, measurementsOf(looked.pages));
          const notes: string[] = [];
          for (const p of looked.pages) {
            const prior = beforeState?.checks?.find((b) => b.slug === p.slug && b.viewport === vp)?.checks;
            if (p.checks.horizontalOverflow && !prior?.horizontalOverflow) problems.push(`${p.slug} at ${vp}px now scrolls horizontally (${p.checks.scrollWidth}px wide)`);
            if (p.checks.overlaps.length > (prior?.overlaps.length ?? 0)) problems.push(`${p.slug} at ${vp}px: elements overlap (${p.checks.overlaps[0]?.a} / ${p.checks.overlaps[0]?.b})`);
            if (p.checks.brokenImages.length > (prior?.brokenImages.length ?? 0)) problems.push(`${p.slug} at ${vp}px: an image no longer loads`);
            if (p.checks.headings.h1Count !== 1) problems.push(`${p.slug}: expected one h1, found ${p.checks.headings.h1Count}`);
            if (vp < 900 && p.checks.nav.toggleVisible && p.checks.nav.menuWorks === "broken") problems.push(`${p.slug} at ${vp}px: the mobile menu does not open`);
            if (p.checks.emptySections.length > (prior?.emptySections.length ?? 0)) problems.push(`${p.slug} at ${vp}px: a section is empty`);
            notes.push(`${p.slug}: ${p.checks.horizontalOverflow ? "overflows" : "no overflow"}, ${p.checks.overlaps.length} overlap(s)${vp < 900 && p.checks.nav.toggleVisible ? `, menu ${p.checks.nav.menuWorks}` : ""}`);
          }
          // Expectations at this width.
          for (const e of plan.expectations.filter((x) => x.viewport === vp)) {
            for (const slug of affected) {
              const key = `${slug}|${vp}|${e.selector}`;
              const b = beforeState?.measurements?.[key]; const a = afterMeasurements[key];
              if (!a?.found) { if (b?.found) problems.push(`${e.selector} disappeared from ${slug} at ${vp}px`); continue; }
              const bv = px(b, e.property); const av = px(a, e.property);
              if (bv == null || av == null) continue;
              const numeric = typeof bv === "number" && typeof av === "number";
              const ok = e.direction === "equal" ? (numeric ? Math.abs(av - bv) < 0.5 : av === bv)
                : e.direction === "change" ? av !== bv
                : e.direction === "decrease" ? (numeric && av < bv - 0.5)
                : (numeric && av > bv + 0.5);
              const line = `${e.selector} ${e.property} ${bv}${numeric ? "px" : ""} → ${av}${numeric ? "px" : ""} at ${vp}px`;
              if (ok) passed.push(line); else problems.push(`expected ${e.property} to ${e.direction === "equal" ? "stay the same" : e.direction}: ${line}`);
              break;
            }
          }
          await progress?.done(`verify:${vp}`, notes.join(" · ").slice(0, 300));
        }

        const hard = problems.filter((p) => /scrolls horizontally|overlap|no longer loads|disappeared|menu does not open|expected one h1/.test(p));
        const expectationMisses = problems.filter((p) => p.startsWith("expected "));
        if (hard.length || (expectationMisses.length && !passed.length && plan.expectations.length > 0)) {
          // Put the previous version back; the customer never sees a broken page.
          const reason = (hard[0] ?? expectationMisses[0])!;
          await progress?.start("preview", "Restoring the previous version");
          if (job.release_before) {
            try { await restoreRelease(ctx.client, { storage: ctx.services.storage, tenantId: ctx.tenantId, siteId: input.siteId, releaseId: job.release_before, userId: job.created_by, label: `Rolled back: ${plan.title}`, kind: "restore" }); }
            catch (err) { problems.push(`rollback failed: ${String((err as Error).message ?? err).slice(0, 120)}`); }
          }
          await progress?.fail("preview", reason.slice(0, 300));
          await progress?.complete({ status: "failed", error: "Couldn't complete this change.", result: { problems, passed, rolledBack: Boolean(job.release_before) } });
          await say(ctx, input.siteId, job.id, `Couldn't complete this change. I made it, checked it in a browser and found a problem (${reason}), so I put the previous version back. You can try again with different wording.`, { failed: true, problems });
          await audit(ctx.client, { tenantId: ctx.tenantId, actorAgent: websiteEditor.agentKey, action: "site.edit_rolled_back", entityType: "site", entityId: input.siteId, metadata: { jobId: job.id, problems } });
          return { state: { ...ctx.state, failed: true, problems }, complete: true };
        }

        await progress?.start("preview");
        const checked = viewports.map((v) => `${v}px`).join(", ");
        const softNotes = expectationMisses.length ? ` One check did not confirm (${expectationMisses[0]}), so please look at it.` : "";
        const reply = `${plan.reply.trim()}${/verified|checked/i.test(plan.reply) ? "" : ` I checked it at ${checked}.`}${softNotes}`;
        await progress?.done("preview", "Preview ready");
        await progress?.complete({ status: "complete", summary: plan.title, result: { verified: passed, problems, notes: ctx.state.notes, rejected: ctx.state.rejected }, releaseAfter: (ctx.state.releaseAfter as string) ?? null });
        await say(ctx, input.siteId, job.id, reply, { verified: passed, problems, releaseId: ctx.state.releaseAfter ?? null, title: plan.title });
        await audit(ctx.client, { tenantId: ctx.tenantId, actorAgent: websiteEditor.agentKey, action: "site.edit_verified", entityType: "site", entityId: input.siteId, metadata: { jobId: job.id, verified: passed.length, problems: problems.length } });
        return { state: { ...ctx.state, done: true }, complete: true };
      },
    },
  };
}

/** Saves the working state and builds a preview release from it. */
async function saveAndBuild(ctx: Ctx, state: WorkingState, changed: Set<string>, job: { id: string; created_by: string | null }, plan: SiteEditPlan, progress: JobProgress | null): Promise<void> {
  await saveWorkingState(ctx.client, state, changed);
  await progress?.start("build", undefined, "building");
  const logo = await loadSiteLogoFrom(ctx.client, ctx.services.storage);
  const release = await assembleRelease({ client: ctx.client, storage: ctx.services.storage, tenantId: ctx.tenantId, siteId: state.site.id, runId: ctx.runId, kind: "edit", label: plan.title, createdBy: job.created_by, createdByKind: "agent", logo });
  // The job row is written only by the progress writer (outside this
  // transaction) — touching it here would block that writer until commit.
  ctx.state.releaseAfter = release.releaseId;
  await progress?.merge({ releaseAfter: release.releaseId });
  await progress?.done("build", `Preview version ${release.version} built${release.blocking.length ? ` — ${release.blocking.length} blocking check(s)` : ""}`);
}
