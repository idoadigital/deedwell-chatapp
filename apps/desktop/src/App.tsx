import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { subscribeSSE, type SSESubscription } from "./sse";
import type {
  Approval, ChannelInfo, MemberInfo, Organization, Project, RunDetail, RunSummary,
  SiteRow, TeammateInfo, WorkflowEvent,
} from "./types";
import { Icon } from "./components/Icon";
import { Avatar } from "./components/Avatar";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { GrantWorkspacePanel } from "./components/GrantWorkspacePanel";
import { GcpDmPanel } from "./components/GcpActivityFeed";
import { PreviewSurface } from "./components/PreviewSurface";
import { openExternal } from "./external";
import { LoginView } from "./views/Login";
import { OrgSetupView } from "./views/OrgSetup";
import { ChatView, agentColor } from "./views/Chat";
import { GrantsView } from "./views/Grants";
import { PassportView } from "./views/Passport";
import { WebsitesView } from "./views/Websites";
import { HuddleView } from "./views/Huddle";
import { ApprovalsView } from "./views/Approvals";
import { PlatformAdminView } from "./views/PlatformAdmin";
import { SettingsView } from "./views/Settings";

const ORG_KEY = "deedwell.org";
const SEEN_KEY = "deedwell.seen";
type Overlay = "grants" | "passport" | "website" | "approvals" | "orgs" | "platform-admin" | "settings" | null;

const CHANNEL_DESCRIPTIONS: Record<string, string> = {
  general: "Team-wide conversation",
  announcements: "Important updates for everyone",
  "funding-opportunities": "Grant discovery and prospects",
  "grant-work": "Active grant collaboration",
  website: "Everything about your public website",
  "organization-information": "Facts, documents, and the Funding Passport",
};

