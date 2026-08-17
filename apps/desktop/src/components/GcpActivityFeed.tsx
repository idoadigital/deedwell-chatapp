import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { GcpActivity, GcpActivityTask, GcpResearchSources, Organization } from "../types";
import { Icon } from "./Icon";
import { openExternal } from "../external";

/**
 * Observable execution for grant-platform work (integration spec §6–§9).
 *
 * Everything rendered here is persisted backend state — task rows and
 * task_events written by the workers as they actually run. Nothing is timed,
 * simulated, or animated to look busy: a spinner means the platform reports
 * the task queued/running right now; a check means the event happened.
 */

const TASK_TITLES: Record<string, string> = {
  research: "Grant research",
  requirements_analysis: "Requirements analysis",
  strategy_generation: "Strategy generation",
  section_drafting: "Section drafting",
  section_revision: "Section revision",
  budget_narrative: "Budget narrative",
  compliance_explanation: "Compliance review",
  document_ingestion: "Document ingestion",
  document_generation: "Application package",
  verification: "Eligibility verification",
};

/** Small, human counters worth surfacing from event metadata. */
const META_LABELS: Record<string, string> = {
  unique_sources: "sources",
  primary_sources: "primary",
  search_passes: "passes",
  message_count: "messages",
  fact_count: "facts",
  opportunity_count: "opportunities",
  requirement_count: "requirements",
  section_count: "sections",
};

function metaChips(meta: Record<string, unknown>): string {
  return Object.entries(META_LABELS)
    .filter(([k]) => typeof meta[k] === "number")
    .map(([k, label]) => `${meta[k]} ${label}`)
    .join(" · ");
}

function elapsed(ms: number | null): string {
  if (ms == null || ms < 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const running = (t: GcpActivityTask) => t.status === "queued" || t.status === "running";

function TaskCard({ task, dev }: { task: GcpActivityTask; dev: boolean }) {
  const [open, setOpen] = useState(running(task) || task.status === "failed");
  const title = task.title || TASK_TITLES[task.task_type] || task.task_type.replace(/_/g, " ");
  const retried = (task.attempts ?? 1) > 1;
  return (
    <div className="ws-source" style={{ display: "block", marginBottom: 8 }}>
      <button className="ghost" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "4px 2px" }}
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {running(task)
          ? <span className="presence working" style={{ position: "static" }} aria-label="Running" />
          : task.status === "failed"
            ? <span aria-label="Failed" style={{ color: "var(--danger, #b3261e)", fontWeight: 700 }}>✕</span>
            : <span aria-label="Completed" style={{ color: "var(--ok, #1f7a45)", fontWeight: 700 }}>✓</span>}
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          {title}
          {retried && <span className="pill warn" style={{ marginLeft: 6 }}>attempt {task.attempts}</span>}
        </span>
        <span className="faint" style={{ fontSize: 11 }}>
          {running(task) ? `running · ${elapsed(task.elapsed_ms)}` : elapsed(task.elapsed_ms)}
        </span>
      </button>
      {task.progress && running(task) && <div className="faint" style={{ fontSize: 12, marginLeft: 22 }}>{task.progress}</div>}
      {task.status === "failed" && (
        <div className="error-text" style={{ fontSize: 12, marginLeft: 22 }}>
          {task.failure_message || task.failure_code || "This task failed."} Your progress is saved — ask the teammate to retry.
        </div>
      )}
      {open && (
        <ol style={{ listStyle: "none", margin: "6px 0 2px", padding: 0 }}>
          {task.events.map((e) => {
            const failed = /fail|unreachable|stale/.test(e.event_type);
            const chips = metaChips(e.metadata);
            return (
              <li key={e.event_id} style={{ display: "flex", gap: 8, padding: "3px 0 3px 6px", fontSize: 12 }}>
                <span aria-hidden="true" style={{ color: failed ? "var(--danger, #b3261e)" : "var(--ok, #1f7a45)", width: 14 }}>
                  {failed ? "⚠" : "✓"}
                </span>
                <span style={{ flex: 1 }}>
                  {e.label}
                  {e.message && e.message !== e.label ? <span className="faint"> — {e.message}</span> : null}
                  {chips ? <span className="faint"> ({chips})</span> : null}
                </span>
                <span className="faint">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </li>
            );
          })}
          {running(task) && (
            <li style={{ display: "flex", gap: 8, padding: "3px 0 3px 6px", fontSize: 12 }}>
              <span className="presence working" style={{ position: "static", width: 10, height: 10 }} aria-hidden="true" />
              <span className="faint">working…</span>
            </li>
          )}
        </ol>
      )}
      {task.result_summary && !running(task) && (
        <div style={{ fontSize: 12, marginLeft: 22, marginTop: 2 }}>{task.result_summary}</div>
      )}
      {dev && (
        <div className="faint" style={{ fontSize: 10, marginLeft: 22, marginTop: 4, wordBreak: "break-all" }}>
          task {task.task_id} · {task.task_type} · {task.service ?? "api"} · runs {task.run_count ?? 1}
        </div>
      )}
    </div>
  );
}

