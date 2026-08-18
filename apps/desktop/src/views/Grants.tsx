import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import type {
  ApplicationRow,
  OpportunityRow,
  Organization,
  PassportStatus,
  Project,
  SearchHit,
} from "../types";
import { Icon } from "../components/Icon";
import { roleAtLeast } from "../roles";

const STATUS_TONE: Record<string, string> = {
  intake: "gray", in_progress: "blue", not_pursued: "gray",
  ready: "green", submitted: "blue", closed: "gray",
};
const ELIGIBILITY_TONE: Record<string, string> = {
  verified_eligible: "green", likely_eligible: "green",
  insufficient_information: "amber", conflicting: "amber", ineligible: "red",
};
const BID_TONE: Record<string, string> = {
  apply: "green", needs_review: "amber", do_not_apply: "red",
};
const VIABILITY_TONE: Record<string, string> = {
  apply: "green", monitor: "amber", closed: "gray", not_eligible: "red",
};
const VIABILITY_LABEL: Record<string, string> = {
  apply: "Apply", monitor: "Monitor", closed: "Closed", not_eligible: "Not eligible",
};
const OUTCOME_OPTIONS = ["submitted", "awarded", "rejected", "waitlisted", "withdrawn", "not_submitted"];

export function GrantsView({
  org,
  projects,
  onOpenProject,
  onOpenPassport,
}: {
  org: Organization;
  projects: Project[];
  onOpenProject: (projectId: string) => void;
  onOpenPassport: () => void;
}) {
  const [opportunities, setOpportunities] = useState<OpportunityRow[]>([]);
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [passport, setPassport] = useState<PassportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canAct = roleAtLeast(org.role, "member");

  const load = useCallback(() => {
    Promise.all([
      api.listOpportunities(org.id),
      api.listApplications(org.id),
      api.getPassport(org.id),
    ])
      .then(([o, a, p]) => {
        setOpportunities(o.opportunities);
        setApplications(a.applications);
        setPassport(p);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [org.id]);
  useEffect(load, [load]);

  return (
    <>
      <header className="main-header">
        <h1>Grants</h1>
        <span className="sub">Discovery, qualification, and outcomes</span>
      </header>
      <div className="main-scroll">
        {error && <p className="error-text" role="alert">{error}</p>}

        {passport && (
          <div className="card" style={passport.requiredMissing.length ? { borderColor: "rgba(245,158,11,0.35)" } : {}}>
            <div className="row">
              <Icon name="file-text" />
              <strong>Funding Passport: {passport.completeness}% complete</strong>
              {passport.requiredMissing.length > 0 && (
                <span className="pill amber">{passport.requiredMissing.length} required fields missing</span>
              )}
              <button className="ghost" style={{ marginLeft: "auto" }} onClick={onOpenPassport}>
                {passport.requiredMissing.length ? "Complete it" : "Review"}
              </button>
            </div>
            <p className="faint" style={{ marginTop: 6 }}>
              A complete passport strengthens eligibility checks and bid recommendations.
            </p>
          </div>
        )}

        {canAct && <DiscoveryCard org={org} projects={projects} onImported={load} />}

        <div className="card">
          <h2><Icon name="folder" /> Opportunities</h2>
          {opportunities.length === 0 ? (
            <div className="empty">No opportunities yet — search above or add one from a project.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Opportunity</th><th>Deadline</th><th>Status</th><th>Eligibility</th><th>Mission Fit</th><th>Viability</th><th /></tr>
              </thead>
              <tbody>
                {opportunities.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.title}</strong>
                      <div className="faint">{o.funder}{o.opportunity_number ? ` · ${o.opportunity_number}` : ""}</div>
                    </td>
                    <td className="muted">{o.deadline ?? "—"}</td>
                    <td><span className={`pill ${STATUS_TONE[o.status] ?? "gray"}`}>{o.status.replace(/_/g, " ")}</span></td>
                    <td>
                      {o.eligibility
                        ? <span className={`pill ${ELIGIBILITY_TONE[o.eligibility] ?? "gray"}`}>{o.eligibility.replace(/_/g, " ")}</span>
                        : <span className="faint">not checked</span>}
                    </td>
                    <td>
                      {o.mission_fit_score !== null
                        ? <span title={o.bid_recommendation ? `Composite score: ${o.bid_recommendation.replace(/_/g, " ")}` : undefined}>{o.mission_fit_score}%</span>
                        : <span className="faint">—</span>}
                    </td>
                    <td>
                      {o.viability
                        ? <span className={`pill ${VIABILITY_TONE[o.viability] ?? "gray"}`}>{VIABILITY_LABEL[o.viability] ?? o.viability}</span>
                        : <span className="faint">—</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="ghost" onClick={() => onOpenProject(o.project_id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2><Icon name="check-circle" /> Applications &amp; outcomes</h2>
          {applications.length === 0 ? (
            <div className="empty">Applications appear here once a bid is approved.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Opportunity</th><th>Status</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <OutcomeRow key={a.id} org={org} application={a} canAct={canAct} onSaved={load} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function DiscoveryCard({
  org,
  projects,
  onImported,
}: {
  org: Organization;
  projects: Project[];
  onImported: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [source, setSource] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grantProjects = projects.filter((p) => p.type === "grant_application");

  useEffect(() => {
    if (!projectId && grantProjects[0]) setProjectId(grantProjects[0].id);
  }, [grantProjects, projectId]);

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.grantSearch(org.id, keyword);
      setResults(res.results);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  async function importHit(hit: SearchHit) {
    if (!projectId) {
      setError("Create a grant project first, then import opportunities into it.");
      return;
    }
    setError(null);
    try {
      await api.importOpportunity(org.id, projectId, {
        title: hit.title,
        funder: hit.agency,
        opportunityNumber: hit.opportunityNumber,
        deadline: hit.closeDate,
        sourceUrl: hit.sourceUrl.startsWith("http") ? hit.sourceUrl : null,
        source: "grants_gov",
      });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }

  return (
    <div className="card">
      <h2><Icon name="activity" /> Discover opportunities</h2>
      <form className="row" onSubmit={search}>
        <input
          aria-label="Search keyword"
          placeholder="e.g. youth development, food security, arts education…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          minLength={2}
          required
        />
        <button className="primary" disabled={busy} style={{ whiteSpace: "nowrap" }}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
      {results && (
        <>
          <p className="faint mt">
            {results.length} result(s) from {source === "grants_gov" ? "Grants.gov" : `${source} source`}.
            Import into:{" "}
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              style={{ width: "auto", display: "inline-block", padding: "2px 8px" }}
              aria-label="Target project"
            >
              {grantProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </p>
          <table>
            <thead><tr><th>Title</th><th>Agency</th><th>Closes</th><th /></tr></thead>
            <tbody>
              {results.map((hit) => (
                <tr key={hit.externalId}>
                  <td>{hit.title}<div className="faint mono">{hit.opportunityNumber}</div></td>
                  <td className="muted">{hit.agency}</td>
                  <td className="muted">{hit.closeDate ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="ghost" onClick={() => importHit(hit)}>Import</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function OutcomeRow({
  org,
  application,
  canAct,
  onSaved,
}: {
  org: Organization;
  application: ApplicationRow;
  canAct: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(application.outcome ?? "submitted");
  const [amount, setAmount] = useState(application.award_amount ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.recordOutcome(org.id, application.id, {
        status,
        awardAmount: amount ? Number(amount) : null,
      });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{application.opportunity_title}</strong>
        <div className="faint">{application.funder}</div>
      </td>
      <td><span className="pill gray">{application.status.replace(/_/g, " ")}</span></td>
      <td>
        {editing ? (
          <span className="row">
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
              {OUTCOME_OPTIONS.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
            </select>
            {status === "awarded" && (
              <input
                type="number"
                placeholder="Award $"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ width: 110 }}
                aria-label="Award amount"
              />
            )}
            <button className="primary" disabled={busy} onClick={save}>Save</button>
          </span>
        ) : application.outcome ? (
          <span className="row">
            <span className={`pill ${application.outcome === "awarded" ? "green" : "gray"}`}>
              {application.outcome.replace(/_/g, " ")}
            </span>
            {application.award_amount && <span className="muted">${Number(application.award_amount).toLocaleString()}</span>}
            {canAct && <button className="ghost" onClick={() => setEditing(true)}>Edit</button>}
          </span>
        ) : canAct ? (
          <button className="ghost" onClick={() => setEditing(true)}>Record outcome</button>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
    </tr>
  );
}
