import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { ApiKeyRow, WebhookRow } from "../api";
import { Icon } from "../components/Icon";

const WEBHOOK_EVENT_TYPES = ["website.created", "website.published"];

function CopyOnce({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is still selectable/visible */
    }
  };
  return (
    <div className="card">
      <p className="faint">{label} — copy it now, it won’t be shown again</p>
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <code style={{ wordBreak: "break-all", flex: 1 }}>{value}</code>
        <button className="ghost" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listApiKeys().then((r) => setKeys(r.apiKeys)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);
  useEffect(refresh, [refresh]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.createApiKey(name.trim());
      setNewKey(result.key);
      setName("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.revokeApiKey(id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke key");
    }
  }

  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="muted">
        Read-only, platform-wide keys for the website-building integration — not something a
        nonprofit ever needs of its own. Access to every organization’s site data.
      </p>
      {newKey && <CopyOnce label="New API key" value={newKey} />}
      <div className="row" style={{ marginTop: 10 }}>
        <input
          placeholder="Key name, e.g. “Website builder integration”"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="primary" disabled={creating || !name.trim()} onClick={create}>
          <Icon name="plus" size={14} /> {creating ? "Creating…" : "Create key"}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {keys?.length ? (
        <div className="field" style={{ marginTop: 14 }}>
          {keys.map((key) => (
            <div className="row" key={key.id} style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{key.name}</strong>
                {key.revoked_at && <span className="faint"> (revoked)</span>}
                <br />
                <span className="faint">{key.key_prefix}…</span>
              </span>
              {!key.revoked_at && (
                <button className="ghost" onClick={() => revoke(key.id)}>
                  <Icon name="trash" size={14} /> Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      ) : keys && <p className="faint">No API keys yet.</p>}
    </div>
  );
}

function WebhooksCard() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([WEBHOOK_EVENT_TYPES[0]!]);
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    api.listWebhooks().then((r) => setHooks(r.webhooks)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);
  useEffect(refresh, [refresh]);

  const toggleEvent = (value: string) =>
    setEvents((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  async function create() {
    if (!url.trim() || !events.length) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.createWebhook(url.trim(), events);
      setNewSecret(result.secret);
      setUrl("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create webhook");
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteWebhook(id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove webhook");
    }
  }

  async function sendTest(id: string) {
    setTestState((prev) => ({ ...prev, [id]: "sending" }));
    try {
      await api.testWebhook(id);
      setTestState((prev) => ({ ...prev, [id]: "sent" }));
    } catch {
      setTestState((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  return (
    <div className="card">
      <h2>Webhooks</h2>
      <p className="muted">Signed POSTs, platform-wide — every event carries its own orgId/siteId.</p>
      {newSecret && <CopyOnce label="Signing secret" value={newSecret} />}
      <div className="field" style={{ marginTop: 10 }}>
        <input placeholder="https://your-app.example.com/webhooks/deedwell" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="row" style={{ gap: 14, marginTop: 8 }}>
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <label key={type} className="faint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={events.includes(type)} onChange={() => toggleEvent(type)} /> {type}
            </label>
          ))}
        </div>
        <button className="primary" disabled={creating || !url.trim() || !events.length} onClick={create} style={{ marginTop: 10, width: "fit-content" }}>
          <Icon name="plus" size={14} /> {creating ? "Creating…" : "Add webhook"}
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {hooks?.length ? (
        <div className="field" style={{ marginTop: 14 }}>
          {hooks.map((hook) => (
            <div className="row" key={hook.id} style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{hook.url}</strong>
                <br />
                <span className="faint">{hook.event_types.join(", ")}</span>
              </span>
              <span className="row" style={{ gap: 10 }}>
                <button className="ghost" onClick={() => sendTest(hook.id)}>
                  <Icon name="send" size={14} />{" "}
                  {testState[hook.id] === "sending" ? "Sending…" : testState[hook.id] === "sent" ? "Sent" : "Send test"}
                </button>
                <button className="ghost" onClick={() => remove(hook.id)}>
                  <Icon name="trash" size={14} /> Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : hooks && <p className="faint">No webhooks yet.</p>}
    </div>
  );
}

export function PlatformAdminView({ onBack }: { onBack: () => void }) {
  return (
    <>
      <header className="main-header">
        <button className="ghost" onClick={onBack} aria-label="Back">← Back</button>
        <h1>Platform Admin</h1>
      </header>
      <div className="main-scroll">
        <p className="muted">
          Manage access to the platform-wide website API used by our AI website-building
          integration. This is not per-organization — a key or webhook here can see every
          nonprofit’s site data.
        </p>
        <ApiKeysCard />
        <WebhooksCard />
      </div>
    </>
  );
}
