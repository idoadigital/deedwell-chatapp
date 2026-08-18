import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { FactConflict, GrantWorkspace, Organization, RunDetail, TeammateInfo } from "../types";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { ArtifactPanel } from "./ArtifactPanel";
import { PreviewSurface } from "./PreviewSurface";
import { InfoFieldInput, hasAnswer, type FieldValue } from "./InfoFieldInput";
import { GcpActivityFeed, GcpSources } from "./GcpActivityFeed";
import { openExternal } from "../external";

/**
 * The grant application workspace inside the existing artifact panel
 * (workspace spec §2–§3): Overview, verified Activity timeline, Research
 * provenance, Requirements matrix, open Questions, Documents, and the
 * Application artifacts themselves. Everything shown is read from persisted
 * state — nothing here is simulated or animated to look busy.
 */

type Tab = "overview" | "preview" | "activity" | "research" | "requirements" | "questions" | "documents" | "evidence" | "application"
  | "strategy" | "sections" | "budget" | "compliance" | "package";

/** Viewport widths for the preview device toggle. null = fill the panel. */
const DEVICE_WIDTHS: Record<string, number | null> = { mobile: 390, tablet: 834, desktop: null };

const STATUS_LABEL: Record<string, string> = {
  created: "Created",
  waiting_for_document: "Waiting for a document",
  researching: "Researching",
  waiting_for_user: "Waiting on you",
  blocked: "Needs attention",
  completed: "Complete",
};

