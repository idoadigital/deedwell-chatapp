import { useState } from "react";
import * as api from "../api";
import type { Approval, Organization } from "../types";
import { Icon } from "../components/Icon";
import { approvalTone } from "../components/StatusPill";
import { roleAtLeast } from "../roles";

export function ApprovalsView({
  org,
  approvals,
  refresh,
  onOpenProject,
}: {
  org: Organization;
  approvals: Approval[];
  refresh: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDecide = roleAtLeast(org.role, "admin");
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  async function decide(approval: Approval, decision: "approved" | "rejected") {
    setBusyId(approval.id);
    setError(null);
    try {
      await api.decideApproval(org.id, approval.id, decision);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <header className="main-header">
        <h1>Approvals</h1>
        <span className="sub">Sensitive actions require your explicit sign-off</span>
      </header>
      <div className="main-scroll">
        {error && <p className="error-text" role="alert">{error}</p>}
        {!canDecide && pending.length > 0 && (
          <p className="muted">
            You can view approvals, but deciding them requires the admin role.
          </p>
        )}
        {pending.length === 0 && <div className="card empty">Nothing waiting for approval.</div>}
        {pending.map((approval) => (
          <div className="card" key={approval.id} style={{ borderColor: "rgba(245,158,11,0.35)" }}>
            <div className="row">
              <Icon name="clock" />
              <strong>{labelFor(approval.kind)}</strong>
              <span className={`pill ${approvalTone(approval.status)}`}>{approval.status}</span>
              <span className="faint" style={{ marginLeft: "auto" }}>
                {approval.project_name}
              </span>
            </div>
            {(approval.payload.warnings?.length ?? 0) > 0 && (
              <div className="msg-card warn mt">
                <strong style={{ fontSize: 12.5 }}>Review before approving</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {approval.payload.warnings!.map((w, i) => (
                    <li key={i} className="muted" style={{ fontSize: 13 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="row mt">
              {canDecide && (
                <>
                  <button
                    className="primary"
                    disabled={busyId === approval.id}
                    onClick={() => decide(approval, "approved")}
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={busyId === approval.id}
                    onClick={() => decide(approval, "rejected")}
                  >
                    Reject
                  </button>
                </>
              )}
              {approval.project_id && (
                <button className="ghost" onClick={() => onOpenProject(approval.project_id!)}>
                  Open project
                </button>
              )}
            </div>
          </div>
        ))}

        {decided.length > 0 && (
          <div className="card">
            <h2>History</h2>
            <table>
              <thead>
                <tr><th>Action</th><th>Project</th><th>Decision</th><th>Note</th></tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id}>
                    <td>{labelFor(a.kind)}</td>
                    <td className="muted">{a.project_name}</td>
                    <td><span className={`pill ${approvalTone(a.status)}`}>{a.status}</span></td>
                    <td className="muted">{a.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const APPROVAL_LABELS: Record<string, string> = {
  section_export: "Export drafted grant section",
  strategy: "Application strategy — review before drafting",
  bid_decision: "Bid / no-bid decision",
  final_export: "Final compliance check — ready to export",
};

function labelFor(kind: string): string {
  return APPROVAL_LABELS[kind] ?? kind;
}
