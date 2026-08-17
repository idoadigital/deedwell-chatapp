import { useEffect, useState } from "react";
import * as api from "../api";
import type { GrantWorkspace, Organization, RunDetail, TeammateInfo } from "../types";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { ArtifactPanel } from "./ArtifactPanel";
import { openExternal } from "../external";

/**
 * The grant application workspace inside the existing artifact panel
 * (workspace spec §2–§3): Overview, verified Activity timeline, Research
 * provenance, Requirements matrix, open Questions, Documents, and the
 * Application artifacts themselves. Everything shown is read from persisted
 * state — nothing here is simulated or animated to look busy.
 */

type Tab = "overview" | "activity" | "research" | "requirements" | "questions" | "documents" | "application";

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
}: {
  org: Organization;
  projectId: string;
  channelId: string;
  refreshTick: number;
  refresh: () => void;
  runDetail: RunDetail | null;
  teammates: Map<string, TeammateInfo>;
  projectType?: string;
}) {
  const [ws, setWs] = useState<GrantWorkspace | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getGrantWorkspace(org.id, projectId)
      .then((data) => { if (!cancelled) { setWs(data); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load workspace"); });
    return () => { cancelled = true; };
  }, [org.id, projectId, refreshTick]);

  // Land on the most useful tab: open questions first, else overview.
  useEffect(() => {
    if (ws?.questions.length) setTab((t) => (t === "overview" ? "questions" : t));
  }, [ws?.questions.length]);

  if (error) return <p className="error-text" style={{ padding: 16 }}>{error}</p>;
  if (!ws) return <p className="faint" style={{ padding: 16 }}>Loading workspace…</p>;

  const isGrant = projectType === "grant_application";
  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: "overview", label: "Overview" },
    { key: "activity", label: "Activity", badge: ws.events.length },
    // Research and the requirements matrix are grant-workflow records;
    // website projects surface their QA in the test-report artifact instead.
    ...(isGrant ? [
      { key: "research" as Tab, label: "Research", badge: ws.sources.length },
      { key: "requirements" as Tab, label: "Requirements", badge: ws.requirements.length },
    ] : []),
    { key: "questions", label: "Questions", badge: ws.questions.length },
    { key: "documents", label: "Documents", badge: ws.files.length },
    { key: "application", label: isGrant ? "Application" : "Artifacts", badge: ws.artifacts.length },
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
        {tab === "overview" && <Overview ws={ws} />}
        {tab === "activity" && <Activity ws={ws} teammates={teammates} />}
        {tab === "research" && <Research ws={ws} />}
        {tab === "requirements" && <Requirements ws={ws} />}
        {tab === "questions" && (
          <Questions ws={ws} onSubmit={async (lines) => {
            await api.sendMessage(org.id, channelId, lines);
            refresh();
          }} />
        )}
        {tab === "documents" && <Documents ws={ws} />}
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
  const nextAction = ws.questions.length
    ? `Answer ${ws.questions.length} open question${ws.questions.length > 1 ? "s" : ""} in the Questions tab.`
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
          <span className={`pill ${r.mandatory ? "red" : "blue"}`}>{r.mandatory ? "mandatory" : "optional"}</span>
          <div>
            <div style={{ fontSize: 13 }}>{r.text ?? r.key}</div>
            {r.sourceLine && <div className="faint">Source: “{String(r.sourceLine).slice(0, 120)}”</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Questions({ ws, onSubmit }: { ws: GrantWorkspace; onSubmit: (lines: string) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  if (!ws.questions.length) {
    return <p className="faint">Nothing is needed from you right now. When the team hits a fact it can't verify, a focused form appears here — only for genuinely missing information.</p>;
  }
  if (sent) return <p className="faint">Answers sent — the team resumed automatically.</p>;
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const lines = ws.questions
        .map((q) => ({ q, v: (values[q.key] ?? q.prefill ?? "").trim() }))
        .filter(({ v }) => v)
        .map(({ q, v }) => `${q.key}: ${v}`);
      if (!lines.length) return;
      setBusy(true);
      try { await onSubmit(lines.join("\n")); setSent(true); } finally { setBusy(false); }
    }}>
      <p className="faint" style={{ marginBottom: 10 }}>
        These are the only facts the team could not verify. Known values are prefilled — confirm or edit. Partial answers are fine.
      </p>
      {ws.questions.map((q) => {
        const set = (value: string) => setValues((v) => ({ ...v, [q.key]: value }));
        return (
          <div className="field" key={q.key} style={{ marginBottom: 10 }}>
            <label htmlFor={`wsq-${q.key}`}>{q.label}</label>
            {q.inputType === "textarea" ? (
              <textarea id={`wsq-${q.key}`} rows={3} defaultValue={q.prefill ?? ""} onChange={(e) => set(e.target.value)} />
            ) : q.inputType === "choice" ? (
              <select id={`wsq-${q.key}`} defaultValue={q.prefill ?? ""} onChange={(e) => set(e.target.value)}>
                <option value="">Choose…</option>
                {(q.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : q.inputType === "boolean" ? (
              <select id={`wsq-${q.key}`} defaultValue={q.prefill ?? ""} onChange={(e) => set(e.target.value)}>
                <option value="">Choose…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            ) : (
              <input id={`wsq-${q.key}`}
                type={q.inputType === "number" ? "number" : q.inputType === "date" ? "date" : "text"}
                defaultValue={q.prefill ?? ""} onChange={(e) => set(e.target.value)} />
            )}
            {q.help && <p className="faint" style={{ marginTop: 2 }}>{q.help}</p>}
            <p className="faint" style={{ marginTop: 2 }}>{q.reasonNeeded}</p>
          </div>
        );
      })}
      <button className="primary" disabled={busy}>Send answers</button>
    </form>
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
            <div style={{ fontSize: 13, fontWeight: 600 }}>{f.filename}</div>
            <div className="faint">{f.mime} · {(f.size_bytes / 1024).toFixed(1)} KB · {new Date(f.created_at).toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
