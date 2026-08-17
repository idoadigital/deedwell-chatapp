import type { PoolClient } from "pg";
import { uuidv7, withContext } from "@deedwell/database";
import type { Deps } from "./bootstrap.js";

/**
 * Grant application workspace layer (workspace spec §1, §4, §19).
 * Timeline events describe verifiable actions — an event is only written when
 * the underlying work actually happened (a workflow step transitioned, a
 * retrieval succeeded or failed). Never model reasoning, never fake progress.
 */

export interface WorkspaceEventInput {
  tenantId: string;
  projectId: string;
  runId?: string | null;
  eventType: string;
  title: string;
  summary?: string;
  status: "in_progress" | "completed" | "failed" | "blocked";
  agentKey?: string | null;
  artifactId?: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export async function recordEvent(client: PoolClient, e: WorkspaceEventInput): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary,
       status, agent_key, artifact_id, metadata, error, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       CASE WHEN $8 IN ('completed','failed') THEN now() ELSE NULL END)`,
    [id, e.tenantId, e.projectId, e.runId ?? null, e.eventType, e.title, e.summary ?? "",
     e.status, e.agentKey ?? null, e.artifactId ?? null, JSON.stringify(e.metadata ?? {}),
     e.error ?? null]
  );
  return id;
}

export async function recordSource(client: PoolClient, s: {
  tenantId: string; projectId: string; url?: string | null; title: string;
  publisher?: string | null;
  /** Provenance is stated by the caller, never assumed: a failed fetch or a
   *  third-party page must not be recorded as a retrieved primary source. */
  sourceType: string; reliability: string; fetchStatus: string;
  fileId?: string | null; excerpt?: string;
}): Promise<string> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO research_sources (id, tenant_id, project_id, url, title, publisher,
       source_type, reliability, fetch_status, file_id, excerpt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, s.tenantId, s.projectId, s.url ?? null, s.title, s.publisher ?? null,
     s.sourceType, s.reliability, s.fetchStatus,
     s.fileId ?? null, (s.excerpt ?? "").slice(0, 1500)]
  );
  return id;
}

export async function setWorkspace(
  client: PoolClient,
  projectId: string,
  status: string,
  phase: string,
  pendingIntent?: Record<string, unknown> | null
): Promise<void> {
  if (pendingIntent === undefined) {
    await client.query(
      "UPDATE projects SET workspace_status = $2, workspace_phase = $3 WHERE id = $1",
      [projectId, status, phase]
    );
  } else {
    await client.query(
      "UPDATE projects SET workspace_status = $2, workspace_phase = $3, pending_intent = $4 WHERE id = $1",
      [projectId, status, phase, pendingIntent ? JSON.stringify(pendingIntent) : null]
    );
  }
}

// ---------------------------------------------------------------------------
// Engine step → timeline bridge. Each event corresponds to a REAL workflow
// step transition persisted by the durable engine (survives restarts).
// ---------------------------------------------------------------------------

/**
 * Honest descriptions of what each workflow step does. Events are recorded
 * when a step STARTS (status in_progress), so summaries are present-tense —
 * a past-tense summary on a running step would claim work that hasn't
 * happened yet.
 */
const STEP_EVENTS: Record<string, { title: string; summary: string; agent: string }> = {
  // ---- grant-application-full ------------------------------------------
  parse_document: {
    title: "Parsing the announcement document",
    summary: "Extracting the text of the funding announcement and scanning it for prompt-injection content.",
    agent: "grant.requirements_analyst",
  },
  research_sources: {
    title: "Researching the funder and program",
    summary: "Reading the opportunity's linked pages and recording every source consulted, including pages that could not be reached.",
    agent: "grant.opportunity_researcher",
  },
  extract_requirements: {
    title: "Extracting requirements",
    summary: "Reading the announcement and building the compliance matrix with every application requirement, each linked to its source line.",
    agent: "grant.requirements_analyst",
  },
  eligibility_check: {
    title: "Checking eligibility",
    summary: "Comparing the announcement's eligibility rules against your organization's certified facts.",
    agent: "grant.eligibility_analyst",
  },
  bid_no_bid: {
    title: "Scoring the bid assessment",
    summary: "Scoring fit across eligibility, alignment, capacity, and deadline to recommend pursue or pass.",
    agent: "grant.funding_strategist",
  },
  bid_gate: {
    title: "Waiting for your go/no-go decision",
    summary: "The pursue-or-pass decision is yours; the team is paused until you decide.",
    agent: "grant.funding_strategist",
  },
  plan_application: {
    title: "Planning the application",
    summary: "Mapping every mandatory requirement to a planned section.",
    agent: "grant.writer",
  },
  draft_sections: {
    title: "Drafting narrative sections",
    summary: "Writing each planned section from certified organizational facts; unsupported claims are flagged, not invented.",
    agent: "grant.writer",
  },
  build_budget: {
    title: "Building the budget",
    summary: "Producing the line-item budget with justifications.",
    agent: "grant.budget_specialist",
  },
  build_logic_model: {
    title: "Building the logic model",
    summary: "Connecting activities to outputs and outcomes for the evaluation section.",
    agent: "grant.mel_specialist",
  },
  review_panel: {
    title: "Running the internal review panel",
    summary: "A reviewer panel scores the draft against the announcement's requirements.",
    agent: "grant.reviewer_panel",
  },
  final_compliance: {
    title: "Running the final compliance check",
    summary: "Verifying mandatory requirements, claims support, budget math, and the deadline.",
    agent: "grant.compliance_reviewer",
  },
  final_gate: {
    title: "Waiting for your export approval",
    summary: "The reviewed package is ready; export happens only after your approval.",
    agent: "grant.reviewer_panel",
  },
  export_full: {
    title: "Exporting the application package",
    summary: "Rendering the full application (markdown + budget CSV) into downloadable files.",
    agent: "grant.writer",
  },
  // ---- website-build / website-update ----------------------------------
  discovery: {
    title: "Gathering what the website needs",
    summary: "Checking which organizational facts are already on record and asking only for what's genuinely missing.",
    agent: "website.digital_strategist",
  },
  intake_brief: {
    title: "Drafting the website brief",
    summary: "Writing the goals, audiences, sitemap, and visual direction for your approval.",
    agent: "website.digital_strategist",
  },
  brief_gate: {
    title: "Waiting for your brief approval",
    summary: "Nothing gets built until you approve the plan.",
    agent: "website.digital_strategist",
  },
  generate_content: {
    title: "Writing the page content",
    summary: "Drafting every page from your approved organizational facts; gaps become visible placeholders, not invented copy.",
    agent: "website.copywriter",
  },
  apply_patch: {
    title: "Applying your requested change",
    summary: "Translating the request into a concrete page change — or reporting honestly that it can't be.",
    agent: "website.developer",
  },
  build_release: {
    title: "Building and testing the release",
    summary: "Rendering every page, then checking routes, internal links, forms, headings, and remaining placeholders.",
    agent: "website.qa_deployment",
  },
  publish_gate: {
    title: "Waiting for your publish approval",
    summary: "The preview is ready; the site goes live only after your approval.",
    agent: "website.qa_deployment",
  },
};

/** Map workflow step to a coarse workspace phase for the Overview tab. */
export function phaseForStep(step: string): string {
  if (["parse_document", "research_sources", "extract_requirements"].includes(step)) return "Analyzing requirements";
  if (["eligibility_check"].includes(step)) return "Checking eligibility";
  if (["bid_no_bid", "bid_gate"].includes(step)) return "Bid decision";
  if (["plan_application", "draft_sections", "build_budget", "build_logic_model"].includes(step)) return "Drafting";
  if (["review_panel", "final_compliance"].includes(step)) return "Internal review";
  if (["final_gate"].includes(step)) return "Ready for your review";
  if (["export_full"].includes(step)) return "Final package";
  if (["discovery", "intake_brief"].includes(step)) return "Planning the website";
  if (["brief_gate"].includes(step)) return "Waiting on the brief";
  if (["generate_content", "apply_patch"].includes(step)) return "Writing pages";
  if (["build_release"].includes(step)) return "Building and testing";
  if (["publish_gate"].includes(step)) return "Ready to publish";
  return step.replace(/_/g, " ");
}

/** Real step order per workflow definition — completion is the fraction of
 *  persisted engine steps actually passed, never a timer. */
const DEFINITION_STEPS: Record<string, string[]> = {
  "grant-application-full": [
    "parse_document", "research_sources", "extract_requirements", "eligibility_check",
    "bid_no_bid", "bid_gate", "plan_application", "draft_sections", "build_budget",
    "build_logic_model", "review_panel", "final_compliance", "final_gate", "export_full",
  ],
  "website-build": ["discovery", "intake_brief", "brief_gate", "generate_content", "build_release", "publish_gate"],
  "website-update": ["apply_patch", "build_release", "publish_gate"],
};

export function completionForRun(currentStep: string, status: string, definition = "grant-application-full"): number {
  if (status === "completed") return 100;
  const order = DEFINITION_STEPS[definition] ?? [];
  const idx = order.indexOf(currentStep);
  if (idx < 0) return 5;
  return Math.min(95, Math.round(5 + (idx / order.length) * 90));
}

const inflightW = new Set<Promise<void>>();

/**
 * Records a timeline event for each grant-workflow step transition the durable
 * engine persists. Dedupe: one event per (run, step) — refreshes and worker
 * retries do not create duplicates.
 */
export function attachWorkspaceBridge(deps: Deps): void {
  deps.engine.events.on("event", (event: { type: string; tenantId: string; runId: string; status: string; step: string }) => {
    if (event.type !== "run_updated") return;
    const p = stepEvent(deps, event).catch(() => undefined).then(() => { inflightW.delete(p); });
    inflightW.add(p);
  });
}

/** Tests await this after engine.drain() so timeline rows are visible. */
export async function workspaceBridgeFlush(): Promise<void> {
  while (inflightW.size) await Promise.all([...inflightW]);
}

async function stepEvent(
  deps: Deps,
  event: { tenantId: string; runId: string; status: string; step: string }
): Promise<void> {
  const known = STEP_EVENTS[event.step];
  await withContext(deps.appPool, { tenantId: event.tenantId, userId: null }, async (client) => {
    const run = await client.query(
      "SELECT project_id, definition, last_error FROM workflow_runs WHERE id = $1",
      [event.runId]
    );
    if (!run.rows[0]) return; // grant AND website runs both get a real timeline
    const projectId = run.rows[0].project_id;

    if (event.status === "failed") {
      await recordEvent(client, {
        tenantId: event.tenantId, projectId, runId: event.runId,
        eventType: "step_failed", status: "failed",
        title: `${known?.title ?? event.step.replace(/_/g, " ")} — failed`,
        summary: "The step stopped after several attempts. Completed work is preserved; the run can be resumed once the cause is fixed.",
        error: String(run.rows[0].last_error ?? "").slice(0, 400) || null,
        agentKey: known?.agent ?? null,
      });
      await setWorkspace(client, projectId, "blocked", "Needs attention");
      return;
    }
    // The engine emits the step now CURRENT — so arriving at step X means the
    // previous step finished. Close out any open step events for this run.
    await client.query(
      `UPDATE workspace_events SET status = 'completed', completed_at = now()
       WHERE run_id = $1 AND status IN ('in_progress','blocked') AND event_type LIKE 'step:%'
         AND event_type <> $2`,
      [event.runId, `step:${event.step}`]
    );
    if (event.status === "completed") {
      await client.query(
        `UPDATE workspace_events SET status = 'completed', completed_at = now()
         WHERE run_id = $1 AND status IN ('in_progress','blocked') AND event_type LIKE 'step:%'`,
        [event.runId]
      );
    }
    if (!known) return;
    // One event per (run, step): the engine may re-emit on lease renewals.
    const dup = await client.query(
      `SELECT 1 FROM workspace_events WHERE run_id = $1 AND event_type = $2 LIMIT 1`,
      [event.runId, `step:${event.step}`]
    );
    if (!dup.rows[0] && event.status !== "completed") {
      await recordEvent(client, {
        tenantId: event.tenantId, projectId, runId: event.runId,
        eventType: `step:${event.step}`,
        title: known.title, summary: known.summary,
        status: event.status === "waiting_for_info" || event.status === "waiting_approval" ? "blocked" : "in_progress",
        agentKey: known.agent,
      });
    } else if (dup.rows[0] && (event.status === "waiting_for_info" || event.status === "waiting_approval")) {
      await client.query(
        `UPDATE workspace_events SET status = 'blocked' WHERE run_id = $1 AND event_type = $2`,
        [event.runId, `step:${event.step}`]
      );
    }
    const status = event.status === "completed" ? "completed"
      : event.status === "waiting_for_info" ? "waiting_for_user"
      : event.status === "waiting_approval" ? "waiting_for_user"
      : "in_progress";
    await setWorkspace(client, projectId, status, event.status === "completed" ? "Complete" : phaseForStep(event.step));
  });
}
