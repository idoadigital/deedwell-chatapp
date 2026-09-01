import type {
  AgentInfo,
  ApplicationRow,
  ChannelInfo,
  ChatMessage,
  FactConflict,
  MemberInfo,
  SiteDetail,
  SiteRow,
  SubmissionRow,
  TeammateInfo,
  Approval,
  ArtifactDetail,
  OpportunityDetail,
  OpportunityRow,
  Organization,
  OrgFactRow,
  PassportStatus,
  Project,
  RunDetail,
  RunSummary,
  SearchHit,
} from "./types";

const envUrl = (key: string): string | undefined =>
  (import.meta as { env?: Record<string, string> }).env?.[key];

/** Same-origin paths behind the secure proxy; direct dev ports otherwise. */
const onDirectDevPort = typeof window !== "undefined" && ["4173", "5173"].includes(window.location.port);
export const API_URL: string =
  envUrl("VITE_API_URL") ?? (onDirectDevPort ? "http://178.104.188.229:3001" : "/api");

const TOKEN_KEY = "deedwell.session";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  raw = false
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    // A fresh load with no localStorage token (e.g. arriving here after
    // logging in on deedwell.org) still authenticates via the shared
    // session cookie once this app is served from *.deedwell.org.
    credentials: "include",
    headers: {
      ...(token ? { "x-deedwell-token": token } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      /* keep default */
    }
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, message);
  }
  return (raw ? res.text() : res.json()) as Promise<T>;
}

// ---- auth -----------------------------------------------------------------

export const register = (email: string, password: string, displayName: string) =>
  call<{ userId: string; token: string }>("POST", "/v1/auth/register", {
    email,
    password,
    displayName,
  });

export const login = (email: string, password: string) =>
  call<{ userId: string; token: string }>("POST", "/v1/auth/login", { email, password });

export const logout = () => call<{ ok: true }>("POST", "/v1/auth/logout");

export const me = () =>
  call<{ userId: string; isPlatformAdmin: boolean; organizations: Organization[] }>("GET", "/v1/me");

// ---- orgs, projects, facts ------------------------------------------------

export const createOrg = (name: string, slug: string) =>
  call<{ orgId: string }>("POST", "/v1/orgs", { name, slug });

export const listProjects = (orgId: string) =>
  call<{ projects: Project[] }>("GET", `/v1/orgs/${orgId}/projects`);

export const createProject = (orgId: string, name: string, type: Project["type"]) =>
  call<{ projectId: string }>("POST", `/v1/orgs/${orgId}/projects`, { name, type });

export const listFacts = (orgId: string) =>
  call<{ facts: OrgFactRow[] }>("GET", `/v1/orgs/${orgId}/facts`);

export const saveFacts = (orgId: string, facts: Array<{ key: string; value: string }>) =>
  call<{ ok: true; conflicts: string[] }>("POST", `/v1/orgs/${orgId}/facts`, { facts });

export const listFactConflicts = (orgId: string) =>
  call<{ conflicts: FactConflict[] }>("GET", `/v1/orgs/${orgId}/fact-conflicts`);

export const resolveFactConflict = (
  orgId: string,
  conflictId: string,
  resolution: "keep_current" | "use_proposed"
) => call<{ ok: true }>("POST", `/v1/orgs/${orgId}/fact-conflicts/${conflictId}/resolve`, { resolution });

export const extractFacts = (orgId: string, fileId: string) =>
  call<{ written: string[]; conflicts: string[]; documentSummary: string }>(
    "POST",
    `/v1/orgs/${orgId}/files/${fileId}/extract-facts`
  );

export interface LibraryFile {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  created_at: string;
}

export const listLibraryFiles = (orgId: string, projectId: string) =>
  call<{ files: LibraryFile[] }>("GET", `/v1/orgs/${orgId}/files/library?projectId=${projectId}`);

export const linkLibraryFile = (orgId: string, projectId: string, fileId: string) =>
  call<{ ok: true }>("POST", `/v1/orgs/${orgId}/projects/${projectId}/files/${fileId}/link`);

// ---- files & grant slice --------------------------------------------------

export const uploadFile = (
  orgId: string,
  projectId: string,
  filename: string,
  mime: "text/plain" | "text/markdown",
  contentBase64: string
) =>
  call<{ fileId: string }>("POST", `/v1/orgs/${orgId}/projects/${projectId}/files`, {
    filename,
    mime,
    contentBase64,
  });