export function GrantWorkspacePanel({
  org, projectId, channelId, refreshTick, refresh, runDetail, teammates, projectType = "grant_application",
  autoPreviewDeliverableId, onAutoPreviewConsumed,
}: {
  org: Organization;
  projectId: string;
  channelId: string;
  refreshTick: number;
  refresh: () => void;
  runDetail: RunDetail | null;
  teammates: Map<string, TeammateInfo>;
  projectType?: string;
  /** Set by a "View" click on a deliverable card in chat: land on Package and open this document. */
  autoPreviewDeliverableId?: string | null;
  onAutoPreviewConsumed?: () => void;
}) {
  const [ws, setWs] = useState<GrantWorkspace | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.getGrantWorkspace(org.id, projectId)
      .then((data) => { if (!cancelled) { setWs(data); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load workspace"); });
    return () => { cancelled = true; };
  }, [org.id, projectId, refreshTick]);

  const refreshConflicts = () => {
    api.listFactConflicts(org.id).then((data) => setConflicts(data.conflicts)).catch(() => undefined);
  };
  useEffect(refreshConflicts, [org.id, refreshTick]);

  // Land on the most useful tab: a deliverable to view beats an open
  // question beats the default overview.
  useEffect(() => {
    if (autoPreviewDeliverableId) { setTab("package"); return; }
    if (ws?.questions.length) setTab((t) => (t === "overview" ? "questions" : t));
  }, [ws?.questions.length, autoPreviewDeliverableId]);

  // When a build finishes, show the result. Only on an actual version bump —
  // landing here on every refresh would fight the user's own tab choice.
  const seenPreview = useRef<number | null>(null);
  const previewVersion = ws?.site?.preview_version ?? null;
  useEffect(() => {
    if (previewVersion === null) return;
    const prev = seenPreview.current;
    seenPreview.current = previewVersion;
    if (prev !== null && previewVersion > prev && !ws?.questions.length) setTab("preview");
  }, [previewVersion, ws?.questions.length]);

  if (error) return <p className="error-text" style={{ padding: 16 }}>{error}</p>;
  if (!ws) return <p className="faint" style={{ padding: 16 }}>Loading workspace…</p>;

  const isGrant = projectType === "grant_application";
  const gcp = ws.gcp ?? null;
  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: "overview", label: "Overview" },
    // The site itself, right next to the work that produced it.
    ...(!isGrant && ws.site ? [
      { key: "preview" as Tab, label: "Preview", badge: ws.site.preview_version ?? undefined },
    ] : []),
    { key: "activity", label: "Activity", badge: ws.events.length },
    // Research and the requirements matrix are grant-workflow records;
    // website projects surface their QA in the test-report artifact instead.
    ...(isGrant ? [
      // Platform-backed workspaces show live research provenance as Sources;
      // local grant workflows keep their original Research records view.
      { key: "research" as Tab, label: gcp ? "Sources" : "Research", badge: gcp ? undefined : ws.sources.length },
      { key: "requirements" as Tab, label: "Requirements", badge: ws.requirements.length },
    ] : []),
    { key: "questions", label: "Questions", badge: ws.questions.length },
    { key: "documents", label: "Documents", badge: ws.files.length },
    ...(isGrant ? [{ key: "evidence" as Tab, label: "Evidence", badge: conflicts.length }] : []),
    // Platform-backed applications expose the real persisted work products.
    ...(gcp ? [
      { key: "strategy" as Tab, label: "Strategy", badge: gcp.strategy ? 1 : 0 },
      { key: "sections" as Tab, label: "Sections", badge: gcp.sections?.progress.total ?? 0 },
      { key: "budget" as Tab, label: "Budget", badge: gcp.budget ? 1 : 0 },
      { key: "compliance" as Tab, label: "Compliance", badge: gcp.compliance?.hard_blocker_count ?? 0 },
      { key: "package" as Tab, label: "Package", badge: gcp.deliverables.length },
    ] : [
      { key: "application" as Tab, label: isGrant ? "Application" : "Artifacts", badge: ws.artifacts.length },
    ]),
  ];

  return (
    <div className="ws-panel">
      <div className="ws-tabs" role="tablist" aria-label="Workspace sections">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            className={`ws-tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}{t.badge ? <span className="ws-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="ws-body">
        {tab === "overview" && (gcp?.application ? <GcpOverview ws={ws} /> : <Overview ws={ws} />)}
        {tab === "preview" && ws.site && <SitePreview site={ws.site} />}
        {tab === "activity" && (gcp
          ? <GcpActivityFeed org={org} channelId={channelId} refreshTick={refreshTick} />
          : <Activity ws={ws} teammates={teammates} />)}
        {tab === "research" && (gcp
          ? <GcpSources org={org} channelId={channelId} refreshTick={refreshTick} />
          : <Research ws={ws} />)}
        {tab === "requirements" && <Requirements ws={ws} />}
        {tab === "questions" && (
          <Questions ws={ws} allowSkip={ws.allowSkip} onSubmit={async (facts) => {
            // Same durable state either way: platform questions answer through
            // the platform endpoint; local workflows through provide-info,
            // which keeps the typed value intact rather than flattening it
            // into a line of text the server has to parse back.
            if (gcp) {
              for (const f of facts) {
                await api.answerGcpQuestion(org.id, projectId, f.key, String(f.value));
              }
            } else if (ws.run) {
              await api.provideInfo(org.id, ws.run.id, facts);
            }
            refresh();
          }} />
        )}
        {tab === "documents" && isGrant && (
          <div>
            <Documents ws={ws} />
            <LibraryPicker org={org} projectId={projectId} onAttached={refresh} />
          </div>
        )}
        {tab === "documents" && !isGrant && <Documents ws={ws} />}
        {tab === "evidence" && (
          <EvidenceConflicts
            org={org}
            conflicts={conflicts}
            onResolved={refreshConflicts}
          />
        )}
        {tab === "strategy" && gcp && <GcpStrategy gcp={gcp} />}
        {tab === "sections" && gcp && <GcpSections gcp={gcp} />}
        {tab === "budget" && gcp && <GcpBudget gcp={gcp} />}
        {tab === "compliance" && gcp && <GcpCompliance gcp={gcp} />}
        {tab === "package" && gcp && (
          <GcpPackage org={org} gcp={gcp}
            autoPreviewDeliverableId={autoPreviewDeliverableId} onAutoPreviewConsumed={onAutoPreviewConsumed} />
        )}
        {tab === "application" && (
          ws.artifacts.length || runDetail
            ? <ArtifactPanel org={org} detail={runDetail} />
            : <p className="faint">No application documents yet — they appear here as the team drafts them.</p>
        )}
      </div>
    </div>
  );
}

function Overview({ ws }: { ws: GrantWorkspace }) {
  const p = ws.project;
  const failed = ws.events.find((e) => e.status === "failed");
  const site = ws.site;
  // A website project has no funding announcement to upload and no package to
  // download; telling someone to do either is worse than saying nothing.
  const nextAction = ws.questions.length
    ? `Answer ${ws.questions.length} open question${ws.questions.length > 1 ? "s" : ""} in the Questions tab.`
    : site
      ? ws.run?.status === "waiting_approval"
        ? "A decision is waiting for you in the channel — review the preview first."
        : ws.run && !["completed", "cancelled"].includes(ws.run.status)
          ? "The team is building — follow along in the Activity tab."
          : site.preview_version && !site.live_version
            ? "Review the preview, then approve it in the channel to go live."
            : site.live_version
              ? "The site is live. Ask for any change in the channel."
              : "Say what you'd like the site to say in the channel."
      : p.pending_intent
        ? "Upload the funding announcement in the channel — the application resumes automatically."
        : ws.run?.status === "waiting_approval"
          ? "A decision is waiting for you in the channel."
          : ws.run && !["completed", "cancelled"].includes(ws.run.status)
            ? "The team is working — follow the Activity tab."
            : ws.run?.status === "completed"
              ? "Review and download the package in the Application tab."
              : "Say what you'd like to do next in the channel.";
  return (
    <div>
      <h3 className="ws-title">{p.grant_title ?? p.name}</h3>
      <dl className="ws-facts">
        {site && <><dt>Address</dt><dd>{site.slug}</dd></>}
        {site?.preview_version && <><dt>Preview</dt><dd>v{site.preview_version}</dd></>}
        {site?.live_version && <><dt>Live</dt><dd>v{site.live_version}</dd></>}
        {p.funder && <><dt>Agency</dt><dd>{p.funder}</dd></>}
        {p.opportunity_number && <><dt>Opportunity</dt><dd>{p.opportunity_number}</dd></>}
        {p.deadline && <><dt>Deadline</dt><dd>{p.deadline}</dd></>}
        <dt>Status</dt><dd>{STATUS_LABEL[p.workspace_status] ?? p.workspace_status}</dd>
        {p.workspace_phase && <><dt>Phase</dt><dd>{p.workspace_phase}</dd></>}
        {ws.eligibility && <><dt>Eligibility</dt><dd>{ws.eligibility.overall.replace(/_/g, " ")}</dd></>}
      </dl>
      <div className="ws-progress" role="progressbar" aria-valuenow={ws.completion} aria-valuemin={0} aria-valuemax={100}
        aria-label="Workflow steps completed">
        <span style={{ width: `${ws.completion}%` }} />
      </div>
      <p className="faint" style={{ marginTop: 4 }}>
        {ws.completion}% of workflow steps completed{ws.requirements.length ? ` · ${ws.requirements.length} requirements tracked` : ""}
      </p>
      {failed && (
        <div className="ws-alert" role="alert">
          <Icon name="alert" size={14} /> {failed.title}{failed.error ? ` — ${failed.error}` : ""}
        </div>
      )}
      <div className="ws-next">
        <strong>Next:</strong> {nextAction}
      </div>
      {p.source_url && (
        <p style={{ marginTop: 10 }}>
          <a href={p.source_url} onClick={(e) => { e.preventDefault(); void openExternal(p.source_url!); }}>
            Official opportunity page ↗
          </a>
        </p>
      )}
    </div>
  );
}

function Activity({ ws, teammates }: { ws: GrantWorkspace; teammates: Map<string, TeammateInfo> }) {
  if (!ws.events.length) return <p className="faint">No activity yet.</p>;
  return (
    <ol className="ws-timeline">
      {ws.events.map((e) => (
        <li key={e.id} className={`ws-event ${e.status}`}>
          <span className={`ws-dot ${e.status}`} aria-hidden="true" />
          <div>
            <div className="ws-event-head">
              {e.agent_key && (
                <Avatar id={e.agent_key} name={teammates.get(e.agent_key)?.name ?? e.agent_key} size={18} />
              )}
              <strong>{e.title}</strong>
              <span className="faint">
                {new Date(e.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {e.summary && <p className="ws-event-sum">{e.summary}</p>}
            {(e.metadata as { url?: string } | null)?.url && (
              <p className="faint" style={{ margin: "2px 0 0" }}>
                <a href={(e.metadata as { url: string }).url}
                  onClick={(ev) => { ev.preventDefault(); void openExternal((e.metadata as { url: string }).url); }}>
                  {(e.metadata as { url: string }).url.slice(0, 80)} ↗
                </a>
              </p>
            )}
            {e.error && <p className="error-text">{e.error}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Research({ ws }: { ws: GrantWorkspace }) {
  if (!ws.sources.length) return <p className="faint">No sources retrieved yet. Every retrieval — successful or failed — is recorded here with its URL and timestamp.</p>;
  return (
    <div>
      {ws.sources.map((s) => (
        <div key={s.id} className="ws-source">
          <div className="ws-event-head">
            <span className={`pill ${s.fetch_status === "retrieved" ? "green" : "red"}`}>
              {s.fetch_status === "retrieved" ? "retrieved" : "failed"}
            </span>
            <strong>{s.title}</strong>
          </div>
          <p className="faint">
            {s.publisher ? `${s.publisher} · ` : ""}{s.reliability.replace(/_/g, " ").toLowerCase()} ·{" "}
            {new Date(s.retrieved_at).toLocaleString()}
            {s.url && <> · <a href={s.url} onClick={(e) => { e.preventDefault(); void openExternal(s.url!); }}>source ↗</a></>}
          </p>
          {s.excerpt && <blockquote className="ws-excerpt">{s.excerpt.slice(0, 300)}{s.excerpt.length > 300 ? "…" : ""}</blockquote>}
        </div>
      ))}
    </div>
  );
}

function Requirements({ ws }: { ws: GrantWorkspace }) {
  if (!ws.requirements.length) {
    return <p className="faint">The compliance matrix appears here once the announcement has been analyzed.</p>;
  }
  return (
    <div>
      {ws.eligibility && (
        <p style={{ marginBottom: 10 }}>
          Eligibility: <strong>{ws.eligibility.overall.replace(/_/g, " ")}</strong>
          {ws.eligibility.missing_facts.length > 0 && ` · ${ws.eligibility.missing_facts.length} fact(s) still needed`}
        </p>
      )}
      {ws.requirements.map((r, i) => (
        <div key={i} className="ws-req">
          <span className={`pill ${r.status ? (r.status === "COMPLETE" ? "green" : r.status === "BLOCKED" ? "red" : "blue") : r.mandatory ? "red" : "blue"}`}>
            {r.status ? r.status.replace(/_/g, " ").toLowerCase() : r.mandatory ? "mandatory" : "optional"}
          </span>
          <div>
            <div style={{ fontSize: 13 }}>{r.text ?? r.key}</div>
            {r.wordLimit ? <div className="faint">Limit: {r.wordLimit} words</div> : null}
            {r.statusReason && <div className="faint">{String(r.statusReason).slice(0, 140)}</div>}
            {r.sourceLine && <div className="faint">Funder's words: “{String(r.sourceLine).slice(0, 120)}”</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Questions({ ws, allowSkip, onSubmit }: {
  ws: GrantWorkspace;
  allowSkip?: boolean;
  onSubmit: (facts: Array<{ key: string; value: FieldValue }>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (!ws.questions.length) {
    return <p className="faint">Nothing is needed from you right now. When the team hits a fact it can't verify, a focused form appears here — only for genuinely missing information.</p>;
  }
  if (sent) return <p className="faint">Answers sent — the team resumed automatically.</p>;

  const answered = ws.questions
    .map((q) => ({ q, v: values[q.key] ?? (q.prefill ?? undefined) }))
    .filter(({ v }) => hasAnswer(v));

  const post = async (facts: Array<{ key: string; value: FieldValue }>) => {
    setBusy(true);
    try { await onSubmit(facts); setSent(true); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (answered.length) await post(answered.map(({ q, v }) => ({ key: q.key, value: v! })));
    }}>
      <p className="faint" style={{ marginBottom: 10 }}>
        {allowSkip
          ? "None of these are required — answer what you care about and the team will choose the rest."
          : "These are the only facts the team could not verify. Known values are prefilled — confirm or edit. Partial answers are fine."}
      </p>
      {ws.questions.map((q) => (
        <div className="field" key={q.key} style={{ marginBottom: 10 }}>
          <label htmlFor={`wsq-${q.key}`}>{q.label}</label>
          <InfoFieldInput
            field={q}
            id={`wsq-${q.key}`}
            value={values[q.key] ?? (q.prefill ?? undefined)}
            onChange={(v) => setValues((prev) => ({ ...prev, [q.key]: v }))}
          />
          {q.help && <p className="faint" style={{ marginTop: 2 }}>{q.help}</p>}
          <p className="faint" style={{ marginTop: 2 }}>{q.reasonNeeded}</p>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="primary" disabled={busy || !answered.length}>Send answers</button>
        {allowSkip && (
          <button type="button" className="ghost" disabled={busy}
            onClick={() => void post([{ key: "site_intake_skipped", value: true }])}>
            Let the team decide
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The site as it actually renders, inside the panel.
 *
 * Preview is the default when it is ahead of live: after asking for a change
 * you want to see the change, not the version that was published last week.
 */
function SitePreview({ site }: { site: NonNullable<GrantWorkspace["site"]> }) {
  const previewAhead = (site.preview_version ?? 0) > (site.live_version ?? 0);
  const [mode, setMode] = useState<"preview" | "live">(
    previewAhead || !site.live_version ? "preview" : "live"
  );
  const [device, setDevice] = useState<keyof typeof DEVICE_WIDTHS>("desktop");
  const version = mode === "preview" ? site.preview_version : site.live_version;

  if (!site.preview_version && !site.live_version) {
    return <p className="faint">Nothing built yet — the first preview appears here as soon as the team finishes a release.</p>;
  }

  return (
    <PreviewSurface
      url={api.siteUrl(site.slug, mode)}
      reloadKey={`${mode}:${version ?? 0}`}
      frameWidth={DEVICE_WIDTHS[device] ?? null}
      toolbarExtra={
        <div className="device-toggle">
          {site.live_version ? (
            <>
              <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
                Preview{site.preview_version ? ` v${site.preview_version}` : ""}
              </button>
              <button className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>
                Live v{site.live_version}
              </button>
              <span className="device-sep" />
            </>
          ) : null}
          {(["mobile", "tablet", "desktop"] as const).map((d) => (
            <button key={d} className={device === d ? "active" : ""} onClick={() => setDevice(d)} title={d}>
              {d === "mobile" ? "Phone" : d === "tablet" ? "Tablet" : "Desktop"}
            </button>
          ))}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Platform-backed application views. Everything below renders persisted state
// the grant platform returned — readiness, verdicts, and counts are never
// computed or animated client-side.
// ---------------------------------------------------------------------------

function pillFor(status: string): string {
  const s = status.toUpperCase();
  if (["APPROVED", "COMPLETE", "COMPLETED", "VALID", "READY_FOR_SUBMISSION", "PASS", "PASSED"].includes(s)) return "green";
  if (["FAILED", "INVALID", "BLOCKED", "NOT_READY", "REJECTED", "FAIL", "QUARANTINED"].includes(s)) return "red";
  return "blue";
}

function GcpOverview({ ws }: { ws: GrantWorkspace }) {
  const gcp = ws.gcp!;
  const app = gcp.application!;
  const r = gcp.readiness ?? {};
  const p = gcp.sections?.progress;
  const running = gcp.activity.counts.running ?? 0;
  const nextAction = running > 0
    ? "The team is working — follow the Activity tab."
    : ws.questions.length
      ? `Answer ${ws.questions.length} open question${ws.questions.length > 1 ? "s" : ""} in the Questions tab.`
      : gcp.compliance?.result === "READY_FOR_SUBMISSION"
        ? "Ready for submission — generate or download the package in the Package tab."
        : gcp.compliance
          ? `${gcp.compliance.hard_blocker_count} blocker${gcp.compliance.hard_blocker_count === 1 ? "" : "s"} to resolve — see the Compliance tab.`
          : "Ask in the channel what the team needs, or say \"are we ready to submit?\".";
  return (
    <div>
      <h3 className="ws-title">{app.funder} — {app.program_name}</h3>
      <dl className="ws-facts">
        <dt>Status</dt><dd><span className={`pill ${pillFor(app.status)}`}>{app.status.replace(/_/g, " ").toLowerCase()}</span></dd>
        {app.deadline_text && <><dt>Deadline</dt><dd>{app.deadline_text}</dd></>}
        {app.grant_opportunity?.mission_fit_score != null && (
          <><dt>Mission fit</dt><dd>{app.grant_opportunity.mission_fit_score}</dd></>
        )}
        {app.grant_opportunity?.recommendation && (
          <><dt>Recommendation</dt><dd>{app.grant_opportunity.recommendation}</dd></>
        )}
        {typeof r.total === "number" && <><dt>Requirements</dt><dd>{r.complete}/{r.total} complete</dd></>}
        {p && <><dt>Sections</dt><dd>{p.approved}/{p.total} approved</dd></>}
        {gcp.budget && (
          <><dt>Budget</dt><dd>v{gcp.budget.version} · {(gcp.budget.validation_status ?? gcp.budget.status).toLowerCase()}</dd></>
        )}
        {gcp.compliance && (
          <><dt>Compliance</dt><dd>
            <span className={`pill ${pillFor(gcp.compliance.result)}`}>{gcp.compliance.result.replace(/_/g, " ").toLowerCase()}</span>
          </dd></>
        )}
        <dt>Evidence</dt><dd>{gcp.evidenceCount} organization fact{gcp.evidenceCount === 1 ? "" : "s"} on file</dd>
      </dl>
      {typeof r.percent_complete === "number" && (
        <>
          <div className="ws-progress" role="progressbar" aria-valuenow={r.percent_complete} aria-valuemin={0} aria-valuemax={100}
            aria-label="Requirements complete">
            <span style={{ width: `${r.percent_complete}%` }} />
          </div>
          <p className="faint" style={{ marginTop: 4 }}>{r.percent_complete}% of the funder's requirements complete</p>
        </>
      )}
      <div className="ws-next"><strong>Next:</strong> {nextAction}</div>
      {app.official_url && (
        <p style={{ marginTop: 10 }}>
          <a href={app.official_url} onClick={(e) => { e.preventDefault(); void openExternal(app.official_url!); }}>
            Funder's official page ↗
          </a>
        </p>
      )}
    </div>
  );
}

function GcpStrategy({ gcp }: { gcp: NonNullable<GrantWorkspace["gcp"]> }) {
  const s = gcp.strategy;
  if (!s) return <p className="faint">No strategy yet — ask Amara to "draft the application strategy" in the channel.</p>;
  const list = (items: unknown[] | undefined, empty: string) =>
    items?.length ? <ul className="ws-list">{items.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>)}</ul>
      : <p className="faint">{empty}</p>;
  return (
    <div>
      <p style={{ marginBottom: 8 }}>
        <span className={`pill ${pillFor(s.status)}`}>{s.status.toLowerCase()}</span>{" "}
        <span className="faint">version {s.version}{gcp.strategyApprovedVersion ? ` · v${gcp.strategyApprovedVersion} approved` : ""}</span>
      </p>
      {s.positioning && <><h4 className="ws-h4">Positioning</h4><p className="ws-text">{s.positioning}</p></>}
      {s.recommended_project && <><h4 className="ws-h4">Recommended project</h4><p className="ws-text">{s.recommended_project}</p></>}
      <h4 className="ws-h4">Funder priorities</h4>{list(s.funder_priorities, "None recorded.")}
      <h4 className="ws-h4">Narrative themes</h4>{list(s.narrative_themes, "None recorded.")}
      <h4 className="ws-h4">Strongest evidence</h4>{list(s.strongest_evidence, "None recorded.")}
      <h4 className="ws-h4">Weaknesses &amp; risks</h4>{list([...(s.weaknesses ?? []), ...(s.risks ?? [])], "None recorded.")}
      <h4 className="ws-h4">Evidence gaps ({s.evidence_gaps?.length ?? 0})</h4>
      {list((s.evidence_gaps ?? []).map((g) => (g as { description?: string; gap?: string }).description ?? (g as { gap?: string }).gap ?? JSON.stringify(g)),
        "No gaps named — that means the evidence held up, not that nobody looked.")}
      <p className="faint" style={{ marginTop: 10 }}>
        To change it, tell Amara in the channel — e.g. "make the strategy focus more strongly on sustainability", then "approve the strategy".
      </p>
    </div>
  );
}

function GcpSections({ gcp }: { gcp: NonNullable<GrantWorkspace["gcp"]> }) {
  const sec = gcp.sections;
  if (!sec?.sections.length) {
    return <p className="faint">No sections yet — once the strategy is approved, ask Sophia to "draft the application" in the channel.</p>;
  }
  const p = sec.progress;
  return (
    <div>
      <p className="faint" style={{ marginBottom: 10 }}>
        {p.approved}/{p.total} approved · {p.draft} in draft · {p.not_started} not started
        {p.total_blockers ? ` · ${p.total_blockers} blocker${p.total_blockers === 1 ? "" : "s"}` : ""}
      </p>
      {sec.sections.map((s, i) => (
        <details key={s.section_id} className="ws-source">
          <summary style={{ cursor: "pointer" }}>
            <span className={`pill ${pillFor(s.status)}`}>{s.status.replace(/_/g, " ").toLowerCase()}</span>{" "}
            <strong>{i + 1}. {s.section_title}</strong>
            <span className="faint"> · rev {s.current_revision_number}{s.word_limit ? ` · max ${s.word_limit} words` : ""}</span>
          </summary>
          {s.question_text && <p className="faint" style={{ marginTop: 6 }}>{s.question_text}</p>}
          {(s.blockers?.length ?? 0) > 0 && (
            <p className="error-text">{(s.blockers as unknown[]).length} blocker(s) — evidence is missing for claims this section needs.</p>
          )}
          <p className="faint" style={{ marginTop: 4 }}>
            In the channel: "show me section {i + 1}", "rewrite section {i + 1} to …", "approve section {i + 1}".
          </p>
        </details>
      ))}
    </div>
  );
}

function GcpBudget({ gcp }: { gcp: NonNullable<GrantWorkspace["gcp"]> }) {
  const b = gcp.budget;
  if (!b) return <p className="faint">No budget yet — give Michael real figures in the channel; the platform refuses invented ones.</p>;
  const money = (n: number | null | undefined) =>
    n == null ? "—" : `${b.currency ?? "USD"} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  return (
    <div>
      <p style={{ marginBottom: 8 }}>
        <span className={`pill ${pillFor(b.validation_status ?? b.status)}`}>{(b.validation_status ?? b.status).toLowerCase()}</span>{" "}
        <span className="faint">version {b.version}</span>
      </p>
      <dl className="ws-facts">
        <dt>Requested</dt><dd>{money(b.requested_amount)}</dd>
        <dt>Total project cost</dt><dd>{money(b.total_project_cost)}</dd>
        <dt>Direct costs</dt><dd>{money(b.direct_costs)}</dd>
        <dt>Indirect costs</dt><dd>{money(b.indirect_costs)}{b.indirect_rate != null ? ` (${(b.indirect_rate * 100).toFixed(1)}%)` : ""}</dd>
        {b.funder_max_amount != null && <><dt>Funder ceiling</dt><dd>{money(b.funder_max_amount)}</dd></>}
      </dl>
      {(b.validation_errors?.length ?? 0) > 0 && (
        <div className="ws-alert" role="alert">
          {(b.validation_errors as unknown[]).map((e, i) => <div key={i}>{typeof e === "string" ? e : JSON.stringify(e)}</div>)}
        </div>
      )}
      {(b.lines?.length ?? 0) > 0 && (
        <>
          <h4 className="ws-h4">Line items</h4>
          {(b.lines ?? []).map((l, i) => {
            const line = l as { category?: string; description?: string; amount?: number };
            return (
              <div key={i} className="ws-req">
                <span className="pill blue">{String(line.category ?? "item").toLowerCase()}</span>
                <div style={{ fontSize: 13 }}>{line.description ?? ""} <span className="faint">· {money(line.amount)}</span></div>
              </div>
            );
          })}
        </>
      )}
      {b.narrative && <><h4 className="ws-h4">Budget narrative</h4><p className="ws-text">{b.narrative}</p></>}
    </div>
  );
}

function GcpCompliance({ gcp }: { gcp: NonNullable<GrantWorkspace["gcp"]> }) {
  const c = gcp.compliance;
  if (!c) return <p className="faint">Compliance hasn't been run yet — ask in the channel: "are we ready to submit?".</p>;
  const ready = c.result === "READY_FOR_SUBMISSION";
  const items = (c.checks?.length ? c.checks : [...(c.blockers ?? []), ...(c.warnings ?? [])]) as Array<Record<string, unknown>>;
  return (
    <div>
      <div className={ready ? "ws-next" : "ws-alert"} role={ready ? undefined : "alert"} style={{ marginBottom: 10 }}>
        <strong>{ready ? "READY FOR SUBMISSION" : `NOT READY — ${c.hard_blocker_count} blocker${c.hard_blocker_count === 1 ? "" : "s"}`}</strong>
        {typeof c.checks_passed === "number" && typeof c.checks_run === "number" && (
          <span className="faint"> · {c.checks_passed}/{c.checks_run} checks passed</span>
        )}
      </div>
      {items.map((chk, i) => {
        const result = String(chk.result ?? chk.severity ?? "");
        const passed = ["PASS", "PASSED", "OK"].includes(result.toUpperCase());
        const hard = ["HARD_BLOCKER", "FAIL", "FAILED", "BLOCKER"].includes(result.toUpperCase());
        return (
          <div key={i} className="ws-req">
            <span className={`pill ${passed ? "green" : hard ? "red" : "blue"}`}>{passed ? "✓" : hard ? "✕" : "!"}</span>
            <div>
              <div style={{ fontSize: 13 }}>{String(chk.label ?? chk.title ?? chk.check_key ?? chk.code ?? "check")}</div>
              {(chk.detail ?? chk.message) != null && <div className="faint">{String(chk.detail ?? chk.message).slice(0, 200)}</div>}
            </div>
          </div>
        );
      })}
      <p className="faint" style={{ marginTop: 8 }}>
        These checks are deterministic platform rules — the interface cannot override them. Checked {new Date(c.created_at).toLocaleString()}.
      </p>
    </div>
  );
}

function GcpPackage({ org, gcp, autoPreviewDeliverableId, onAutoPreviewConsumed }: {
  org: Organization; gcp: NonNullable<GrantWorkspace["gcp"]>;
  autoPreviewDeliverableId?: string | null; onAutoPreviewConsumed?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // In-panel preview: the PDF streams through the authenticated API into a
  // temporary blob URL — no public link to the file ever exists.
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  // Arriving here via a chat "View" click: open that exact document.
  useEffect(() => {
    if (!autoPreviewDeliverableId) return;
    const target = gcp.deliverables.find((d) => d.deliverable_id === autoPreviewDeliverableId);
    if (!target) return; // workspace hasn't loaded this deliverable yet — retry on next data tick
    if (target.format.toUpperCase() === "PDF") {
      setBusy(target.deliverable_id);
      api.previewGcpDeliverable(org.id, target.deliverable_id)
        .then((url) => setPreview({ id: target.deliverable_id, url }))
        .catch((e) => setErr(e instanceof Error ? e.message : "Preview failed"))
        .finally(() => setBusy(null));
    }
    onAutoPreviewConsumed?.();
  }, [autoPreviewDeliverableId, gcp.deliverables, org.id, onAutoPreviewConsumed]);

  if (!gcp.deliverables.length) {
    return <p className="faint">No generated documents yet — say "generate the final application package as Word and PDF" in the channel.</p>;
  }
  return (
    <div>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>
        {gcp.deliverables.length} document{gcp.deliverables.length === 1 ? "" : "s"} generated for this application.
      </p>
      {err && <p className="error-text">{err}</p>}
      {gcp.deliverables.map((d) => {
        const name = `application-v${d.version ?? 1}.${d.format.toLowerCase()}`;
        const isPdf = d.format.toUpperCase() === "PDF";
        return (
          <div key={d.deliverable_id}>
            <div className="ws-source row">
              <Icon name="file-text" size={14} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {d.deliverable_type.replace(/_/g, " ").toLowerCase()} · {d.format.toUpperCase()}
                  <span className={`pill ${pillFor(d.status)}`} style={{ marginLeft: 6 }}>{d.status.toLowerCase()}</span>
                </div>
                <div className="faint">
                  {d.size_bytes ? `${(d.size_bytes / 1024).toFixed(1)} KB · ` : ""}
                  {new Date(d.created_at).toLocaleString()}
                </div>
              </div>
              {isPdf && (
                <button className="ghost" disabled={busy === d.deliverable_id}
                  onClick={async () => {
                    if (preview?.id === d.deliverable_id) { setPreview(null); return; }
                    setBusy(d.deliverable_id); setErr(null);
                    try { setPreview({ id: d.deliverable_id, url: await api.previewGcpDeliverable(org.id, d.deliverable_id) }); }
                    catch (e) { setErr(e instanceof Error ? e.message : "Preview failed"); }
                    finally { setBusy(null); }
                  }}>
                  {preview?.id === d.deliverable_id ? "Hide" : "View"}
                </button>
              )}
              <button className="ghost" disabled={busy === d.deliverable_id}
                onClick={async () => {
                  setBusy(d.deliverable_id); setErr(null);
                  try { await api.downloadGcpDeliverable(org.id, d.deliverable_id, name); }
                  catch (e) { setErr(e instanceof Error ? e.message : "Download failed"); }
                  finally { setBusy(null); }
                }}>
                {busy === d.deliverable_id ? "Working…" : "Download"}
              </button>
            </div>
            {preview?.id === d.deliverable_id && (
              <object data={preview.url} type="application/pdf" aria-label="PDF preview"
                style={{ width: "100%", height: 480, border: "1px solid var(--line, #ddd)", borderRadius: 6, marginBottom: 8 }}>
                <p className="faint" style={{ padding: 8 }}>
                  This viewer can't display PDFs inline — use Download instead.
                </p>
              </object>
            )}
          </div>
        );
      })}
      <p className="faint" style={{ marginTop: 8 }}>Downloads are private and authenticated — there are no public links to these files.</p>
    </div>
  );
}

function EvidenceConflicts({
  org, conflicts, onResolved,
}: {
  org: Organization;
  conflicts: FactConflict[];
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (!conflicts.length) {
    return <p className="faint">No open conflicts. When two documents disagree on the same fact, it shows up here instead of one silently overwriting the other.</p>;
  }

  const resolve = async (conflictId: string, resolution: "keep_current" | "use_proposed") => {
    setBusy(conflictId);
    try {
      await api.resolveFactConflict(org.id, conflictId, resolution);
      onResolved();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {conflicts.map((c) => (
        <div key={c.id} className="ws-source row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{c.fact_key.replace(/_/g, " ")}</div>
          <div className="faint" style={{ margin: "4px 0 8px" }}>Two sources disagree on this fact — pick which one is right.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ghost"
              disabled={busy === c.id}
              onClick={() => resolve(c.id, "keep_current")}
            >
              Keep current: {c.current_value}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy === c.id}
              onClick={() => resolve(c.id, "use_proposed")}
            >
              Use new: {c.proposed_value}
            </button>
          </div>
          {c.proposed_source_quote && (
            <div className="faint" style={{ marginTop: 6 }}>&ldquo;{c.proposed_source_quote}&rdquo;</div>
          )}
        </div>
      ))}
    </div>
  );
}

function LibraryPicker({
  org, projectId, onAttached,
}: {
  org: Organization;
  projectId: string;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<api.LibraryFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api.listLibraryFiles(org.id, projectId).then((data) => setFiles(data.files)).catch(() => setFiles([]));
  };

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" className="ghost" onClick={() => { setOpen((v) => !v); if (!open) load(); }}>
        {open ? "Hide evidence library" : "Attach from evidence library…"}
      </button>
      {open && (
        files === null ? (
          <p className="faint" style={{ marginTop: 8 }}>Loading…</p>
        ) : files.length === 0 ? (
          <p className="faint" style={{ marginTop: 8 }}>Nothing else in the organization's evidence library yet — documents uploaded to other applications will show up here to reuse, instead of re-uploading.</p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {files.map((f) => (
              <div key={f.id} className="ws-source row">
                <Icon name="file-text" size={14} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{f.filename}</div>
                  <div className="faint">{f.mime} · {(f.size_bytes / 1024).toFixed(1)} KB</div>
                </div>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy === f.id}
                  onClick={async () => {
                    setBusy(f.id);
                    try {
                      await api.linkLibraryFile(org.id, projectId, f.id);
                      setFiles((prev) => prev?.filter((x) => x.id !== f.id) ?? null);
                      onAttached();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Attach
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function Documents({ ws }: { ws: GrantWorkspace }) {
  if (!ws.files.length) return <p className="faint">No documents yet — uploaded and retrieved files appear here.</p>;
  return (
    <div>
      {ws.files.map((f) => (
        <div key={f.id} className="ws-source row">
          <Icon name="file-text" size={14} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {f.filename}
              {f.ingestion_status && (
                <span className={`pill ${f.ingestion_status === "COMPLETE" ? "green" : f.ingestion_status === "FAILED" || f.ingestion_status === "QUARANTINED" ? "red" : "blue"}`}
                  style={{ marginLeft: 6 }}>
                  {f.ingestion_status.toLowerCase()}
                </span>
              )}
            </div>
            <div className="faint">
              {f.mime} · {(f.size_bytes / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleString()}
              {typeof f.fact_count === "number" && f.fact_count > 0 ? ` · ${f.fact_count} fact${f.fact_count === 1 ? "" : "s"} extracted` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
