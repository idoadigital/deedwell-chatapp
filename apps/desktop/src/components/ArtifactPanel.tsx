import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type {
  ArtifactDetail,
  Organization,
  Requirement,
  RunDetail,
  SectionClaim,
} from "../types";
import { Icon } from "./Icon";
import { diffLines } from "../diff";

const TYPE_LABEL: Record<string, string> = {
  compliance_matrix: "Matrix",
  grant_section: "Draft",
  export_package: "Export",
  application_plan: "Plan",
  budget: "Budget",
  logic_model: "Logic model",
  review_report: "Review",
  compliance_report: "Checks",
  website_brief: "Brief",
  website_test_report: "Test report",
};

export function ArtifactPanel({ org, detail }: { org: Organization; detail: RunDetail | null }) {
  const artifacts = detail?.artifacts ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0] ?? null;

  useEffect(() => {
    if (!active) {
      setArtifact(null);
      return;
    }
    let cancelled = false;
    api
      .getArtifact(org.id, active.id)
      .then((a) => {
        if (cancelled) return;
        setArtifact(a);
        setVersion(a.artifact.current_version);
        setShowDiff(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load artifact"));
    return () => {
      cancelled = true;
    };
  }, [org.id, active?.id, active?.current_version]);

  const selectedVersion = useMemo(
    () => artifact?.versions.find((v) => v.version === version) ?? null,
    [artifact, version]
  );
  const previousVersion = useMemo(
    () => artifact?.versions.find((v) => v.version === (version ?? 0) - 1) ?? null,
    [artifact, version]
  );

  if (!detail || artifacts.length === 0) {
    return (
      <aside className="artifact-pane" aria-label="Artifacts">
        <div className="artifact-body">
          <div className="empty">
            <Icon name="file-text" size={22} />
            <p className="mt">Artifacts your team produces — compliance matrices, drafts,
            exports — appear here and update live.</p>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="artifact-pane" aria-label="Artifacts">
      <div className="artifact-tabs" role="tablist" style={{ flexWrap: "wrap" }}>
        {artifacts.map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={a.id === active?.id}
            className={`artifact-tab ${a.id === active?.id ? "active" : ""}`}
            onClick={() => setActiveId(a.id)}
            title={a.title}
          >
            {a.type === "grant_section"
              ? a.title.length > 16 ? `${a.title.slice(0, 15)}…` : a.title
              : TYPE_LABEL[a.type] ?? a.type}
          </button>
        ))}
      </div>
      {artifact && (
        <div className="artifact-toolbar">
          <span>{artifact.artifact.title}</span>
          <span style={{ marginLeft: "auto" }} />
          {artifact.versions.length > 1 && (
            <>
              <label htmlFor="ver" style={{ margin: 0 }}>Version</label>
              <select
                id="ver"
                value={version ?? undefined}
                onChange={(e) => setVersion(Number(e.target.value))}
              >
                {artifact.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              {previousVersion && artifact.artifact.type === "grant_section" && (
                <button className="ghost" onClick={() => setShowDiff((d) => !d)}>
                  {showDiff ? "Content" : "Diff"}
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div className="artifact-body">
        {error && <p className="error-text" role="alert">{error}</p>}
        {!artifact && !error && <p className="muted">Loading…</p>}
        {artifact && selectedVersion && (
          <>
            {artifact.artifact.type === "compliance_matrix" && (
              <ComplianceMatrix content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "grant_section" &&
              (showDiff && previousVersion ? (
                <SectionDiff
                  oldBody={String(previousVersion.content.body ?? "")}
                  newBody={String(selectedVersion.content.body ?? "")}
                />
              ) : (
                <SectionView content={selectedVersion.content} />
              ))}
            {artifact.artifact.type === "export_package" && (
              <ExportView
                orgId={org.id}
                artifactId={artifact.artifact.id}
                markdown={String(selectedVersion.content.markdown ?? "")}
                budgetCsv={
                  typeof selectedVersion.content.budgetCsv === "string"
                    ? selectedVersion.content.budgetCsv
                    : null
                }
              />
            )}
            {artifact.artifact.type === "application_plan" && (
              <PlanView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "budget" && (
              <BudgetView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "logic_model" && (
              <LogicModelView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "review_report" && (
              <ReviewView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "compliance_report" && (
              <ChecksView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "website_test_report" && (
              <TestReportView content={selectedVersion.content} />
            )}
            {artifact.artifact.type === "website_brief" && (
              <BriefView content={selectedVersion.content} />
            )}
            <p className="faint mt">
              v{selectedVersion.version} · {selectedVersion.change_summary} ·{" "}
              {selectedVersion.created_by_kind === "agent"
                ? selectedVersion.created_by_agent
                : "you"}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function ComplianceMatrix({ content }: { content: Record<string, unknown> }) {
  const requirements = (content.requirements ?? []) as Requirement[];
  return (
    <table>
      <thead>
        <tr><th>Requirement</th><th>Kind</th><th>Source</th></tr>
      </thead>
      <tbody>
        {requirements.map((r, i) => (
          <tr key={i}>
            <td>
              {r.mandatory ? (
                <span className="pill red" style={{ marginRight: 6 }}>must</span>
              ) : (
                <span className="pill gray" style={{ marginRight: 6 }}>should</span>
              )}
              {r.text}
              {r.wordLimit && <div className="faint">Limit: {r.wordLimit} words</div>}
            </td>
            <td className="muted">{r.kind}</td>
            <td className="mono">L{r.sourceLocation.line}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SectionView({ content }: { content: Record<string, unknown> }) {
  const claims = (content.claims ?? []) as SectionClaim[];
  const warnings = (content.warnings ?? []) as string[];
  return (
    <div className="prose">
      <h2>{String(content.title ?? "")}</h2>
      {String(content.body ?? "")
        .split("\n\n")
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      <p className="faint">{Number(content.wordCount ?? 0)} words</p>
      {warnings.length > 0 && (
        <div className="msg-card warn">
          {warnings.map((w, i) => (
            <div key={i} className="row muted" style={{ fontSize: 13 }}>
              <Icon name="alert" size={13} /> {w}
            </div>
          ))}
        </div>
      )}
      <h3 className="mt">Evidence behind each claim</h3>
      {claims.map((c, i) => (
        <div key={i} className={`claim ${c.flagged ? "flagged" : "ok"}`}>
          <span className="support">{c.support.replace("_", " ")}</span>
          <div>{c.text}</div>
        </div>
      ))}
    </div>
  );
}

function SectionDiff({ oldBody, newBody }: { oldBody: string; newBody: string }) {
  const lines = diffLines(oldBody, newBody);
  return (
    <div className="diff" role="figure" aria-label="Changes between versions">
      {lines.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>
          {l.kind === "added" ? "+ " : l.kind === "removed" ? "− " : "  "}
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}

function PlanView({ content }: { content: Record<string, unknown> }) {
  const sections = (content.sections ?? []) as Array<{
    title: string; objective: string; wordLimit: number | null; requirementLines: number[];
  }>;
  const activities = (content.activities ?? []) as string[];
  return (
    <div className="prose">
      <h3>Planned sections</h3>
      {sections.map((s, i) => (
        <div key={i} className="claim ok">
          <strong>{i + 1}. {s.title}</strong>
          <div className="muted">{s.objective}</div>
          <div className="faint">
            {s.wordLimit ? `Limit ${s.wordLimit} words · ` : ""}
            {s.requirementLines.length
              ? `Requirements: ${s.requirementLines.map((l) => `L${l}`).join(", ")}`
              : "No specific requirement lines"}
          </div>
        </div>
      ))}
      <h3 className="mt">Program activities</h3>
      <ul>{activities.map((a, i) => <li key={i}>{a}</li>)}</ul>
    </div>
  );
}

function BudgetView({ content }: { content: Record<string, unknown> }) {
  const items = (content.items ?? []) as Array<{
    category: string; description: string; activity: string; quantity: number;
    unitCost: number; amount: number;
  }>;
  const warnings = (content.warnings ?? []) as string[];
  return (
    <div className="prose">
      <table>
        <thead><tr><th>Item</th><th>Activity</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>
                <span className="pill gray" style={{ marginRight: 6 }}>{it.category}</span>
                {it.description}
              </td>
              <td className="muted">{it.activity}</td>
              <td className="mono" style={{ textAlign: "right" }}>${it.amount.toLocaleString()}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={2}><strong>Total</strong></td>
            <td className="mono" style={{ textAlign: "right" }}>
              <strong>${Number(content.total ?? 0).toLocaleString()}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      {warnings.length > 0 && (
        <div className="msg-card warn">
          {warnings.map((w, i) => <div key={i} className="muted" style={{ fontSize: 13 }}>{w}</div>)}
        </div>
      )}
      <h3 className="mt">Budget narrative</h3>
      <p className="muted">{String(content.narrative ?? "")}</p>
    </div>
  );
}

function LogicModelView({ content }: { content: Record<string, unknown> }) {
  const chain: Array<[string, unknown]> = [
    ["Problem", content.problem],
    ["Inputs", content.inputs],
    ["Activities", content.activities],
    ["Outputs", content.outputs],
    ["Outcomes", content.outcomes],
    ["Impact", content.impact],
  ];
  const indicators = (content.indicators ?? []) as Array<{
    outcome: string; indicator: string; baseline: string; target: string; frequency: string;
  }>;
  return (
    <div className="prose">
      {chain.map(([label, value]) => (
        <div key={label} style={{ marginBottom: 8 }}>
          <strong>{label}:</strong>{" "}
          {Array.isArray(value)
            ? <ul style={{ margin: "4px 0 0" }}>{value.map((v, i) => <li key={i}>{String(v)}</li>)}</ul>
            : <span className="muted">{String(value ?? "")}</span>}
        </div>
      ))}
      <h3 className="mt">Indicators</h3>
      <table>
        <thead><tr><th>Indicator</th><th>Baseline</th><th>Target</th></tr></thead>
        <tbody>
          {indicators.map((ind, i) => (
            <tr key={i}>
              <td>{ind.indicator}<div className="faint">{ind.outcome}</div></td>
              <td className="muted">{ind.baseline}</td>
              <td className="muted">{ind.target} <span className="faint">({ind.frequency})</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewView({ content }: { content: Record<string, unknown> }) {
  const reviews = (content.reviews ?? []) as Array<{
    reviewer: string; criterion: string; score: number; maxScore: number;
    strengths: string; weaknesses: string; fatalFlaw: boolean;
  }>;
  const recommendations = (content.revisionRecommendations ?? []) as string[];
  return (
    <div className="prose">
      <p><strong>Panel score: {Number(content.overall ?? 0)}/{Number(content.max ?? 0)}</strong></p>
      {reviews.map((r, i) => (
        <div key={i} className={`claim ${r.fatalFlaw ? "flagged" : "ok"}`}>
          <span className="support">{r.reviewer} · {r.score}/{r.maxScore}{r.fatalFlaw ? " · FATAL FLAW" : ""}</span>
          <div>{r.criterion}</div>
          <div className="faint">+ {r.strengths}</div>
          <div className="faint">− {r.weaknesses}</div>
        </div>
      ))}
      {recommendations.length > 0 && (
        <>
          <h3 className="mt">Revision recommendations</h3>
          <ul>{recommendations.map((r, i) => <li key={i} className="muted">{r}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function BriefView({ content }: { content: Record<string, unknown> }) {
  const sitemap = (content.sitemap ?? []) as Array<{ slug: string; title: string; purpose: string }>;
  const theme = content.theme as { palette?: string; headingFont?: string } | undefined;
  return (
    <div className="prose">
      <h3>Objectives</h3>
      <ul>{((content.objectives ?? []) as string[]).map((o, i) => <li key={i}>{o}</li>)}</ul>
      <h3>Audiences</h3>
      <ul>{((content.audiences ?? []) as string[]).map((a, i) => <li key={i}>{a}</li>)}</ul>
      <h3>Tone</h3>
      <p className="muted">{String(content.tone ?? "")}</p>
      <h3>Sitemap</h3>
      {sitemap.map((s) => (
        <div key={s.slug} className="claim ok">
          <strong>/{s.slug === "home" ? "" : s.slug}</strong> — {s.title}
          <div className="faint">{s.purpose}</div>
        </div>
      ))}
      {theme && (
        <p className="faint">Theme: {theme.palette} palette · {theme.headingFont} headings</p>
      )}
    </div>
  );
}

function ChecksView({ content }: { content: Record<string, unknown> }) {
  const checks = (content.checks ?? []) as Array<{ name: string; pass: boolean; detail: string }>;
  return (
    <div className="prose">
      {checks.map((c, i) => (
        <div key={i} className={`claim ${c.pass ? "ok" : "flagged"}`}>
          <span className="support">{c.pass ? "pass" : "attention"}</span>
          <div>{c.name}</div>
          <div className="faint">{c.detail}</div>
        </div>
      ))}
    </div>
  );
}

/** Website QA record (spec §8): every check the release ran, with severity —
 *  blocking failures are why an unpublishable build stayed unpublished. */
function TestReportView({ content }: { content: Record<string, unknown> }) {
  const checks = (content.checks ?? []) as Array<{
    name: string; page: string | null; pass: boolean; detail: string; severity?: string;
  }>;
  const blocking = checks.filter((c) => !c.pass && c.severity === "blocking");
  const advisory = checks.filter((c) => !c.pass && c.severity !== "blocking");
  return (
    <div className="prose">
      <p style={{ marginTop: 0 }}>
        <strong>{checks.filter((c) => c.pass).length}/{checks.length}</strong> checks passed
        {blocking.length ? <> · <span className="pill red">{blocking.length} blocking</span></> : null}
        {advisory.length ? <> · <span className="pill blue">{advisory.length} advisory</span></> : null}
      </p>
      {blocking.length > 0 && (
        <p className="error-text">These failures prevented publishing — the release never reached the approval gate.</p>
      )}
      {[...blocking, ...advisory, ...checks.filter((c) => c.pass)].map((c, i) => (
        <div key={i} className={`claim ${c.pass ? "ok" : "flagged"}`}>
          <span className="support">{c.pass ? "pass" : c.severity === "blocking" ? "blocking" : "advisory"}</span>
          <div>{c.name}{c.page ? <span className="faint"> — {c.page}</span> : null}</div>
          <div className="faint">{c.detail}</div>
        </div>
      ))}
    </div>
  );
}

function ExportView({
  orgId,
  artifactId,
  markdown,
  budgetCsv,
}: {
  orgId: string;
  artifactId: string;
  markdown: string;
  budgetCsv: string | null;
}) {
  function downloadBlob(content: string | Blob, filename: string, type: string) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function download() {
    const text = await api.getExportMarkdown(orgId, artifactId);
    downloadBlob(text, "application-package.md", "text/markdown");
  }
  async function downloadBinary(format: "docx" | "pdf") {
    const blob = await api.getExportBinary(orgId, artifactId, format);
    downloadBlob(blob, `application-package.${format}`, blob.type);
  }
  return (
    <div>
      <div className="row">
        <button className="primary" onClick={() => downloadBinary("docx")}>
          <span className="row"><Icon name="download" /> Download Word (.docx)</span>
        </button>
        <button className="primary" onClick={() => downloadBinary("pdf")}>
          <span className="row"><Icon name="download" /> Download PDF</span>
        </button>
        <button onClick={download}>
          <span className="row"><Icon name="download" /> Markdown (.md)</span>
        </button>
        {budgetCsv && (
          <button onClick={() => downloadBlob(budgetCsv, "budget.csv", "text/csv")}>
            <span className="row"><Icon name="download" /> Budget (.csv)</span>
          </button>
        )}
      </div>
      <pre
        className="mono mt"
        style={{ whiteSpace: "pre-wrap", background: "var(--muted)", padding: 12, borderRadius: 8 }}
      >
        {markdown}
      </pre>
    </div>
  );
}