export const startGrantSlice = (
  orgId: string,
  projectId: string,
  input: { fileId: string; opportunityTitle: string; funder: string; sectionTitle: string }
) =>
  call<{ runId: string; opportunityId: string }>(
    "POST",
    `/v1/orgs/${orgId}/projects/${projectId}/grant-slice`,
    input
  );

// ---- runs, approvals, artifacts -------------------------------------------

export const listRuns = (orgId: string) =>
  call<{ runs: RunSummary[] }>("GET", `/v1/orgs/${orgId}/runs`);

export const getRun = (orgId: string, runId: string) =>
  call<RunDetail>("GET", `/v1/orgs/${orgId}/runs/${runId}`);

export const provideInfo = (
  orgId: string,
  runId: string,
  facts: Array<{ key: string; value: string | string[] | boolean }>
) =>
  call<{ ok: true; accepted: string[]; ignored: string[] }>(
    "POST",
    `/v1/orgs/${orgId}/runs/${runId}/provide-info`,
    { facts }
  );

export const listApprovals = (orgId: string) =>
  call<{ approvals: Approval[] }>("GET", `/v1/orgs/${orgId}/approvals`);

export const decideApproval = (
  orgId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  note?: string
) => call<{ ok: true }>("POST", `/v1/orgs/${orgId}/approvals/${approvalId}`, { decision, note });

export const getArtifact = (orgId: string, artifactId: string) =>
  call<ArtifactDetail>("GET", `/v1/orgs/${orgId}/artifacts/${artifactId}`);

export const getExportMarkdown = (orgId: string, artifactId: string) =>
  call<string>("GET", `/v1/orgs/${orgId}/artifacts/${artifactId}/export`, undefined, true);

export async function getExportBinary(orgId: string, artifactId: string, format: "docx" | "pdf"): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_URL}/v1/orgs/${orgId}/artifacts/${artifactId}/export?format=${format}`, {
    credentials: "include",
    headers: token ? { "x-deedwell-token": token } : {},
  });
  if (!res.ok) throw new ApiError(res.status, `Export (${format}) failed (${res.status})`);
  return res.blob();
}

// ---- agents ---------------------------------------------------------------

export const listAgents = () => call<{ agents: AgentInfo[] }>("GET", "/v1/agents");

// ---- chat -----------------------------------------------------------------

export const getWorkspace = (orgId: string) =>
  call<{
    channels: ChannelInfo[]; teammates: TeammateInfo[]; runs: RunSummary[];
    sites: SiteRow[]; members: MemberInfo[]; projects: Project[]; approvals: Approval[];
  }>("GET", `/v1/orgs/${orgId}/workspace`);

export const listChannels = (orgId: string) =>
  call<{ channels: ChannelInfo[]; teammates: TeammateInfo[] }>("GET", `/v1/orgs/${orgId}/channels`);

export const createChannel = (orgId: string, name: string) =>
  call<{ projectId: string; channelId: string; channelName: string }>(
    "POST", `/v1/orgs/${orgId}/channels`, { name });

export const starChannel = (orgId: string, channelId: string, starred: boolean) =>
  call<{ ok: true }>("POST", `/v1/orgs/${orgId}/channels/${channelId}/star`, { starred });

export const listMessages = (orgId: string, channelId: string) =>
  call<{ messages: ChatMessage[] }>("GET", `/v1/orgs/${orgId}/channels/${channelId}/messages`);

export const sendMessage = (
  orgId: string, channelId: string, body: string,
  fileId?: string | null, clientKey?: string | null, huddleId?: string | null,
  action?: import("./types").GrantActionRef | null
) =>
  call<{ messages: ChatMessage[] }>("POST", `/v1/orgs/${orgId}/channels/${channelId}/messages`, {
    body, fileId: fileId ?? null, clientKey: clientKey ?? null, huddleId: huddleId ?? null,
    action: action ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
  });

export const getGrantWorkspace = (orgId: string, projectId: string) =>
  call<import("./types").GrantWorkspace>("GET", `/v1/orgs/${orgId}/projects/${projectId}/grant-workspace`);

// --- external grant platform (feature-flagged; only used when ws.gcp exists) --

/** Structured Questions-form answer — feeds the same backend state as chat. */
export const answerGcpQuestion = (orgId: string, projectId: string, requestId: string, answer: string) =>
  call<Record<string, unknown>>("POST", `/v1/orgs/${orgId}/projects/${projectId}/gcp-answers`, { requestId, answer });

/** Real platform execution for this channel's conversation: tasks + task events. */
export const getGcpActivity = (orgId: string, channelId: string) =>
  call<import("./types").GcpActivity>("GET", `/v1/orgs/${orgId}/channels/${channelId}/gcp-activity`);

/** Safe research provenance for a finished research task (sources, queries). */
export const getGcpResearchResult = (orgId: string, taskId: string) =>
  call<import("./types").GcpResearchSources>("GET", `/v1/orgs/${orgId}/gcp-tasks/${taskId}/research-result`);

/** Authenticated in-app preview: fetches the deliverable and returns a blob URL. */
export async function previewGcpDeliverable(orgId: string, deliverableId: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_URL}/v1/orgs/${orgId}/gcp-deliverables/${deliverableId}/download`,
    { credentials: "include", headers: token ? { "x-deedwell-token": token } : {} });
  if (!res.ok) throw new ApiError(res.status, "Preview failed");
  return URL.createObjectURL(await res.blob());
}

