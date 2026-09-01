import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { Icon } from "./Icon";

// Must match the fixed viewport set in browser-automation's connect-flow.ts —
// pointer coordinates are scaled from the displayed image into this space.
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;

type Status = "idle" | "connecting" | "live" | "connected" | "error";

/**
 * Platform-admin port of deedwell-v2's ConnectGooglePanel — same live
 * screencast of a real headless-Chromium Google sign-in page, same raw
 * mouse/keyboard relay, same WS contract. Deedwell only ever forwards
 * input events into a page it never reads; it doesn't see whatever
 * password gets typed as a value. Used when an org's Ad Grants automation
 * is stuck waiting on a Google session — the admin types the org's own
 * Google credentials live here, on the org's behalf, the same way that
 * org's own user would.
 */
export function GoogleConnectLive({ orgId, onConnected }: { orgId: string; onConnected?: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => wsRef.current?.close(), []);

  const start = async () => {
    setStatus("connecting");
    setError("");
    try {
      const { wsPath } = await api.startAdminGoogleConnect(orgId);
      const base = api.API_URL.startsWith("http") ? api.API_URL : window.location.origin + api.API_URL;
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}${wsPath}`);
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        let msg: { type: string; data?: string; error?: string };
        try {
          msg = JSON.parse(evt.data as string);
        } catch {
          return;
        }
        if (msg.type === "ready") setStatus("live");
        else if (msg.type === "frame" && imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
        else if (msg.type === "connected") {
          setStatus("connected");
          onConnected?.();
        } else if (msg.type === "error") {
          setStatus("error");
          setError(msg.error || "Connect session failed.");
        }
      };
      ws.onerror = () => setStatus((s) => (s === "connected" ? s : "error"));
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not start the connect session.");
    }
  };

  const send = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  };
  const toViewport = (evt: { clientX: number; clientY: number }) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.round(((evt.clientX - rect.left) / rect.width) * VIEW_WIDTH),
      y: Math.round(((evt.clientY - rect.top) / rect.height) * VIEW_HEIGHT),
    };
  };

  const live = status === "live";

  return (
    <div className="card">
      <h3>Sign in to Google for this organization</h3>
      {status === "idle" && (
        <>
          <p className="muted">
            Opens a live view of Google's real sign-in page. You'll type the organization's Google
            credentials directly into it — Deedwell never sees the password as a value, only relays
            input into Google's page.
          </p>
          <button className="primary" onClick={start}>
            <Icon name="bot" size={14} /> Start live sign-in
          </button>
        </>
      )}
      {status === "connecting" && <p className="faint">Starting a secure connect session…</p>}
      {(status === "live" || status === "connecting") && (
        <img
          ref={imgRef}
          alt="Live Google sign-in"
          tabIndex={0}
          style={{ display: "block", width: "100%", aspectRatio: "1280 / 800", border: "1px solid var(--border)", borderRadius: 10, background: "#10231a", opacity: live ? 1 : 0.5, outline: 0 }}
          onMouseMove={(e) => live && send({ type: "input", kind: "mouseMove", ...toViewport(e) })}
          onMouseDown={(e) => live && send({ type: "input", kind: "mouseDown", ...toViewport(e), button: "left" })}
          onMouseUp={(e) => live && send({ type: "input", kind: "mouseUp", ...toViewport(e), button: "left" })}
          onWheel={(e) => live && send({ type: "input", kind: "wheel", deltaX: e.deltaX, deltaY: e.deltaY })}
          onKeyDown={(e) => { if (live) { e.preventDefault(); send({ type: "input", kind: "keyDown", key: e.key }); } }}
          onKeyUp={(e) => { if (live) { e.preventDefault(); send({ type: "input", kind: "keyUp", key: e.key }); } }}
        />
      )}
      {status === "connected" && <p className="faint">Google account connected — the application will continue automatically.</p>}
      {status === "error" && (
        <p className="error-text" role="alert">
          {error} <button className="ghost" onClick={start}>Retry</button>
        </p>
      )}
    </div>
  );
}