export function GcpActivityFeed({ org, channelId, refreshTick }: {
  org: Organization; channelId: string; refreshTick: number;
}) {
  const [activity, setActivity] = useState<GcpActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const dev = useMemo(() => {
    try { return localStorage.getItem("deedwell.devmode") === "1"; } catch { return false; }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getGcpActivity(org.id, channelId)
      .then((a) => { if (!cancelled) { setActivity(a); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load activity"); });
    return () => { cancelled = true; };
  }, [org.id, channelId, refreshTick, tick]);

  // Poll only while the platform reports work in flight — no idle chatter.
  useEffect(() => {
    if (!activity || activity.counts.running === 0) return;
    const id = setTimeout(() => setTick((t) => t + 1), 5000);
    return () => clearTimeout(id);
  }, [activity, tick]);

  if (error) return <p className="error-text" style={{ padding: 4 }}>{error}</p>;
  if (!activity) return <p className="faint" style={{ padding: 4 }}>Loading activity…</p>;
  if (!activity.tasks.length) {
    return <p className="faint" style={{ padding: 4 }}>
      No platform work in this conversation yet — ask the team to research grants, and every step will appear here.
    </p>;
  }
  return (
    <div>
      {activity.counts.running > 0 && (
        <p className="faint" style={{ fontSize: 12, margin: "0 0 6px" }}>
          {activity.counts.running} task{activity.counts.running > 1 ? "s" : ""} running — this updates live; you can
          leave and come back without losing anything.
        </p>
      )}
      {activity.tasks.map((t) => <TaskCard key={t.task_id} task={t} dev={dev} />)}
    </div>
  );
}

export function GcpSources({ org, channelId, refreshTick }: {
  org: Organization; channelId: string; refreshTick: number;
}) {
  const [sources, setSources] = useState<GcpResearchSources | null>(null);
  const [state, setState] = useState<"loading" | "none" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activity = await api.getGcpActivity(org.id, channelId);
        const research = activity.tasks.find((t) => t.task_type === "research" && t.status === "completed");
        if (!research) { if (!cancelled) setState("none"); return; }
        const result = await api.getGcpResearchResult(org.id, research.task_id);
        if (!cancelled) { setSources(result); setState("ready"); }
      } catch { if (!cancelled) setState("error"); }
    })();
    return () => { cancelled = true; };
  }, [org.id, channelId, refreshTick]);

  if (state === "loading") return <p className="faint" style={{ padding: 4 }}>Loading sources…</p>;
  if (state === "error") return <p className="error-text" style={{ padding: 4 }}>Couldn't load research sources.</p>;
  if (state === "none" || !sources) {
    return <p className="faint" style={{ padding: 4 }}>Sources appear here once a research run completes.</p>;
  }
  return (
    <div>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 6px" }}>
        {sources.sources.length} source{sources.sources.length === 1 ? "" : "s"} behind the latest research — every
        conclusion traces back to one of these.
      </p>
      {sources.sources.map((s, i) => (
        <div key={s.id ?? i} className="ws-source row">
          <Icon name="link" size={13} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.title || s.domain || "Untitled source"}
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              {s.domain ?? ""}{s.quality ? ` · ${s.quality}` : ""}
            </div>
          </div>
          {s.url && (
            <button className="ghost" onClick={() => openExternal(s.url!)}>Open</button>
          )}
        </div>
      ))}
      {sources.web_search_queries.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>
            Search queries used ({sources.web_search_queries.length})
          </summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {sources.web_search_queries.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Right-panel workspace for grant-team DMs, where no project exists yet:
 *  the live Activity feed plus research Sources. */
export function GcpDmPanel({ org, channelId, refreshTick }: {
  org: Organization; channelId: string; refreshTick: number;
}) {
  const [tab, setTab] = useState<"activity" | "sources">("activity");
  return (
    <div className="ws-panel">
      <div className="ws-tabs" role="tablist" aria-label="Grant activity sections">
        {(["activity", "sources"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={`ws-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {k === "activity" ? "Activity" : "Sources"}
          </button>
        ))}
      </div>
      <div className="ws-body">
        {tab === "activity" && <GcpActivityFeed org={org} channelId={channelId} refreshTick={refreshTick} />}
        {tab === "sources" && <GcpSources org={org} channelId={channelId} refreshTick={refreshTick} />}
      </div>
    </div>
  );
}
