import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../api";
import type { Organization, SiteDetail, SiteRow, SubmissionRow } from "../types";
import { Icon } from "../components/Icon";
import { roleAtLeast } from "../roles";
import { openExternal } from "../external";

export function WebsitesView({
  org,
  onOpenProject,
  refreshTick,
}: {
  org: Organization;
  onOpenProject: (projectId: string) => void;
  refreshTick: number;
}) {
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listSites(org.id)
      .then(({ sites }) => {
        setSites(sites);
        if (sites.length && !selected) setSelected(sites[0]!.id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load sites"));
  }, [org.id, selected]);
  useEffect(load, [load, refreshTick]);

  const site = sites?.find((s) => s.id === selected) ?? null;

  return (
    <>
      <header className="main-header">
        <h1>Website</h1>
        <span className="sub">Preview, publish, and manage your public sites</span>
      </header>
      <div className="main-scroll">
        {error && <p className="error-text" role="alert">{error}</p>}
        {sites && sites.length === 0 && (
          <div className="card empty">
            No websites yet. Create a project of type <strong>Website</strong> and open it —
            the Website Team takes it from there.
          </div>
        )}
        {sites && sites.length > 1 && (
          <div className="row" style={{ marginBottom: 14 }}>
            {sites.map((s) => (
              <button
                key={s.id}
                className={s.id === selected ? "primary" : "ghost"}
                onClick={() => setSelected(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        {site && <SitePanel org={org} row={site} onOpenProject={onOpenProject} reload={load} />}
      </div>
    </>
  );
}

function SitePanel({
  org,
  row,
  onOpenProject,
  reload,
}: {
  org: Organization;
  row: SiteRow;
  onOpenProject: (projectId: string) => void;
  reload: () => void;
}) {
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRow[] | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canEdit = roleAtLeast(org.role, "member");
  const canRollback = roleAtLeast(org.role, "admin");

  const previewUrl = `${api.SITE_ROUTER_URL}/preview/${row.slug}/`;
  const liveUrl = `${api.SITE_ROUTER_URL}/${row.slug}/`;

  useEffect(() => {
    api.getSite(org.id, row.id).then(setDetail).catch(() => undefined);
    api.listSubmissions(org.id, row.id).then(({ submissions }) => setSubmissions(submissions)).catch(() => undefined);
  }, [org.id, row.id, row.status, row.preview_version, row.live_version]);

  async function requestChange(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.updateSite(org.id, row.id, instruction);
      setNotice("Change request sent to the Website Team — a new preview will appear for approval.");
      setInstruction("");
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function rollback(releaseId: string) {
    setBusy(true);
    try {
      await api.rollbackSite(org.id, row.id, releaseId);
      reload();
      const fresh = await api.getSite(org.id, row.id);
      setDetail(fresh);
    } finally {
      setBusy(false);
    }
  }

  const latestChecks = detail?.releases[0]?.checks ?? [];
  const failedChecks = latestChecks.filter((c) => !c.pass);

  return (
    <>
      <div className="card">
        <div className="row">
          <Icon name="columns" />
          <strong>{row.name}</strong>
          <span className={`pill ${row.status === "published" ? "green" : row.status === "preview" ? "amber" : "gray"}`}>
            {row.status}
          </span>
          <span className="faint" style={{ marginLeft: "auto" }}>
            {row.slug}.deedwell.app
          </span>
        </div>
        <div className="row mt">
          {row.preview_version && (
            <button className="ghost" onClick={() => void openExternal(previewUrl)}>
              Preview (v{row.preview_version}) ↗
            </button>
          )}
          {row.live_version && (
            <button className="primary" onClick={() => void openExternal(liveUrl)}>
              Live site (v{row.live_version}) ↗
            </button>
          )}
          <button className="ghost" onClick={() => onOpenProject(row.project_id)}>
            Open project workspace
          </button>
        </div>
        {detail && (
          <p className="faint mt">
            Pages: {detail.pages.map((p) => p.title).join(" · ")}
          </p>
        )}
      </div>

      {canEdit && (
        <form className="card" onSubmit={requestChange}>
          <h2><Icon name="activity" /> Request a change</h2>
          <p className="faint">
            Describe the change in plain language — the team proposes a patch, you see a new
            preview, and nothing goes live without approval. (The mock provider understands
            taglines, volunteer forms, and adding/removing pages; free-form edits arrive with a
            real model provider.)
          </p>
          <div className="row">
            <input
              aria-label="Change request"
              placeholder='e.g. Change the tagline to "Hope grows here"'
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              minLength={3}
              required
            />
            <button className="primary" disabled={busy} style={{ whiteSpace: "nowrap" }}>
              Send
            </button>
          </div>
          {notice && <p className="muted mt">{notice}</p>}
        </form>
      )}

      {failedChecks.length > 0 && (
        <div className="card" style={{ borderColor: "rgba(245,158,11,0.35)" }}>
          <h2><Icon name="alert" /> Checks needing attention</h2>
          {failedChecks.map((c, i) => (
            <div key={i} className="claim flagged">
              <span className="support">{c.page ?? "site"}</span>
              <div>{c.name}</div>
              <div className="faint">{c.detail}</div>
            </div>
          ))}
        </div>
      )}

      {detail && detail.releases.length > 0 && (
        <div className="card">
          <h2><Icon name="clock" /> Releases</h2>
          <table>
            <thead><tr><th>Version</th><th>Status</th><th>Checks</th><th>Built</th><th /></tr></thead>
            <tbody>
              {detail.releases.map((r) => (
                <tr key={r.id}>
                  <td className="mono">v{r.version}</td>
                  <td>
                    <span className={`pill ${r.status === "published" ? "green" : r.status === "built" ? "amber" : "gray"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="muted">
                    {r.checks.filter((c) => c.pass).length}/{r.checks.length} passed
                  </td>
                  <td className="muted">{new Date(r.created_at).toLocaleDateString()}</td>
                  <td style={{ textAlign: "right" }}>
                    {canRollback && r.status === "superseded" && (
                      <button className="ghost" disabled={busy} onClick={() => rollback(r.id)}>
                        Roll back to this
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {submissions && submissions.length > 0 && (
        <div className="card">
          <h2><Icon name="file-text" /> Form submissions ({submissions.length})</h2>
          <table>
            <thead><tr><th>Form</th><th>Content</th><th>Received</th></tr></thead>
            <tbody>
              {submissions.slice(0, 20).map((s) => (
                <tr key={s.id}>
                  <td><span className="pill blue">{s.form_key}</span></td>
                  <td className="muted">
                    {Object.entries(s.payload).map(([k, v]) => (
                      <div key={k}><strong>{k}:</strong> {v.slice(0, 120)}</div>
                    ))}
                  </td>
                  <td className="muted">{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
