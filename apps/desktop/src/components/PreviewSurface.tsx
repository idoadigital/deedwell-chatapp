import { useEffect, useRef, useState, type ReactNode } from "react";
import { isValidExternalUrl, openExternal } from "../external";

/**
 * Website preview surface for the artifact panel: explicit loading / error /
 * empty states, retry, and a real Open-in-Browser action — never a silent
 * blank frame.
 */
export function PreviewSurface({ url, reloadKey, frameWidth, toolbarExtra }: {
  url: string | null;
  /** Changing this reloads the frame — pass the release version so a fresh
   *  build appears without the user having to hit Refresh. */
  reloadKey?: string | number;
  /** Constrain the frame to a device width; null fills the panel. */
  frameWidth?: number | null;
  toolbarExtra?: ReactNode;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);

  // The site router sends `no-store` for preview releases, so remounting the
  // frame is enough to pick up a new build — no cache-busting query needed
  // (which the site's own relative links would drop anyway).
  const lastKey = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey !== undefined && reloadKey !== lastKey.current) {
      lastKey.current = reloadKey;
      setAttempt((a) => a + 1);
    }
  }, [reloadKey]);

  useEffect(() => {
    setState("loading");
    // If the frame hasn't reported load within 12s, call it what it is.
    const timer = setTimeout(() => {
      setState((s) => (s === "loading" ? "error" : s));
    }, 12000);
    return () => clearTimeout(timer);
  }, [url, attempt]);

  if (!isValidExternalUrl(url)) {
    return (
      <div className="empty" style={{ margin: "auto", padding: 40 }}>
        No preview URL found for this artifact yet — it appears here once a
        release has been built.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="artifact-toolbar">
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</span>
        <span style={{ marginLeft: "auto" }} />
        {toolbarExtra}
        <button className="ghost" style={{ minHeight: 0, padding: "4px 10px" }}
          onClick={() => setAttempt((a) => a + 1)}>
          Refresh
        </button>
        <button className="primary" style={{ minHeight: 0, padding: "4px 12px" }}
          onClick={async () => {
            setOpenError(null);
            const res = await openExternal(url);
            if (!res.ok) setOpenError(res.error ?? "Could not open the browser");
          }}>
          Open in browser ↗
        </button>
      </div>
      {openError && <p className="error-text" style={{ padding: "0 16px" }} role="alert">{openError}</p>}
      {state === "error" ? (
        <div className="empty" style={{ margin: "auto", padding: 40 }}>
          <p>The preview didn&rsquo;t load inside the panel.</p>
          <p className="faint">URL: {url}</p>
          <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button onClick={() => setAttempt((a) => a + 1)}>Retry</button>
            <button className="primary" onClick={() => void openExternal(url)}>Open in browser ↗</button>
          </div>
        </div>
      ) : (
        <>
          {state === "loading" && (
            <div className="faint" style={{ padding: "8px 16px" }} aria-live="polite">Loading preview…</div>
          )}
          <iframe
            key={attempt}
            className="site-frame"
            title="Website preview"
            sandbox="allow-forms allow-same-origin"
            src={url}
            style={frameWidth ? { width: frameWidth, margin: "0 auto", flex: 1 } : undefined}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
          />
        </>
      )}
    </div>
  );
}