/** Private authenticated deliverable download (DOCX/PDF), streamed via the API. */
export async function downloadGcpDeliverable(orgId: string, deliverableId: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_URL}/v1/orgs/${orgId}/gcp-deliverables/${deliverableId}/download`,
    { credentials: "include", headers: token ? { "x-deedwell-token": token } : {} });
  if (!res.ok) throw new ApiError(res.status, "Download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const startHuddle = (orgId: string, channelId: string) =>
  call<{ huddleId: string; resumed: boolean; participants?: string[]; voices: boolean }>(
    "POST", `/v1/orgs/${orgId}/huddles`, { channelId });

export const rtcSession = (orgId: string, huddleId: string) =>
  call<{ token: string; wsPath: string; sttAvailable: boolean; voices: boolean }>(
    "POST", `/v1/orgs/${orgId}/huddles/${huddleId}/rtc-session`, {});

export const endHuddle = (orgId: string, huddleId: string) =>
  call<{ ok: true }>("POST", `/v1/orgs/${orgId}/huddles/${huddleId}/end`, {});

/** Fetch synthesized agent speech (audio/wav) with the auth header. */
export async function fetchTtsBlob(orgId: string, agent: string, text: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(
    `${API_URL}/v1/orgs/${orgId}/tts?agent=${encodeURIComponent(agent)}&text=${encodeURIComponent(text.slice(0, 600))}`,
    { credentials: "include", headers: token ? { "x-deedwell-token": token } : {} }
  );
  if (!res.ok) throw new ApiError(res.status, "Voice synthesis unavailable");
  return res.blob();
}

export const cancelRun = (orgId: string, runId: string) =>
  call<{ ok: true }>("POST", `/v1/orgs/${orgId}/runs/${runId}/cancel`, {});

export const uploadChatFile = (
  orgId: string, channelId: string,
  filename: string, mime: string, contentBase64: string
) =>
  call<{ fileId: string; filename: string }>(
    "POST", `/v1/orgs/${orgId}/channels/${channelId}/files`, { filename, mime, contentBase64 });

export const listMembers = (orgId: string) =>
  call<{ members: MemberInfo[] }>("GET", `/v1/orgs/${orgId}/members`);

// ---- Phase 3: passport, discovery, applications ---------------------------

export const getPassport = (orgId: string) =>
  call<PassportStatus>("GET", `/v1/orgs/${orgId}/passport`);

export const grantSearch = (orgId: string, keyword: string) =>
  call<{ source: string; results: SearchHit[] }>("POST", `/v1/orgs/${orgId}/grant-search`, {
    keyword,
  });

export const importOpportunity = (
  orgId: string,
  projectId: string,
  input: {
    title: string;
    funder: string;
    opportunityNumber?: string | null;
    deadline?: string | null;
    fundingMax?: number | null;
    sourceUrl?: string | null;
    source: "manual" | "grants_gov";
  }
) =>
  call<{ opportunityId: string }>(
    "POST",
    `/v1/orgs/${orgId}/projects/${projectId}/opportunities`,
    input
  );

export const listOpportunities = (orgId: string) =>
  call<{ opportunities: OpportunityRow[] }>("GET", `/v1/orgs/${orgId}/opportunities`);

export const getOpportunity = (orgId: string, opportunityId: string) =>
  call<OpportunityDetail>("GET", `/v1/orgs/${orgId}/opportunities/${opportunityId}`);

export const startGrantApplication = (
  orgId: string,
  projectId: string,
  input: { opportunityId: string; fileId: string }
) =>
  call<{ runId: string }>(
    "POST",
    `/v1/orgs/${orgId}/projects/${projectId}/grant-application`,
    input
  );

export const listApplications = (orgId: string) =>
  call<{ applications: ApplicationRow[] }>("GET", `/v1/orgs/${orgId}/applications`);

// ---- Phase 4: websites ----------------------------------------------------

export const SITE_ROUTER_URL: string =
  envUrl("VITE_SITE_ROUTER_URL") ?? (onDirectDevPort ? "http://178.104.188.229:8788" : "/sites");

/** The one place that knows how a hosted site's URL is shaped.
 *  Both /preview/<slug>/ and /live/<slug>/ are served by the site router. */
export const siteUrl = (slug: string, mode: "preview" | "live"): string =>
  `${SITE_ROUTER_URL}/${mode}/${slug}/`;

export const createWebsite = (
  orgId: string,
  projectId: string,
  input: { siteName: string; slug: string; donateUrl?: string | null }
) =>
  call<{ siteId: string; runId: string }>(
    "POST",
    `/v1/orgs/${orgId}/projects/${projectId}/website`,
    input
  );

export const listSites = (orgId: string) =>
  call<{ sites: SiteRow[] }>("GET", `/v1/orgs/${orgId}/sites`);

export const getSite = (orgId: string, siteId: string) =>
  call<SiteDetail>("GET", `/v1/orgs/${orgId}/sites/${siteId}`);

export const updateSite = (orgId: string, siteId: string, instruction: string) =>
  call<{ runId: string }>("POST", `/v1/orgs/${orgId}/sites/${siteId}/update`, { instruction });

export const rollbackSite = (orgId: string, siteId: string, releaseId: string) =>
  call<{ ok: true }>("POST", `/v1/orgs/${orgId}/sites/${siteId}/rollback`, { releaseId });

export const listSubmissions = (orgId: string, siteId: string) =>
  call<{ submissions: SubmissionRow[] }>("GET", `/v1/orgs/${orgId}/sites/${siteId}/submissions`);

export const recordOutcome = (
  orgId: string,
  applicationId: string,
  input: { status: string; awardAmount?: number | null; feedback?: string; lessons?: string }
) => call<{ ok: true }>("POST", `/v1/orgs/${orgId}/applications/${applicationId}/outcome`, input);

// ---- Platform admin: the platform-wide developer API (routes-admin.ts) ---
// Not org-scoped — these manage the single set of keys/webhooks that back
// the external AI website-building integration's read access across every
// nonprofit's site data, gated on the current user's isPlatformAdmin flag
// (see me() above), not any org membership.

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface WebhookRow {
  id: string;
  url: string;
  description: string | null;
  event_types: string[];
  is_active: boolean;
  created_at: string;
}

export const listApiKeys = () => call<{ apiKeys: ApiKeyRow[] }>("GET", "/v1/admin/api-keys");

export const createApiKey = (name: string, scopes: string[]) =>
  call<{ id: string; key: string }>("POST", "/v1/admin/api-keys", { name, scopes });

export const revokeApiKey = (id: string) => call<{ ok: true }>("DELETE", `/v1/admin/api-keys/${id}`);

export const listWebhooks = () => call<{ webhooks: WebhookRow[] }>("GET", "/v1/admin/webhooks");

export const createWebhook = (url: string, eventTypes: string[], description?: string) =>
  call<{ id: string; secret: string }>("POST", "/v1/admin/webhooks", { url, eventTypes, description });

export const deleteWebhook = (id: string) => call<{ ok: true }>("DELETE", `/v1/admin/webhooks/${id}`);

export const testWebhook = (id: string) => call<{ ok: true }>("POST", `/v1/admin/webhooks/${id}/test`);
