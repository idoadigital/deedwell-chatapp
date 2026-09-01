import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { AdGrantsOversightRow } from "../api";
import { Icon } from "../components/Icon";
import { GoogleConnectLive } from "../components/GoogleConnectLive";

function statusLabel(row: AdGrantsOversightRow): string {
  if (row.waiting?.context === "google_connect") return "Waiting on Google sign-in";
  if (row.status === "waiting_for_info") return "Waiting on the org for info";
  if (row.status === "waiting_approval") return "Waiting on the org's approval";
  if (row.status === "failed" || row.status === "suspended_budget") return "Processing issue";
  return row.current_step ? row.current_step.replace(/_/g, " ") : row.status.replace(/_/g, " ");
}

export function AdGrantsOversightCard() {
  const [rows, setRows] = useState<AdGrantsOversightRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openOrgId, setOpenOrgId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listAdGrantsOversight().then((r) => setRows(r.applications)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="card">
      <h2>Google Ad Grants — in progress</h2>
      <p className="muted">
        Every organization with an active application, across the whole platform. Sign in on an
        org's behalf when their automation is stuck waiting on a Google session.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!rows ? (
        <p className="faint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="faint">No in-progress applications.</p>
      ) : (
        <div className="field" style={{ marginTop: 10 }}>
          {rows.map((row) => (
            <div key={row.org_id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  <strong>{row.org_name}</strong>
                  <br />
                  <span className="faint">{statusLabel(row)} · updated {new Date(row.updated_at).toLocaleString()}</span>
                  {row.last_error && <><br /><span className="faint">{row.last_error}</span></>}
                </span>
                {row.waiting?.context === "google_connect" && (
                  <button className="ghost" onClick={() => setOpenOrgId((id) => (id === row.org_id ? null : row.org_id))}>
                    <Icon name="bot" size={14} /> {openOrgId === row.org_id ? "Close" : "Sign in to Google"}
                  </button>
                )}
              </div>
              {openOrgId === row.org_id && (
                <div style={{ marginTop: 10 }}>
                  <GoogleConnectLive orgId={row.org_id} onConnected={() => { setOpenOrgId(null); refresh(); }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
