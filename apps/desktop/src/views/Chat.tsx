import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import * as api from "../api";
import type { ChannelInfo, ChatMessage, GrantActionRef, InfoRequestField, Organization, TeammateInfo } from "../types";
import { InfoFieldInput, hasAnswer, type FieldValue } from "../components/InfoFieldInput";
import { Icon } from "../components/Icon";
import { Avatar } from "../components/Avatar";
import { chips, fitLabel, headline, type BidPayload } from "../decision";
import { openExternal } from "../external";
import { roleAtLeast } from "../roles";
import { pendingGcpWork } from "../gcp-activity";

export function agentColor(key: string): string {
  const hue = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  return `hsl(${hue} 40% 45%)`;
}

/** Packaging-completion card: the real generated files, with view + download. */
function DeliverablesCard({ org, deliverables, onView }: {
  org: Organization;
  deliverables: NonNullable<ChatMessage["metadata"]>["deliverables"];
  onView: (deliverableId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="opp-card" style={{ maxWidth: 420 }}>
      <div className="opp-card-title" style={{ marginTop: 0 }}>
        {deliverables!.length === 1 ? "Document ready" : `${deliverables!.length} documents ready`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {deliverables!.map((d) => {
          const name = `application-v${d.version ?? 1}.${d.format.toLowerCase()}`;
          return (
            <div key={d.id} className="row" style={{ gap: 8 }}>
              <Icon name="file-text" size={16} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
                <div className="faint">{d.sizeBytes ? `${(d.sizeBytes / 1024).toFixed(1)} KB` : d.format.toUpperCase()}</div>
              </div>
              <button className="ghost" onClick={() => onView(d.id)}>View</button>
              <button className="ghost" disabled={busy === d.id}
                title="Download" aria-label="Download"
                onClick={async () => {
                  setBusy(d.id);
                  try { await api.downloadGcpDeliverable(org.id, d.id, name); } finally { setBusy(null); }
                }}>
                <Icon name="download" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <p className="faint" style={{ marginTop: 8, fontSize: 11 }}>Private and authenticated — no public links.</p>
    </div>
  );
}

function matchPill(score: string): string {
  const s = score.toLowerCase();
  return s === "high" ? "green" : s === "medium" ? "amber" : s === "low" ? "red" : "gray";
}
function recPill(rec: string): string {
  return rec === "Apply" ? "green" : rec === "Monitor" ? "amber" : rec === "Closed" ? "gray" : "red";
}

export function splitAgent(teammates: Map<string, TeammateInfo>, agentKey: string | null) {
  if (!agentKey) return { name: "Deedwell", role: "" };
  const mate = teammates.get(agentKey);
  return mate ? { name: mate.name, role: mate.role } : { name: agentKey, role: "" };
}


export function ChatView({
  org,
  channel,
  teammates,
  refreshTick,
  refresh,
  onOpenChannel,
  onOpenWork,
  onViewDeliverable,
  working,
  onCancelRun,
}: {
  org: Organization;
  channel: ChannelInfo;
  teammates: Map<string, TeammateInfo>;
  refreshTick: number;
  refresh: () => void;
  onOpenChannel: (channelId: string) => void;
  onOpenWork: () => void;
  onViewDeliverable?: (deliverableId: string) => void;
  working?: { runId: string; label: string; waiting?: boolean } | null;
  onCancelRun?: (runId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canPost = roleAtLeast(org.role, "member");
  const gcpWorking = useMemo(() => pendingGcpWork(messages), [messages]);

  // Agent-initiated panel opening (spec §2): messages that arrive via the SSE
  // refresh — not just direct send responses — can carry openWorkspace.
  const lastSeenRef = useRef<string | null>(null);
  useEffect(() => {
    lastSeenRef.current = null; // channel switch: never auto-open on history
  }, [channel.id]);
  useEffect(() => {
    let cancelled = false;
    api
      .listMessages(org.id, channel.id)
      .then(({ messages }) => {
        if (cancelled) return;
        const prevSeen = lastSeenRef.current;
        if (prevSeen !== null) {
          const fresh = messages.filter(
            (m) => m.created_at > prevSeen && m.author_kind === "agent"
              && (m.metadata?.openWorkspace || (m.metadata?.gcpTasks?.length ?? 0) > 0)
          );
          if (fresh.length) onOpenWork();
        }
        lastSeenRef.current = messages.at(-1)?.created_at ?? null;
        setMessages(messages);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load messages"));
    return () => {
      cancelled = true;
    };
  }, [org.id, channel.id, refreshTick]);

  useEffect(() => {
    // Smooth auto-scroll that doesn't fight the user (spec §3).
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, channel.id, awaitingReply, atBottom]);

  async function send(body: string, fileId?: string | null, action?: GrantActionRef | null) {
    if (!body.trim() || busy) return;
    setBusy(true);
    setAwaitingReply(true); // real request in flight — this is not a fake delay
    setError(null);
    const clientKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Optimistic render of the user's own message; reconciled with the
    // server copy (same clientKey) when the response lands.
    const temp: ChatMessage = {
      id: `tmp-${clientKey}`, author_kind: "user", author_user: "you",
      author_agent: null, author_name: null, body: body.trim(),
      metadata: {}, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, temp]);
    setText("");
    try {
      const { messages: created } = await api.sendMessage(org.id, channel.id, body.trim(), fileId, clientKey, null, action);
      setMessages((prev) => [...prev.filter((m) => m.id !== temp.id), ...created]);
      // Meaningful work started — open the workspace panel automatically
      // (platform tasks count: their progress lives in the Activity panel).
      if (created.some((m) => m.metadata?.openWorkspace || (m.metadata?.gcpTasks?.length ?? 0) > 0)) onOpenWork();
      refresh();
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      setText(body); // let the user retry without retyping
      setError(err instanceof Error ? err.message : "Message failed to send — try again");
    } finally {
      setBusy(false);
      setAwaitingReply(false);
    }
  }

  async function attach(file: File) {
    setBusy(true);
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of buf) binary += String.fromCharCode(byte);
      const lower = file.name.toLowerCase();
      const mime = lower.endsWith(".pdf") ? "application/pdf"
        : lower.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html"
        : lower.endsWith(".md") ? "text/markdown" : "text/plain";
      const { fileId, filename } = await api.uploadChatFile(org.id, channel.id, file.name, mime, btoa(binary));
      setBusy(false);
      await send(`Attached: ${filename}`, fileId);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(text);
    }
  }

  return (
    <>
      <div
        className="chat-scroll" ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {messages.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            prev={messages[i - 1]}
            teammates={teammates}
            org={org}
            onOpenChannel={onOpenChannel}
            onOpenWork={onOpenWork}
            onViewDeliverable={onViewDeliverable}
            onQuickSend={(body, action) => void send(body, null, action)}
            refresh={refresh}
          />
        ))}
        {messages.length === 0 && (
          <p className="empty">No messages yet — say hello.</p>
        )}
        {awaitingReply && (
          <div className="chat-msg" aria-live="polite">
            <Avatar
              id={channel.kind === "dm" ? channel.agent_key ?? "dm" : "core.executive_assistant"}
              name="Working" size={44} presence
            />
            <div className="m-body">
              <div className="m-head"><span className="m-name">
                {channel.kind === "dm" ? channel.name : "Maya"}
              </span><span className="m-role">is thinking…</span></div>
              <div className="typing-dots" aria-label="Waiting for reply"><span /><span /><span /></div>
            </div>
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          className="jump-latest" aria-label="Jump to latest messages"
          onClick={() => {
            setAtBottom(true);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }}
        >
          ↓ Latest
        </button>
      )}
      {!working && gcpWorking && (
        <div className="working-strip" aria-live="polite">
          <span className="presence working" style={{ position: "static" }} aria-hidden="true" />
          {gcpWorking.label}
        </div>
      )}
      {working && (
        <div className={`working-strip${working.waiting ? " waiting" : ""}`} aria-live="polite">
          {/* Pulse only while a backend step is genuinely running — a run
              waiting on the user shows a static marker (spec §9). */}
          <span className={`presence ${working.waiting ? "" : "working"}`} style={{ position: "static" }} aria-hidden="true" />
          {working.label}
          {onCancelRun && !working.waiting && (
            <button className="ghost" style={{ minHeight: 0, padding: "2px 10px", marginLeft: "auto" }}
              onClick={() => onCancelRun(working.runId)}>
              Cancel
            </button>
          )}
        </div>
      )}
      <div className="composer-wrap">
        {error && <p className="error-text" role="alert">{error}</p>}
        <form
          className="composer-box"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <textarea
            aria-label={`Message ${channel.kind === "dm" ? channel.name : `#${channel.name}`}`}
            placeholder={
              canPost
                ? `Message ${channel.kind === "dm" ? channel.name : `#${channel.name}`}`
                : "Viewers can read but not post"
            }
            value={text}
            disabled={!canPost || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="composer-actions">
            <button type="button" className="icon-btn" title="Attach a file (.pdf/.docx/.txt/.md/.html)"
              aria-label="Attach file" disabled={!canPost} onClick={() => fileRef.current?.click()}>
              <Icon name="plus" size={16} />
            </button>
            <button type="button" className="icon-btn" title="Bold (wraps **text**)"
              aria-label="Format text" disabled={!canPost}
              onClick={() => setText((t) => (t.trim() ? `**${t.trim()}**` : t))}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Aa</span>
            </button>
            <button type="button" className="icon-btn" title="Add an emoji"
              aria-label="Add emoji" disabled={!canPost}
              onClick={() => setText((t) => `${t}🙂`)}>
              <span style={{ fontSize: 15 }}>☺</span>
            </button>
            <button type="button" className="icon-btn" title="Mention a teammate"
              aria-label="Mention a teammate" disabled={!canPost}
              onClick={() => setText((t) => `${t}@`)}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>@</span>
            </button>
            <button type="button" className="icon-btn" title="Attach a file"
              aria-label="Attach a file" disabled={!canPost} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={15} />
            </button>
            <span className="sep" aria-hidden="true" />
            <button type="button" className="icon-btn" title="Ask Maya what to do next"
              aria-label="AI assist" disabled={!canPost} style={{ color: "#7c5cbf" }}
              onClick={() => setText("Maya, what should we do next?")}>
              <span style={{ fontSize: 15 }}>✦</span>
            </button>
            <button className="send" disabled={!canPost || busy || !text.trim()} aria-label="Send message">
              <Icon name="send" size={16} />
            </button>
          </div>
          <input
            ref={fileRef} type="file" accept=".txt,.md,.pdf,.docx,.html,.htm" hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attach(file);
              e.target.value = "";
            }}
          />
        </form>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Message({
  m,
  prev,
  teammates,
  org,
  onOpenChannel,
  onOpenWork,
  onViewDeliverable,
  onQuickSend,
  refresh,
}: {
  m: ChatMessage;
  prev?: ChatMessage;
  teammates: Map<string, TeammateInfo>;
  org: Organization;
  onOpenChannel: (id: string) => void;
  onOpenWork: () => void;
  onViewDeliverable?: (deliverableId: string) => void;
  onQuickSend: (body: string, action?: GrantActionRef | null) => void;
  refresh: () => void;
}) {
  const [appliedIndex, setAppliedIndex] = useState<number | null>(null);
  const isAgent = m.author_kind === "agent";
  const who = isAgent ? splitAgent(teammates, m.author_agent) : { name: m.author_name ?? "You", role: "" };
  const grouped =
    prev &&
    prev.author_kind === m.author_kind &&
    prev.author_agent === m.author_agent &&
    prev.author_user === m.author_user &&
    new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 4 * 60_000;
  const meta = m.metadata ?? {};

  return (
    <div className="chat-msg">
      {grouped ? (
        <div style={{ width: 44, flexShrink: 0 }} />
      ) : (
        <Avatar
          id={m.author_agent ?? m.author_user ?? "user"}
          name={who.name}
          size={44}
          presence={isAgent}
        />
      )}
      <div className="m-body">
        {!grouped && (
          <div className="m-head">
            <span className="m-name">{who.name}</span>
            {who.role && <span className="m-role">{who.role}</span>}
            <span className="m-time">
              {new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        )}
        <div className="m-text">{meta.fileId ? <><Icon name="file-text" size={13} /> {m.body}</> : m.body}</div>

        {meta.searchResults && (
          <div className="opp-list">
            {meta.searchResults.map((r) => {
              const canApply = !r.recommendation || r.recommendation === "Apply";
              return (
                <div key={r.index} className="opp-card">
                  <div className="opp-card-top">
                    <span className="pill blue">#{r.index}</span>
                    {r.matchScore && <span className={`pill ${matchPill(r.matchScore)}`}>{r.matchScore} match</span>}
                    {r.recommendation && <span className={`pill ${recPill(r.recommendation)}`}>{r.recommendation}</span>}
                    {r.programArea && <span className="faint" style={{ marginLeft: "auto" }}>{r.programArea}</span>}
                  </div>
                  <div className="opp-card-title">{r.title}</div>
                  <div className="faint">
                    {r.funder}{r.number ? ` · ${r.number}` : ""}{r.closeDate ? ` · closes ${r.closeDate}` : ""}
                  </div>
                  {r.matchReason && <div className="opp-card-reason">{r.matchReason}</div>}
                  <div className="opp-card-actions">
                    {r.sourceUrl?.startsWith("http") && (
                      <button className="ghost" onClick={() => void openExternal(r.sourceUrl!)}>Details ↗</button>
                    )}
                    <button className={canApply ? "primary" : "ghost"} disabled={appliedIndex !== null || !canApply}
                      title={canApply ? undefined : `Not currently recommended (${r.recommendation}) — the platform verified this against the funder's own site`}
                      onClick={() => {
                        // Structured event with the exact grant — the chat shows
                        // "Apply for #N" but the server never re-derives it (§11).
                        setAppliedIndex(r.index);
                        onQuickSend(`Apply for #${r.index} — ${r.title}`, {
                          type: "start_grant_application", index: r.index, title: r.title,
                          number: r.number ?? null, funder: r.funder ?? null,
                          closeDate: r.closeDate ?? null, sourceUrl: r.sourceUrl ?? null,
                          externalId: r.externalId ?? null,
                        });
                      }}>
                      {appliedIndex === r.index ? "Applying…" : canApply ? "Apply" : r.recommendation}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {meta.deliverables && meta.deliverables.length > 0 && (
          <DeliverablesCard org={org} deliverables={meta.deliverables}
            onView={(id) => (onViewDeliverable ? onViewDeliverable(id) : onOpenWork())} />
        )}

        {meta.infoRequest && meta.infoRequest.length > 0 && meta.infoRequestOpen !== false && (
          <InfoQuickForm
            org={org}
            runId={meta.runId}
            request={meta.infoRequest}
            allowSkip={meta.allowSkip}
            onSubmit={onQuickSend}
            onDone={refresh}
          />
        )}

        {meta.approvalId && meta.approvalKind === "bid_decision" && (
          <GrantDecisionCard
            org={org}
            approvalId={meta.approvalId}
            payload={(meta.approvalPayload ?? {}) as BidPayload}
            refresh={refresh}
          />
        )}
        {meta.approvalId && meta.approvalKind !== "bid_decision" && (
          <ApprovalActions org={org} approvalId={meta.approvalId} refresh={refresh} />
        )}

        {meta.goToChannelId && (
          <div className="chat-card">
            <button className="primary" onClick={() => onOpenChannel(meta.goToChannelId!)}>
              Open channel →
            </button>
          </div>
        )}

        {meta.runId && !meta.approvalId && (
          <div style={{ marginTop: 4 }}>
            <button className="ghost" onClick={onOpenWork}>
              <span className="row"><Icon name="file-text" size={13} /> View the work</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Structured information request (spec §6): typed inputs with guidance,
 *  grouped, partial submission allowed — the run resumes as answers arrive.
 *
 *  Answers post as typed values to provide-info rather than as a "key: value"
 *  chat message. The old text round trip silently corrupted any answer
 *  containing ": " or a newline, and forced the server to re-derive keys from
 *  prose it had just generated. */
function InfoQuickForm({ org, runId, request, allowSkip, onSubmit, onDone }: {
  org: Organization;
  runId: string | undefined;
  request: Array<InfoRequestField | string>;
  allowSkip?: boolean;
  /** Fallback for messages that predate structured submission. */
  onSubmit: (body: string) => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sent) return null;

  // Back-compat: pre-structured messages carried bare fact keys.
  const fields: InfoRequestField[] = request.map((f) =>
    typeof f === "string"
      ? { key: f, label: f.replace(/_/g, " "), inputType: "text" as const, help: "", reason: "", required: true, group: "Details" }
      : f
  );
  const groups = [...new Set(fields.map((f) => f.group))];
  const filled = fields.filter((f) => hasAnswer(values[f.key]));
  const set = (key: string, value: FieldValue) => setValues((v) => ({ ...v, [key]: value }));

  const post = async (facts: Array<{ key: string; value: FieldValue }>) => {
    setBusy(true);
    setError(null);
    try {
      if (runId) {
        await api.provideInfo(org.id, runId, facts);
      } else {
        onSubmit(facts.map((f) => `${f.key}: ${String(f.value)}`).join("\n"));
      }
      setSent(true);
      onDone();
    } catch (e) {
      // A 409 means the run already moved on — someone else answered, or this
      // is a double submit. Not an error worth alarming anyone about.
      const msg = e instanceof Error ? e.message : String(e);
      if (/409/.test(msg)) {
        setSent(true);
        onDone();
      } else {
        setError("That didn't save. Try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="chat-card info-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled.length) void post(filled.map((f) => ({ key: f.key, value: values[f.key]! })));
      }}
    >
      {groups.map((group) => (
        <div key={group}>
          {groups.length > 1 && <div className="info-group">{group}</div>}
          {fields.filter((f) => f.group === group).map((f) => (
            <div className="field" key={f.key} style={{ marginBottom: 10 }}>
              <label htmlFor={`iq-${f.key}`}>
                {f.label}
                {!f.required && <span className="faint"> (optional)</span>}
              </label>
              <InfoFieldInput field={f} id={`iq-${f.key}`} value={values[f.key]} onChange={(v) => set(f.key, v)} />
              {f.help && <p className="faint mt" style={{ margin: "3px 0 0" }}>{f.help}</p>}
            </div>
          ))}
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="primary" disabled={filled.length === 0 || busy}>
          {filled.length && filled.length < fields.length
            ? `Send ${filled.length} of ${fields.length} answers`
            : "Send answers"}
        </button>
        {allowSkip && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void post([{ key: "site_intake_skipped", value: true }])}
          >
            Let the team decide
          </button>
        )}
      </div>
      {error && <p className="error-text mt">{error}</p>}
      <p className="faint mt" style={{ marginTop: 6 }}>
        {allowSkip
          ? "None of these are required — answer what you care about and the team will choose the rest."
          : "Partial answers are fine — the team resumes as facts arrive, and answers are saved as user-certified evidence."}
      </p>
    </form>
  );
}

/** Reusable, fully wired decision card for bid/no-bid approvals (theme.png). */
function GrantDecisionCard({
  org,
  approvalId,
  payload,
  refresh,
}: {
  org: Organization;
  approvalId: string;
  payload: BidPayload;
  refresh: () => void;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canDecide = roleAtLeast(org.role, "admin");
  const total = Number(payload.total ?? 0);
  const fit = fitLabel(payload.recommendation, total);
  const chipList = chips(payload.dimensions);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await api.decideApproval(org.id, approvalId, decision);
      setDone(decision === "approved" ? "Proceeding — the team is on it." : "Passed on this one.");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="decision-card">
      <div className="decision-top">
        <div className="decision-score">
          <div className="medal" aria-hidden="true"><Icon name="check-circle" size={26} /></div>
          <div className="num">{total}<small> /100</small></div>
          <div className={`fit ${fit.tone === "good" ? "" : fit.tone === "warn" ? "warn" : "low"}`}>{fit.label}</div>
        </div>
        <div className="decision-main">
          <div className="headline">{headline(payload.recommendation)}</div>
          <div className="expl">{(payload.rationale ?? "").split(". ").slice(1).join(". ") || payload.rationale}</div>
          <div className="decision-chips">
            {chipList.map((c) => (
              <span key={c.label} className={`chip ${c.good ? "good" : ""}`}>
                <Icon name={c.good ? "check-circle" : "clock"} size={13} /> {c.label}: {c.value}
              </span>
            ))}
          </div>
        </div>
      </div>
      {payload.dimensions && (
        <div className="decision-why">
          <div className="why-title"><Icon name="alert" size={14} /> Why this score?</div>
          <p>{payload.dimensions.map((d) => d.note).slice(0, 2).join(" ")}</p>
        </div>
      )}
      <div className="decision-actions">
        {done ? (
          <span className="pill green">{done}</span>
        ) : canDecide ? (
          <>
            <button className="primary" disabled={busy} onClick={() => decide("approved")}>
              Proceed →
            </button>
            <button className="danger" disabled={busy} onClick={() => decide("rejected")}>
              Pass ✕
            </button>
          </>
        ) : (
          <span className="faint">An admin can decide here or by replying "approve" / "pass".</span>
        )}
      </div>
    </div>
  );
}

function ApprovalActions({
  org,
  approvalId,
  refresh,
}: {
  org: Organization;
  approvalId: string;
  refresh: () => void;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canDecide = roleAtLeast(org.role, "admin");
  if (!canDecide) return <p className="faint">An admin can approve this here or by replying "approve".</p>;
  if (done) return <p className="faint">You {done} this.</p>;
  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await api.decideApproval(org.id, approvalId, decision);
      setDone(decision);
      refresh();
    } catch {
      setDone(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button className="primary" disabled={busy} onClick={() => decide("approved")}>Proceed →</button>
      <button className="danger" disabled={busy} onClick={() => decide("rejected")}>Pass ✕</button>
    </div>
  );
}