export default function App() {
  const [authed, setAuthed] = useState<boolean>(!!api.getToken());
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [teammates, setTeammates] = useState<TeammateInfo[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState("");
  // Stripe's Checkout success/cancel redirect lands back on the plain
  // origin with a query string (apps/desktop has no router) — computed as
  // an initializer, not set from an effect, so opening straight to
  // Settings -> Billing on that reload doesn't cascade an extra render.
  const [overlay, setOverlay] = useState<Overlay>(() => (
    new URLSearchParams(window.location.search).get("settings") === "billing" ? "settings" : null
  ));
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [wsMenu, setWsMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [huddleNote, setHuddleNote] = useState(false);
  const [sidePanel, setSidePanel] = useState<"work" | "site" | null>(null);
  // Set by a deliverable card's "View" action in chat: opens the panel
  // straight to that document's preview, not just the Package tab in general.
  const [previewDeliverableId, setPreviewDeliverableId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem("deedwell.panelW"));
    return saved >= 320 ? saved : 460;
  });
  const [panelMax, setPanelMax] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"usage" | "billing">(() => (
    new URLSearchParams(window.location.search).get("settings") === "billing" ? "billing" : "usage"
  ));
  const [billingBanner, setBillingBanner] = useState<"success" | "cancel" | null>(() => {
    const b = new URLSearchParams(window.location.search).get("billing");
    return b === "success" || b === "cancel" ? b : null;
  });
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("settings")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  useEffect(() => { localStorage.setItem("deedwell.panelW", String(panelWidth)); }, [panelWidth]);
  useEffect(() => {
    if (!panelMax) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanelMax(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelMax]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { return {}; }
  });
  const sseRef = useRef<SSESubscription | null>(null);
  // Coalesce refresh storms (SSE bursts) into one fetch per 250ms window.
  const refresh = useCallback(() => {
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setRefreshTick((t) => t + 1);
    }, 250);
  }, []);

  // A fresh load with no localStorage token might still carry a valid
  // deedwell.org session cookie (e.g. arriving here right after logging in
  // on the marketing site) — check once before falling back to the login
  // screen.
  useEffect(() => {
    if (api.getToken()) return;
    let cancelled = false;
    api.me().then(() => { if (!cancelled) setAuthed(true); }).catch(() => { /* no cookie session either — stay logged out */ });
    return () => { cancelled = true; };
  }, []);

  // ---- session / org bootstrap -------------------------------------------
  useEffect(() => {
    if (!authed) { setOrgs(null); setOrg(null); return; }
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; api.setToken(null); setAuthed(false); }, 10000);
    api.me().then(({ organizations, isPlatformAdmin: platformAdmin }) => {
      if (timedOut) return;
      clearTimeout(timeout);
      setOrgs(organizations);
      setIsPlatformAdmin(platformAdmin);
      const saved = organizations.find((o) => o.id === localStorage.getItem(ORG_KEY));
      if (saved) setOrg(saved);
      else if (organizations.length === 1) setOrg(organizations[0]!);
    }).catch(() => {
      if (timedOut) return;
      clearTimeout(timeout);
      // Couldn't verify the session (expired token or a network/proxy failure) —
      // fall back to the login screen instead of spinning forever.
      api.setToken(null);
      setAuthed(false);
    });
    return () => clearTimeout(timeout);
  }, [authed]);

  // ---- workspace data -----------------------------------------------------
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    api.getWorkspace(org.id).then((w) => {
      if (cancelled) return;
      setChannels(w.channels);
      setTeammates(w.teammates);
      setRuns(w.runs);
      setSites(w.sites);
      setMembers(w.members);
      setProjects(w.projects);
      setApprovals(w.approvals);
      setWorkspaceLoaded(true);
      // Startup: most recent conversation, else Maya's DM (spec §11).
      setActiveId((current) => {
        if (current && w.channels.some((ch) => ch.id === current)) return current;
        const withMessages = w.channels.filter((ch) => ch.last_message_at);
        withMessages.sort((a, b) => (b.last_message_at! > a.last_message_at! ? 1 : -1));
        return withMessages[0]?.id
          ?? w.channels.find((ch) => ch.key === "dm:core.executive_assistant")?.id
          ?? w.channels[0]?.id ?? null;
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [org, refreshTick]);
  useEffect(() => { setWorkspaceLoaded(false); }, [org?.id]);

  // ---- realtime -----------------------------------------------------------
  useEffect(() => {
    if (!org) return;
    const token = api.getToken();
    if (!token) return;
    sseRef.current = subscribeSSE(`${api.API_URL}/v1/orgs/${org.id}/events`, token, (data) => {
      try {
        const event = JSON.parse(data) as WorkflowEvent;
        if (event.type === "run_updated" || event.type === "message_created") refresh();
      } catch { /* ignore */ }
    });
    const poll = setInterval(refresh, 10000);
    return () => { sseRef.current?.close(); clearInterval(poll); };
  }, [org, refresh]);

  // ---- artifact side panel data ------------------------------------------
  const active = channels.find((c) => c.id === activeId) ?? null;
  const activeRuns = useMemo(
    () => (active?.project_id ? runs.filter((r) => r.project_id === active.project_id) : []),
    [runs, active]
  );
  const activeSite = useMemo(
    () => (active?.project_id ? sites.find((s) => s.project_id === active.project_id) ?? null : null),
    [sites, active]
  );
  useEffect(() => {
    if (sidePanel !== "work" || !org || !activeRuns[0]) { setRunDetail(null); return; }
    let cancelled = false;
    api.getRun(org.id, activeRuns[0].id).then((d) => { if (!cancelled) setRunDetail(d); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sidePanel, org, activeRuns[0]?.id, activeRuns[0]?.updated_at, refreshTick]);

  // The workspace panel opens automatically for project channels — grant
  // applications AND website builds (workspace spec §2); the conversation
  // stays on the left.
  useEffect(() => {
    setSidePanel(
      active?.project_type === "grant_application" || active?.project_type === "website" ? "work" : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---- unread tracking ----------------------------------------------------
  useEffect(() => {
    if (!active?.last_message_at) return;
    setSeen((prev) => {
      const next = { ...prev, [active.id]: active.last_message_at! };
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, [active?.id, active?.last_message_at]);
  const isUnread = (c: ChannelInfo) =>
    !!c.last_message_at && c.id !== activeId && (seen[c.id] ?? "") < c.last_message_at;

  // ---- gates --------------------------------------------------------------
  if (!authed) return <LoginView onAuthed={() => setAuthed(true)} />;
  if (!orgs) return <LoadingScreen label="Signing you in…" />;
  if (!org) {
    return (
      <OrgSetupView
        organizations={orgs}
        onSelect={(o) => { localStorage.setItem(ORG_KEY, o.id); setOrg(o); }}
        onCreated={() => api.me().then(({ organizations }) => setOrgs(organizations))}
      />
    );
  }

  if (!workspaceLoaded && channels.length === 0) {
    return <LoadingScreen label={`Opening ${org.name}…`} />;
  }

  const mateMap = new Map(teammates.map((t) => [t.agentKey, t]));
  const filter = sidebarFilter.trim().toLowerCase();
  const match = (label: string) => !filter || label.toLowerCase().includes(filter);
  const starred = channels.filter((c) => c.starred && match(c.name));
  const roomChannels = channels.filter((c) => c.kind !== "dm" && !c.starred && match(c.name));
  const dms = channels.filter((c) => c.kind === "dm" && !c.starred);
  const recents = [...channels]
    .filter((c) => c.last_message_at && match(c.name))
    .sort((a, b) => (b.last_message_at! > a.last_message_at! ? 1 : -1))
    .slice(0, 5);

  const openChannel = (id: string) => { setActiveId(id); setOverlay(null); };
  const openProjectChannel = (projectId: string) => {
    const ch = channels.find((c) => c.project_id === projectId);
    if (ch) openChannel(ch.id);
  };
  const toggleStar = async (c: ChannelInfo) => {
    await api.starChannel(org.id, c.id, !c.starred).catch(() => undefined);
    refresh();
  };
  const newConversation = async () => {
    const name = window.prompt("Name the new channel (it becomes a shared project room):");
    if (!name?.trim()) return;
    const created = await api.createChannel(org.id, name.trim());
    refresh();
    setActiveId(created.channelId);
  };

  const latestRunStatus = activeRuns[0]?.status;
  const pendingCount = approvals.filter((a) => a.status === "pending").length;
  const STEP_LABELS: Record<string, string> = {
    parse_document: "Naomi is reading the announcement…",
    research_sources: "David is reading the funder's linked pages…",
    extract_requirements: "Naomi is extracting the requirements…",
    eligibility_check: "Grace is verifying eligibility…",
    bid_no_bid: "Amara is checking funding fit…",
    plan_application: "Daniel is planning the application…",
    draft_sections: "Sophia is preparing a draft…",
    build_budget: "Michael is building the budget…",
    build_logic_model: "Ingrid is shaping the logic model…",
    review_panel: "The reviewer panel is scoring the draft…",
    final_compliance: "Naomi is running compliance checks…",
    export_full: "Maya is assembling the package…",
    discovery: "Ava is reviewing what we know about you…",
    intake_brief: "Ava is drafting the website brief…",
    generate_content: "Emma is writing the pages…",
    apply_patch: "Noah is applying your change…",
    build_release: "James is building and testing the preview…",
  };
  const workingRun = activeRuns.find((r) => ["pending", "running"].includes(r.status));
  const waitingRun = activeRuns.find((r) => ["waiting_for_info", "waiting_approval"].includes(r.status));
  const working = workingRun
    ? { runId: workingRun.id, label: STEP_LABELS[workingRun.current_step] ?? "The team is working…", waiting: false }
    : waitingRun
      ? {
          runId: waitingRun.id,
          label: waitingRun.status === "waiting_for_info"
            ? "The team is waiting on your answers — see the form above"
            : "Waiting for your approval — nothing proceeds without it",
          waiting: true,
        }
      : null;
  const statusLine = activeRuns[0]
    ? activeRuns[0].definition.startsWith("website")
      ? latestRunStatus === "completed" ? "Website up to date" : "Website work in progress"
      : latestRunStatus === "completed" ? "Application complete" : "Grant application in progress"
    : null;
  const lastUpdated = activeRuns[0]
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(activeRuns[0].updated_at).getTime()) / 60000);
        return mins < 2 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ago`;
      })()
    : null;

  return (
    <div className="shell">
      {/* ---- workspace rail (spec §2) ---- */}
      <nav className="rail" aria-label="Workspaces">
        <div className="logo" title="Deedwell"><Icon name="leaf" size={24} /></div>
        {orgs.map((o) => (
          <button
            key={o.id}
            className={`org-avatar ${o.id === org.id ? "active" : ""}`}
            title={o.name}
            onClick={() => { localStorage.setItem(ORG_KEY, o.id); setOrg(o); setActiveId(null); }}
          >
            {o.name.slice(0, 2).toUpperCase()}
          </button>
        ))}
        <button className="org-avatar add" title="Add or join a workspace" onClick={() => setOverlay("orgs")}>+</button>
        <div className="spacer" />
        <div style={{ position: "relative" }}>
          <button className="profile" title="You" aria-label="Your profile" onClick={() => setProfileMenu((v) => !v)}>
            <Avatar id="you" name="You" size={44} presence />
          </button>
          {profileMenu && (
            <div className="menu" style={{ left: 50, bottom: 0 }}>
              <button onClick={() => { setProfileMenu(false); setOverlay("orgs"); }}>Switch workspace</button>
              {isPlatformAdmin && (
                <button onClick={() => { setProfileMenu(false); setOverlay("platform-admin"); }}>Platform Admin</button>
              )}
              <div className="sep" />
              <button onClick={() => {
                void api.logout().catch(() => undefined);
                api.setToken(null); setAuthed(false);
              }}>Sign out</button>
            </div>
          )}
        </div>
      </nav>

      {/* ---- conversation sidebar (spec §3) ---- */}
      <nav className="convo-sidebar" aria-label="Conversations">
        <div className="ws-head">
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button className="ws-name" onClick={() => setWsMenu((v) => !v)} style={{ background: "none", border: "none", width: "100%" }}>
              <span>{org.name}</span> ▾
            </button>
            {wsMenu && (
              <div className="menu" style={{ top: 34, left: 0 }}>
                <button onClick={() => { setWsMenu(false); setOverlay("passport"); }}>Organization information</button>
                <button onClick={() => { setWsMenu(false); setOverlay("grants"); }}>Grants overview</button>
                <button onClick={() => { setWsMenu(false); setOverlay("website"); }}>Website overview</button>
                <button onClick={() => { setWsMenu(false); setOverlay("approvals"); }}>Approvals</button>
                <button onClick={() => { setWsMenu(false); setSettingsTab("usage"); setOverlay("settings"); }}>Settings</button>
                <div className="sep" />
                <button onClick={() => setWsMenu(false)}>Members ({members.length})</button>
              </div>
            )}
          </div>
          <button className="icon-btn" title="Notifications" aria-label="Notifications">
            <Icon name="bell" size={17} />
            {pendingCount > 0 && (
              <span className="presence" style={{ right: 4, top: 4, bottom: "auto" }} aria-label={`${pendingCount} items waiting`} />
            )}
          </button>
        </div>
        <div className="convo-search">
          <div className="search-box">
            <span aria-hidden="true">🔍</span>
            <input
              aria-label="Search conversations" placeholder="Search"
              value={sidebarFilter} onChange={(e) => setSidebarFilter(e.target.value)}
              style={{ flex: 1 }}
            />
            <kbd>⌘K</kbd>
          </div>
        </div>
        <div className="convo-scroll">
          {starred.length > 0 && (
            <Section title="Starred">
              {starred.map((c) => (
                <ChannelItem key={c.id} c={c} mateMap={mateMap} active={activeId === c.id}
                  unread={isUnread(c)} onOpen={openChannel} onStar={toggleStar} />
              ))}
            </Section>
          )}
          <Section title="Channels" onAdd={newConversation}>
            {roomChannels.map((c) => (
              <ChannelItem key={c.id} c={c} mateMap={mateMap} active={activeId === c.id}
                unread={isUnread(c)} onOpen={openChannel} onStar={toggleStar} />
            ))}
          </Section>
          <Section title="AI Teammates">
            {teammates.filter((t) => match(t.name) || match(t.role)).map((t) => {
              const c = dms.find((d) => d.agent_key === t.agentKey)
                ?? channels.find((d) => d.agent_key === t.agentKey);
              if (!c) return null;
              return (
                <ChannelItem key={c.id} c={c} mateMap={mateMap} active={activeId === c.id}
                  unread={isUnread(c)} onOpen={openChannel} onStar={toggleStar} />
              );
            })}
          </Section>
          <Section title="People">
            {members.filter((m) => match(m.display_name)).map((m) => (
              <div key={m.id} className="convo-item" title="Direct messages between people arrive in a later phase" style={{ cursor: "default" }}>
                <Avatar id={m.id} name={m.display_name} size={26} presence />
                <span className="label"><strong style={{ fontWeight: 550 }}>{m.display_name}</strong><span className="role">  {m.role === "owner" ? "you" : m.role}</span></span>
              </div>
            ))}
          </Section>
          {recents.length > 0 && (
            <Section title="Recent">
              {recents.map((c) => (
                <ChannelItem key={`r-${c.id}`} c={c} mateMap={mateMap} active={activeId === c.id}
                  unread={isUnread(c)} onOpen={openChannel} onStar={toggleStar} />
              ))}
            </Section>
          )}
        </div>
      </nav>

      {/* ---- active conversation (spec §4) ---- */}
      <div className="chat-main">
        {active ? (
          <>
            <header className="chat-head">
              {active.kind === "dm" ? (
                <div className="row" style={{ gap: 12 }}>
                  <Avatar id={active.agent_key ?? "dm"} name={active.name} size={40} presence />
                  <div>
                    <div className="title">{mateMap.get(active.agent_key ?? "")?.name ?? active.name}</div>
                    <div className="desc">{mateMap.get(active.agent_key ?? "")?.role ?? "AI teammate"} · online</div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="title"># {active.name} <Icon name="chevron" size={15} /></div>
                  <div className="desc">
                    {statusLine ? (
                      <>
                        <span className="status-dot" aria-hidden="true" /> {statusLine}
                        {lastUpdated && <span style={{ color: "var(--fg-faint)" }}> · Last updated {lastUpdated}</span>}
                      </>
                    ) : (
                      CHANNEL_DESCRIPTIONS[active.key] ??
                        (active.kind === "project" ? "Project channel — the team works here" : "Shared channel")
                    )}
                  </div>
                </div>
              )}
              <div className="seg-control" role="tablist" aria-label="Conversation views">
                <button role="tab" aria-selected={sidePanel === null} className={`seg-btn ${sidePanel === null ? "active" : ""}`} onClick={() => setSidePanel(null)}>
                  Messages
                </button>
                <button role="tab" aria-selected={sidePanel === "work"} className={`seg-btn ${sidePanel === "work" ? "active" : ""}`}
                  onClick={() => setSidePanel("work")}
                  disabled={activeRuns.length === 0 && !activeSite && active.project_type !== "grant_application"
                    && !(active.kind === "dm" && (active.agent_key ?? "").startsWith("grant."))}>
                  Work & artifacts
                </button>
                {activeSite && (
                  <button role="tab" aria-selected={sidePanel === "site"} className={`seg-btn ${sidePanel === "site" ? "active" : ""}`} onClick={() => setSidePanel("site")}>
                    Live website
                  </button>
                )}
                <button role="tab" aria-selected={false} className="seg-btn" title="Huddles arrive in Phase 6" onClick={() => setHuddleNote(true)}>
                  Huddle
                </button>
              </div>
              <button className="icon-btn" aria-label="Conversation options" onClick={() => setWsMenu(false)}>
                <span style={{ letterSpacing: 2, fontWeight: 700 }}>…</span>
              </button>
            </header>
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <ChatView
                  org={org} channel={active} teammates={mateMap}
                  refreshTick={refreshTick} refresh={refresh}
                  onOpenChannel={openChannel}
                  onOpenWork={() => setSidePanel("work")}
                  onViewDeliverable={(id) => { setPreviewDeliverableId(id); setSidePanel("work"); }}
                  working={working}
                  onCancelRun={(runId) => { void api.cancelRun(org.id, runId).then(refresh).catch(() => undefined); }}
                />
              </div>
              {/* ---- contextual artifact panel (spec §6) ---- */}
              {sidePanel && (
                <div
                  className="panel-grip" role="separator" aria-orientation="vertical"
                  aria-label="Resize panel" tabIndex={0}
                  onDoubleClick={() => setPanelWidth(460)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") setPanelWidth((w) => Math.min(w + 24, window.innerWidth * 0.6));
                    if (e.key === "ArrowRight") setPanelWidth((w) => Math.max(w - 24, 320));
                  }}
                  onPointerDown={(e) => {
                    const startX = e.clientX;
                    const startW = panelWidth;
                    const move = (ev: PointerEvent) =>
                      setPanelWidth(Math.min(Math.max(startW + (startX - ev.clientX), 320), window.innerWidth * 0.6));
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }}
                />
              )}
              {sidePanel && (
                <aside className="artifact-side" aria-label="Artifacts"
                  style={{ width: panelMax ? "100%" : panelWidth }}>
                  <div className="artifact-side-head">
                    <strong style={{ fontSize: 13 }}>
                      {sidePanel === "site" ? "Live website"
                        : active.project_type === "grant_application" ? "Application workspace"
                        : active.project_type === "website" ? "Website workspace"
                        : "Work & artifacts"}
                    </strong>

                    <button className="icon-btn" style={{ marginLeft: "auto" }}
                      aria-label={panelMax ? "Exit full view (Esc)" : "Full view"}
                      title={panelMax ? "Exit full view (Esc)" : "Full view"}
                      onClick={() => setPanelMax((v) => !v)}>
                      <Icon name="columns" size={15} />
                    </button>
                    <button className="icon-btn" aria-label="Close panel" onClick={() => { setSidePanel(null); setPanelMax(false); }}>
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                  {sidePanel === "work" ? (
                    active.project_id ? (
                      <GrantWorkspacePanel
                        org={org} projectId={active.project_id} channelId={active.id}
                        refreshTick={refreshTick} refresh={refresh}
                        runDetail={runDetail} teammates={mateMap}
                        projectType={active.project_type ?? "grant_application"}
                        autoPreviewDeliverableId={previewDeliverableId}
                        onAutoPreviewConsumed={() => setPreviewDeliverableId(null)}
                      />
                    ) : active.kind === "dm" && (active.agent_key ?? "").startsWith("grant.") ? (
                      <GcpDmPanel org={org} channelId={active.id} refreshTick={refreshTick} />
                    ) : (
                      <ArtifactPanel org={org} detail={runDetail} />
                    )
                  ) : (
                    <PreviewSurface
                      // Show the newest build, not whatever is published. Keying
                      // off live_version meant that once a site went live the
                      // panel showed the live copy forever — so the change you
                      // just asked for was never the thing on screen.
                      url={activeSite
                        ? api.siteUrl(
                            activeSite.slug,
                            (activeSite.preview_version ?? 0) > (activeSite.live_version ?? 0)
                              ? "preview"
                              : activeSite.live_version ? "live" : "preview"
                          )
                        : null}
                      reloadKey={activeSite
                        ? `${activeSite.preview_version ?? 0}:${activeSite.live_version ?? 0}`
                        : undefined}
                    />
                  )}
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="empty" style={{ margin: "auto" }}>Pick a conversation to get started.</div>
        )}
      </div>

      {/* ---- overlays (spec §10: settings live behind menus) ---- */}
      {overlay && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setOverlay(null); }}>
          <div className="overlay-panel">
            <div className="overlay-head">
              <strong>{overlay === "platform-admin" ? "Platform Admin" : overlay === "settings" ? "Settings" : org.name}</strong>
              <button className="icon-btn" style={{ marginLeft: "auto" }} aria-label="Close" onClick={() => setOverlay(null)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="overlay-body">
              {overlay === "grants" && (
                <GrantsView org={org} projects={projects} onOpenProject={openProjectChannel}
                  onOpenPassport={() => setOverlay("passport")} />
              )}
              {overlay === "passport" && <PassportView org={org} onBack={() => setOverlay(null)} />}
              {overlay === "website" && (
                <WebsitesView org={org} refreshTick={refreshTick} onOpenProject={openProjectChannel} />
              )}
              {overlay === "approvals" && (
                <ApprovalsView org={org} approvals={approvals} refresh={refresh} onOpenProject={openProjectChannel} />
              )}
              {overlay === "orgs" && (
                <OrgSetupView
                  organizations={orgs}
                  onSelect={(o) => { localStorage.setItem(ORG_KEY, o.id); setOrg(o); setActiveId(null); setOverlay(null); }}
                  onCreated={() => api.me().then(({ organizations }) => setOrgs(organizations))}
                />
              )}
              {overlay === "platform-admin" && <PlatformAdminView onBack={() => setOverlay(null)} />}
              {overlay === "settings" && (
                <SettingsView
                  org={org}
                  tab={settingsTab}
                  onTabChange={setSettingsTab}
                  billingBanner={billingBanner}
                  onDismissBanner={() => setBillingBanner(null)}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {huddleNote && active && (
        <HuddleView
          org={org}
          channel={active}
          teammates={mateMap}
          onClose={() => setHuddleNote(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button className="section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ flex: 1 }}>
          {title}
        </button>
        {onAdd && (
          <button className="icon-btn add" aria-label={`New ${title.toLowerCase()} item`} onClick={onAdd} style={{ padding: 4 }}>
            <Icon name="plus" size={13} />
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
}

function ChannelItem({
  c, mateMap, active, unread, onOpen, onStar,
}: {
  c: ChannelInfo;
  mateMap: Map<string, TeammateInfo>;
  active: boolean;
  unread: boolean;
  onOpen: (id: string) => void;
  onStar: (c: ChannelInfo) => void;
}) {
  const mate = c.agent_key ? mateMap.get(c.agent_key) : null;
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <button className={`convo-item ${active ? "active" : ""}`} onClick={() => onOpen(c.id)}>
        {c.kind === "dm" ? (
          <Avatar id={c.agent_key ?? c.id} name={mate?.name ?? c.name} size={26} presence />
        ) : (
          <span className="hash" aria-hidden="true">#</span>
        )}
        <span className="label">
          <strong style={{ fontWeight: active ? 650 : 550 }}>{mate?.name ?? c.name}</strong>
          {mate && <span className="role">  {mate.role}</span>}
        </span>
        {unread && <span className="unread-dot" aria-label="Unread messages" />}
        <span
          className="star" role="button" title={c.starred ? "Unstar" : "Star"}
          onClick={(e) => { e.stopPropagation(); onStar(c); }}
        >
          {c.starred ? "★" : "☆"}
        </span>
      </button>
    </div>
  );
}


function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="auth-wrap" role="status" aria-live="polite">
      <div style={{ textAlign: "center" }}>
        <div className="load-mark" aria-hidden="true"><Icon name="leaf" size={30} /></div>
        <p className="muted" style={{ marginTop: 16 }}>{label}</p>
        <div className="load-bar" aria-hidden="true"><span /></div>
      </div>
    </div>
  );
}
