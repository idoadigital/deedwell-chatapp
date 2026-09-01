import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { SupportMessageRow, SupportThreadRow } from "../api";
import { Icon } from "../components/Icon";

function ThreadView({ orgId, orgName, onSent }: { orgId: string; orgName: string; onSent: () => void }) {
  const [messages, setMessages] = useState<SupportMessageRow[] | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.getAdminSupportMessages(orgId).then((r) => setMessages(r.messages)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [orgId]);
  useEffect(refresh, [refresh]);

  async function send() {
    if (!reply.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.postAdminSupportMessage(orgId, reply.trim());
      setReply("");
      refresh();
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>{orgName}</h3>
      <div className="field" style={{ maxHeight: 260, overflowY: "auto" }}>
        {messages?.map((m) => (
          <div key={m.id} style={{ padding: "6px 0", textAlign: m.author_kind === "platform_admin" ? "right" : "left" }}>
            <span className="faint">{m.author_kind === "platform_admin" ? "You" : "Them"} · {new Date(m.created_at).toLocaleString()}</span>
            <p style={{ margin: "2px 0 0" }}>{m.body}</p>
          </div>
        ))}
        {messages?.length === 0 && <p className="faint">No messages yet.</p>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={sending || !reply.trim()} onClick={send}>
          <Icon name="send" size={14} /> {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}

export function SupportInboxCard() {
  const [threads, setThreads] = useState<SupportThreadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openOrgId, setOpenOrgId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listSupportThreads().then((r) => setThreads(r.threads)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="card">
      <h2>Support inbox</h2>
      <p className="muted">Message any organization directly — for when something needs a human, not a teammate.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!threads ? (
        <p className="faint">Loading…</p>
      ) : threads.length === 0 ? (
        <p className="faint">No conversations yet.</p>
      ) : (
        <div className="field" style={{ marginTop: 10 }}>
          {threads.map((t) => (
            <button
              key={t.org_id}
              className="ghost"
              style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "8px 0", borderBottom: "1px solid var(--border)" }}
              onClick={() => setOpenOrgId((id) => (id === t.org_id ? null : t.org_id))}
            >
              <span>
                <strong>{t.org_name}</strong>
                {t.last_message && <><br /><span className="faint">{t.last_message.slice(0, 80)}</span></>}
              </span>
              {t.unread_by_admin > 0 && <i>{t.unread_by_admin}</i>}
            </button>
          ))}
        </div>
      )}
      {openOrgId && threads && (
        <ThreadView
          orgId={openOrgId}
          orgName={threads.find((t) => t.org_id === openOrgId)?.org_name ?? ""}
          onSent={refresh}
        />
      )}
    </div>
  );
}
