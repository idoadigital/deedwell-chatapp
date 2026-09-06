import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { audit, tenantFileKey, uuidv7, withContext, loadMissionProfile, missionProfileBlock } from "@deedwell/database";
import { debitTokens, getBalance, loadStripeConfig } from "@deedwell/billing-domain";
import { runAgentTask } from "@deedwell/agent-runtime";
import { AgentDefinition, IntentOutput, RESERVED_SITE_SLUGS, type GrantActionRef, type OrgFact } from "@deedwell/schemas";
import { GRANT_FULL_WORKFLOW, writeOrgFact } from "@deedwell/grant-domain";
import { WEBSITE_BUILD_WORKFLOW, WEBSITE_UPDATE_WORKFLOW } from "@deedwell/website-domain";
import { readProviderKey } from "@deedwell/content-domain";
import { canStartCampaign, startCampaign } from "./content-campaigns.js";
import type { Deps } from "./bootstrap.js";
import { recordEvent, recordSource, setWorkspace } from "./workspace.js";
import { DEFAULT_CHANNELS, MAYA_WELCOME, TEAMMATES, teammateByKey } from "./teammates.js";
import { resolveInfoRequest } from "./fact-fields.js";
import { gcpRoutesChannel, handleGcpTurn } from "./gcp/turns.js";
import { onAgentClarify, onUserMessage } from "./proactive/candidates.js";

/**
 * The Executive Assistant: conversational entry point (BRD §4.1). It maps a
 * user's message to ONE typed intent (model-routed; rule-based under the mock
 * provider) — execution is always deterministic server code below, and every
 * consequential step still runs through workflows and approval gates.
 */
export const executiveAssistant: AgentDefinition = AgentDefinition.parse({
  agentKey: "core.executive_assistant",
  version: 1,
  displayName: "Maya — Executive Assistant",
  team: "core",
  role: "Executive Assistant: conversational entry point, routes work to the right team",
  instructions: `ROLE: You are Maya, the Executive Assistant of the user's AI team at
Deedwell, a workspace for nonprofit organizations. Read the user's message and the
workspace context, then choose exactly one action. Execution is deterministic server
code — your job is understanding, routing, and clear communication. When the team is
waiting for information, map the user's reply onto the requested fact keys.

MISSION PROFILE: the mission_profile block is what this organization has told Deedwell
about itself — its details, mission, brand style, and the notes and documents in its
Knowledge Base. Every teammate works from it. Use it: call the organization by its name,
ground answers in its mission and programs, match its brand voice, and never ask for
something the profile already holds (an EIN, website, mission, colours…) — when the team
is waiting for a fact that is already in the profile, map it from there. Do not invent
anything the profile does not say; if it is missing, say so or ask.

IDENTITY: context.speaker is who YOU are in this conversation — in teammate DMs that
is another teammate, not Maya, and every word you write is in that teammate's voice.
context.teammates lists the whole AI team by name and role. When asked your name or
who you are, use "answer" with context.speaker's exact name and role, identified as an
AI teammate. You DO have a name — never say otherwise. When asked about the team,
name the actual teammates.

CAPABILITIES: the team can search for grants, start a grant application from search
results, build the organization's website, update it (text, pictures, layout), design
social media posts, flyers, guides and event graphics ("create_content"), record
organizational facts, take approve/reject decisions, and report status. When the user asks what you or the
team can do — including broad replies like "everything" or "give me a list" — use
"answer" and list these concretely. Never respond to that question with "clarify".
Never volunteer this list when the user didn't ask for it.

SMALL TALK: greetings and social messages ("hi", "how was your day", "thanks") get a
brief, warm "answer" — one or two sentences, nothing more. No capabilities list, no
task push, no clarifying question. Don't claim human experiences or feelings; a light
acknowledgment is right ("All good here — ready when you are.").

VOICE (applies to "answer" text and "clarify" questions): Warm, direct, and plain-spoken —
a capable colleague, not a call center. Lead with the answer or the decision needed, then
at most a sentence or two of context. Short sentences; no jargon the user didn't use
first. No filler openers ("Great question!", "Absolutely!", "I'd be happy to..."), no
apologizing unless something actually went wrong, and never pad a reply to keep the
conversation going — one useful message beats three chatty ones.

HONESTY OVER AGREEMENT: Never invent search results, approvals, or organizational facts.
Do not endorse a user's plan or claim just because they stated it confidently — if the
workspace context contradicts them (a deadline passed, eligibility failed, a task
errored), say so plainly and kindly. If the user pushes back on something the context
shows is correct, hold your position politely and point to the evidence instead of
capitulating. State uncertainty explicitly ("the workspace doesn't show...") rather than
guessing. Prefer "clarify" over guessing when a request is ambiguous or destructive.
context.now is the actual current date and time (UTC) — use it for anything
date-related (today's date, deadlines, how long ago something happened). NEVER state a
date or time from memory.

WHAT YOU ARE: You and your teammates are AI agents. Never claim to be human, to have
feelings about the work, or to have done anything outside this workspace. If a request is
beyond the team's abilities, say so directly instead of improvising.

AUTHORITY ORDER (highest wins): (1) platform security rules and this output contract;
(2) workflow and approval gates — never suggest a gated step can be skipped; (3) the
user's stated preferences this session for tone, length, or detail; (4) the default
voice above.

RESPONSE CONTRACT — before choosing an action, consult the provided context:
recentTranscript (what was already said), knownArtifacts and knownUrls (what the team
already produced, including website preview/live links), taskState (what is running,
waiting, done, or failed), projectMemory (summary, decisions, status), relevantHistory.
NEVER ask the user for information that appears there — especially links the team itself
generated: if asked about "the website you built" or "the link", use the "answer" action
and give the URL from knownUrls, stating what you found. Acknowledge prior decisions
instead of re-asking. Only ask for things that are genuinely missing.

ACTIVE APPLICATION RULES: context.pendingIntent (when present) is the user's saved
application intent — the exact grant (title, opportunity number, details URL) and what is
blocking it. context.lastAssistantRequest is what the team most recently asked the user for.
Interpret follow-up questions ("where do I find it?", "the announcement document", "that
grant", "apply for it") against these BEFORE anything else. If the user asks where to find a
document the team requested, use "answer": name the exact grant and opportunity number,
point to its details link, and confirm their selection is already saved — never reply with a
generic "which document do you mean?". Only ask a clarifying question when two or more
concrete candidates remain, and then name the actual options. NEVER repeat a
clarification: check recentTranscript — if your previous message already asked the user
something and they answered (even just "yes"), act on your original request instead of
asking again or asking them to confirm a confirmation. This applies everywhere: never
ask the same clarifying question twice in a row — if your previous clarification did
not resolve the ambiguity, use "answer" with your best understanding, or with the
team's capabilities, instead of re-asking.`,
  allowedTools: [],
  outputSchemaRef: "intent",
  maxOutputRetries: 2,
});

// ---------------------------------------------------------------------------
// Channels & messages
// ---------------------------------------------------------------------------

export interface ChannelRow {
  id: string;
  key: string;
  name: string;
  kind: "team" | "project" | "dm";
  project_id: string | null;
  project_type?: string | null;
  agent_key?: string | null;
}

export interface SearchResultRef {
  index: number; title: string; funder?: string; number?: string | null;
  closeDate?: string | null; sourceUrl?: string; externalId?: string;
}

export function channelSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
}

export async function ensureChannels(client: PoolClient, tenantId: string): Promise<void> {
  // Fast path: when every default, DM, and project channel already exists,
  // skip the ~20 idempotent inserts this used to run on EVERY listing.
  const { rows: counts } = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM channels) AS c, (SELECT COUNT(*)::int FROM projects) AS p`
  );
  if (counts[0].c >= DEFAULT_CHANNELS.length + TEAMMATES.length + counts[0].p) return;
  for (const ch of DEFAULT_CHANNELS) {
    await client.query(
      `INSERT INTO channels (id, tenant_id, key, name, kind)
       VALUES ($1,$2,$3,$4,'team') ON CONFLICT (tenant_id, key) DO NOTHING`,
      [uuidv7(), tenantId, ch.key, ch.name]
    );
  }
  // Teammates are present from workspace creation — one DM conversation each.
  for (const mate of TEAMMATES) {
    await client.query(
      `INSERT INTO channels (id, tenant_id, key, name, kind, agent_key)
       VALUES ($1,$2,$3,$4,'dm',$5) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [uuidv7(), tenantId, `dm:${mate.agentKey}`, mate.name, mate.agentKey]
    );
  }
  const { rows: projects } = await client.query("SELECT id, name FROM projects");
  for (const project of projects) {
    await client.query(
      `INSERT INTO channels (id, tenant_id, key, name, kind, project_id)
       VALUES ($1,$2,$3,$4,'project',$5)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [uuidv7(), tenantId, `project:${project.id}`, channelSlug(project.name), project.id]
    );
  }
  // First-time experience: Maya greets in her DM (interface spec §11).
  const maya = await client.query(
    "SELECT id FROM channels WHERE tenant_id = $1 AND key = 'dm:core.executive_assistant'",
    [tenantId]
  );
  if (maya.rows[0]) {
    const { rows } = await client.query(
      "SELECT 1 FROM messages WHERE channel_id = $1 LIMIT 1", [maya.rows[0].id]
    );
    if (!rows[0]) {
      await insertMessage(client, {
        tenantId, channelId: maya.rows[0].id, authorKind: "agent",
        authorAgent: executiveAssistant.agentKey, body: MAYA_WELCOME,
      });
    }
  }
}

/** Create a project + its channel (projects appear as channels — spec §8). */
export async function createProjectChannel(
  client: PoolClient,
  tenantId: string,
  userId: string,
  name: string,
  type: "grant_application" | "website" | "other"
): Promise<{ projectId: string; channelId: string; channelName: string }> {
  const projectId = uuidv7();
  await client.query(
    "INSERT INTO projects (id, tenant_id, name, type, created_by) VALUES ($1,$2,$3,$4,$5)",
    [projectId, tenantId, name, type, userId]
  );
  const channelId = uuidv7();
  const channelName = channelSlug(name);
  await client.query(
    `INSERT INTO channels (id, tenant_id, key, name, kind, project_id)
     VALUES ($1,$2,$3,$4,'project',$5)`,
    [channelId, tenantId, `project:${projectId}`, channelName, projectId]
  );
  return { projectId, channelId, channelName };
}

interface PostArgs {
  tenantId: string;
  channelId: string;
  authorKind: "user" | "agent" | "system";
  authorUser?: string | null;
  authorAgent?: string | null;
  body: string;
  metadata?: Record<string, unknown>;
}

export async function insertMessage(client: PoolClient, args: PostArgs): Promise<Record<string, unknown>> {
  const id = uuidv7();
  await client.query(
    `INSERT INTO messages (id, tenant_id, channel_id, author_kind, author_user, author_agent, body, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, args.tenantId, args.channelId, args.authorKind, args.authorUser ?? null,
     args.authorAgent ?? null, args.body, JSON.stringify(args.metadata ?? {})]
  );
  return {
    id, channel_id: args.channelId, author_kind: args.authorKind,
    author_user: args.authorUser ?? null, author_agent: args.authorAgent ?? null,
    body: args.body, metadata: args.metadata ?? {}, created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Context for intent routing
// ---------------------------------------------------------------------------

export async function updateProjectMemory(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  patch: { decision?: string; status?: string; urls?: Record<string, string>; summary?: string }
): Promise<void> {
  await client.query(
    `INSERT INTO project_memories (id, tenant_id, project_id, summary, key_decisions, known_urls, latest_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (project_id) DO UPDATE SET
       summary = CASE WHEN EXCLUDED.summary <> '' THEN EXCLUDED.summary ELSE project_memories.summary END,
       key_decisions = CASE WHEN $8::text IS NULL THEN project_memories.key_decisions
         ELSE project_memories.key_decisions || jsonb_build_array($8::text) END,
       known_urls = project_memories.known_urls || EXCLUDED.known_urls,
       latest_status = CASE WHEN EXCLUDED.latest_status <> '' THEN EXCLUDED.latest_status ELSE project_memories.latest_status END,
       updated_at = now()`,
    [uuidv7(), tenantId, projectId, patch.summary ?? "",
     JSON.stringify(patch.decision ? [patch.decision] : []),
     JSON.stringify(patch.urls ?? {}), patch.status ?? "", patch.decision ?? null]
  );
}

async function buildContext(client: PoolClient, tenantId: string, channel: ChannelRow, currentMessage = "") {
  const org = await client.query("SELECT name FROM organizations WHERE id = $1", [tenantId]);
  const recent = await client.query(
    `SELECT author_kind, author_agent, body, metadata FROM messages
     WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [channel.id]
  );
  let lastSearchResults: SearchResultRef[] = [];
  let lastUploadedFileId: string | null = null;
  let lastAssistantRequest: string | null = null;
  for (const row of recent.rows) {
    const meta = row.metadata as { searchResults?: SearchResultRef[]; fileId?: string };
    if (!lastSearchResults.length && meta.searchResults?.length) lastSearchResults = meta.searchResults;
    if (!lastUploadedFileId && meta.fileId) lastUploadedFileId = meta.fileId;
    if (!lastAssistantRequest && row.author_kind === "agent") lastAssistantRequest = String(row.body).slice(0, 400);
  }
  // Saved-but-blocked application intent survives refreshes and restarts on
  // the project row (reference resolution spec §3, §12).
  const pendingRows = await client.query(
    `SELECT id, name, pending_intent FROM projects
     WHERE pending_intent IS NOT NULL ${channel.project_id ? "AND id = $1" : ""}
     ORDER BY created_at DESC LIMIT 1`,
    channel.project_id ? [channel.project_id] : []
  );
  const pendingIntent = pendingRows.rows[0]
    ? { projectId: pendingRows.rows[0].id, projectName: pendingRows.rows[0].name,
        ...(pendingRows.rows[0].pending_intent as Record<string, unknown>) }
    : null;
  const approvals = await client.query(
    `SELECT a.id, a.kind FROM approvals a JOIN workflow_runs r ON r.id = a.run_id
     WHERE a.status = 'pending' ${channel.project_id ? "AND r.project_id = $1" : ""}
     ORDER BY a.created_at DESC LIMIT 5`,
    channel.project_id ? [channel.project_id] : []
  );
  const waiting = await client.query(
    `SELECT id, status, state->'waiting'->>'payload' AS payload FROM workflow_runs
     WHERE status = 'waiting_for_info' ${channel.project_id ? "AND project_id = $1" : ""}
     ORDER BY updated_at DESC LIMIT 5`,
    channel.project_id ? [channel.project_id] : []
  );
  const sites = await client.query(
    `SELECT s.id, s.slug, s.name, s.status, s.project_id,
            (SELECT version FROM site_releases r WHERE r.id = s.preview_release_id) AS preview_version,
            (SELECT version FROM site_releases r WHERE r.id = s.active_release_id) AS live_version
     FROM sites s ${channel.project_id ? "WHERE s.project_id = $1" : ""}
     ORDER BY s.created_at DESC LIMIT 3`,
    channel.project_id ? [channel.project_id] : []
  );
  const sitesBase = sitesPublicBase();
  const knownUrls: Record<string, string> = {};
  for (const s of sites.rows) {
    if (s.preview_version) knownUrls[`${s.slug}_preview`] = `${sitesBase}/preview/${s.slug}/`;
    if (s.live_version) knownUrls[`${s.slug}_live`] = `${sitesBase}/${s.slug}/`;
  }
  // Project channels see their project; DMs and team channels see the org-wide
  // picture (RLS keeps everything tenant-scoped) so Maya knows all active work.
  const artifacts = (await client.query(
    `SELECT id, type, title, current_version FROM artifacts
     ${channel.project_id ? "WHERE project_id = $1" : ""} ORDER BY updated_at DESC LIMIT 12`,
    channel.project_id ? [channel.project_id] : []
  )).rows;
  const tasks = (await client.query(
    `SELECT r.id, r.definition, r.status, r.current_step, r.last_error, p.name AS project_name
     FROM workflow_runs r JOIN projects p ON p.id = r.project_id
     ${channel.project_id ? "WHERE r.project_id = $1" : ""} ORDER BY r.updated_at DESC LIMIT 6`,
    channel.project_id ? [channel.project_id] : []
  )).rows;
  const memories = (await client.query(
    `SELECT summary, key_decisions, known_urls, latest_status FROM project_memories
     ${channel.project_id ? "WHERE project_id = $1" : ""} ORDER BY updated_at DESC LIMIT 4`,
    channel.project_id ? [channel.project_id] : []
  )).rows;
  const memory = memories[0] ?? null;
  for (const mem of memories) {
    if (mem.known_urls) Object.assign(knownUrls, mem.known_urls);
  }
  // Relevance retrieval: older in-channel messages matching the current ask
  // (keyword FTS now; embedding retrieval slots in behind this same query).
  let relevantHistory: Array<{ author: string; body: string }> = [];
  if (currentMessage.trim().length > 3) {
    try {
      const hits = await client.query(
        `SELECT author_agent, author_kind, body FROM messages
         WHERE channel_id = $1
           AND to_tsvector('english', body) @@ websearch_to_tsquery('english', $2)
         ORDER BY created_at DESC OFFSET 10 LIMIT 5`,
        [channel.id, currentMessage.slice(0, 200)]
      );
      relevantHistory = hits.rows.map((r) => ({
        author: r.author_agent ?? r.author_kind, body: String(r.body).slice(0, 300),
      }));
    } catch { /* malformed query text — retrieval is best-effort */ }
  }
  return {
    recentTranscript: recent.rows.slice(0, 14).reverse().map((r) => ({
      author: r.author_agent ?? r.author_kind, body: String(r.body).slice(0, 400),
    })),
    knownUrls,
    knownArtifacts: artifacts.map((r) => ({ id: r.id, type: r.type, title: r.title, version: r.current_version })),
    taskState: tasks.map((t) => ({ project: t.project_name, definition: t.definition, status: t.status, step: t.current_step, error: t.last_error })),
    projectMemory: memory,
    relevantHistory,
    orgName: org.rows[0]?.name ?? "",
    channelKind: channel.kind,
    projectType: channel.project_type ?? null,
    lastSearchResults,
    lastUploadedFileId,
    pendingIntent,
    lastAssistantRequest,
    pendingApprovals: approvals.rows,
    waitingRuns: waiting.rows.map((r) => {
      let missingFacts: string[] = [];
      try {
        missingFacts = (JSON.parse(r.payload ?? "{}") as { missingFacts?: string[] }).missingFacts ?? [];
      } catch { /* keep empty */ }
      return { id: r.id, status: r.status, missingFacts };
    }),
    hasSite: sites.rows.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Handling a user message
// ---------------------------------------------------------------------------


/** Grants.gov detail URLs embed the opportunity id — recover it when a result
 * reference lost its explicit externalId (older messages, stale UI). */
function deriveExternalId(pick: { externalId?: string | null; sourceUrl?: string | null }): string | null {
  return pick.externalId ?? pick.sourceUrl?.match(/search-results-detail\/(\d+)/)?.[1] ?? null;
}

/** Attempt real announcement retrieval; records events + provenance either
 * way (success, failure — never invented). Returns the stored fileId. */
async function attemptAnnouncementRetrieval(
  deps: Deps,
  client: PoolClient,
  ids: { tenantId: string; userId: string },
  projectId: string,
  pick: { title: string; number?: string | null; funder?: string | null; sourceUrl?: string | null; externalId: string }
): Promise<string | null> {
  const retrievalEventId = await recordEvent(client, {
    tenantId: ids.tenantId, projectId, eventType: "retrieval_started",
    status: "in_progress", title: "Announcement retrieval started",
    summary: `Requesting the full funding announcement for ${pick.number ?? pick.title} from ${sourceLabel(deps)}.`,
    agentKey: "grant.opportunity_researcher",
  });
  const fetched = await deps.grantSource.fetchAnnouncement(pick.externalId).catch(() => null);
  await client.query(
    `UPDATE workspace_events SET status = $2, completed_at = now() WHERE id = $1`,
    [retrievalEventId, fetched ? "completed" : "failed"]
  );
  console.log(JSON.stringify({
    at: "ANNOUNCEMENT_RETRIEVAL", projectId, externalId: pick.externalId,
    ok: !!fetched, chars: fetched?.text.length ?? 0,
  }));
  if (!fetched) {
    await recordSource(client, {
      tenantId: ids.tenantId, projectId, url: pick.sourceUrl ?? null,
      title: `${pick.title} — announcement`, publisher: pick.funder ?? null,
      sourceType: "OFFICIAL_ANNOUNCEMENT", reliability: "UNVERIFIED",
      fetchStatus: "failed", excerpt: "",
    });
    await recordEvent(client, {
      tenantId: ids.tenantId, projectId, eventType: "announcement_retrieval_failed",
      status: "failed", title: "Announcement retrieval failed",
      summary: `${sourceLabel(deps)} did not return usable announcement text for ${pick.number ?? pick.title}. Nothing was analyzed; the application is saved and waiting for the document.`,
      agentKey: "grant.opportunity_researcher",
    });
    return null;
  }
  const fid = uuidv7();
  const content = Buffer.from(fetched.text, "utf8");
  const filename = `${(pick.number ?? "announcement").replace(/[^A-Za-z0-9.-]+/g, "-")}.txt`;
  const storageKey = tenantFileKey(ids.tenantId, fid, filename);
  await deps.storage.put(storageKey, content);
  await client.query(
    `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
     VALUES ($1,$2,$3,$4,'text/plain',$5,$6,$7,$8)`,
    [fid, ids.tenantId, projectId, filename, content.length,
     createHash("sha256").update(content).digest("hex"), storageKey, ids.userId]
  );
  const sourceId = await recordSource(client, {
    tenantId: ids.tenantId, projectId, url: pick.sourceUrl ?? null,
    title: fetched.title, publisher: pick.funder ?? null, fileId: fid,
    sourceType: "OFFICIAL_ANNOUNCEMENT", reliability: "PRIMARY_OFFICIAL",
    fetchStatus: "retrieved",
    excerpt: fetched.text.slice(0, 800),
  });
  await recordEvent(client, {
    tenantId: ids.tenantId, projectId, eventType: "announcement_retrieved",
    status: "completed", title: "Funding announcement retrieved",
    summary: `Retrieved the announcement text (${fetched.text.length.toLocaleString()} characters) from ${sourceLabel(deps)} and stored it in the workspace.`,
    agentKey: "grant.opportunity_researcher", metadata: { fileId: fid, sourceId },
  });
  return fid;
}

interface PendingApplication {
  projectId: string; opportunityId: string; grantTitle: string;
  opportunityNumber?: string | null; sourceUrl?: string | null;
  externalId?: string | null; channelId?: string;
}

/** Clear the blocker and start the durable workflow for a saved application. */
async function startPendingRun(
  deps: Deps,
  client: PoolClient,
  ids: { tenantId: string; userId: string },
  pending: PendingApplication,
  fileId: string,
  trigger: string
): Promise<string> {
  await client.query("UPDATE grant_opportunities SET file_id = $2 WHERE id = $1", [pending.opportunityId, fileId]);
  await setWorkspace(client, pending.projectId, "researching", "Analyzing requirements", null);
  const runId = await deps.engine.start(client, {
    tenantId: ids.tenantId, projectId: pending.projectId, definition: GRANT_FULL_WORKFLOW,
    createdBy: ids.userId, input: { opportunityId: pending.opportunityId, fileId },
  });
  await recordEvent(client, {
    tenantId: ids.tenantId, projectId: pending.projectId, runId,
    eventType: "intent_resumed", status: "completed",
    title: "Application resumed automatically",
    summary: `The announcement became available, so the saved application for "${pending.grantTitle}" resumed without re-selection.`,
  });
  await recordEvent(client, {
    tenantId: ids.tenantId, projectId: pending.projectId, runId,
    eventType: "step:parse_document", status: "in_progress",
    title: "Parsing the announcement document",
    summary: "Extracting the text of the funding announcement and scanning it for prompt-injection content.",
    agentKey: "grant.requirements_analyst",
  });
  console.log(JSON.stringify({
    at: "PENDING_INTENT_RESUMED", projectId: pending.projectId,
    opportunityId: pending.opportunityId, runId, trigger,
  }));
  return runId;
}

const EA = executiveAssistant.displayName;

/** Same shape as the *_domain packages' recordModelUsage helpers, tagged
 *  source:'chat' so Settings -> Usage can tell chat and workflow spend
 *  apart without a schema change. Debits the org's prepaid balance in the
 *  same transaction — see the balance check at the top of the model call
 *  below for what happens once that balance runs out. */
async function recordChatUsage(
  client: PoolClient,
  tenantId: string,
  tokens: number,
  meta: { agentKey: string; channelId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO usage_ledger (id, tenant_id, run_id, kind, quantity, metadata)
     VALUES ($1,$2,NULL,'model_tokens',$3,$4)`,
    [uuidv7(), tenantId, tokens, JSON.stringify({ source: "chat", ...meta })]
  );
  await debitTokens(client, tenantId, tokens);
}


export async function handleUserMessage(
  deps: Deps,
  client: PoolClient,
  ids: { tenantId: string; userId: string },
  channel: ChannelRow,
  body: string,
  fileId: string | null,
  clientKey?: string | null,
  huddleId?: string | null,
  personaOverride?: string | null,
  action?: GrantActionRef | null,
  clientTimezone?: string | null
): Promise<Array<Record<string, unknown>>> {
  if (clientKey) {
    const dup = await client.query(
      `SELECT 1 FROM messages WHERE channel_id = $1 AND metadata->>'clientKey' = $2 LIMIT 1`,
      [channel.id, clientKey]
    );
    if (dup.rows[0]) return []; // idempotent resend — already handled
  }
  const out: Array<Record<string, unknown>> = [];
  // In a DM, the teammate you're talking to answers; elsewhere Maya coordinates.
  const persona = personaOverride
    ?? (channel.kind === "dm" && channel.agent_key ? channel.agent_key : executiveAssistant.agentKey);
  const say = async (text: string, metadata: Record<string, unknown> = {}, agent = persona) => {
    out.push(await insertMessage(client, {
      tenantId: ids.tenantId, channelId: channel.id, authorKind: "agent",
      authorAgent: agent, body: text,
      metadata: huddleId ? { ...metadata, huddleId } : metadata,
    }));
  };

  out.push(await insertMessage(client, {
    tenantId: ids.tenantId, channelId: channel.id, authorKind: "user",
    authorUser: ids.userId, body,
    metadata: {
      ...(fileId ? { fileId } : {}), ...(clientKey ? { clientKey } : {}),
      ...(huddleId ? { huddleId } : {}),
    },
  }));
  // Proactive messaging: the user speaking here answers anything an agent
  // proactively said in this channel, and refreshes their presence.
  await onUserMessage(client, { tenantId: ids.tenantId, userId: ids.userId, channelId: channel.id }).catch(() => undefined);

  // The user's timezone: taken from the client when sent (and remembered),
  // otherwise the last known value — voice huddle turns carry no payload.
  let timezone = validTimezone(clientTimezone);
  if (timezone) {
    await client.query(
      "UPDATE users SET timezone = $2 WHERE id = $1 AND timezone IS DISTINCT FROM $2",
      [ids.userId, timezone]
    );
  } else {
    const stored = await client.query("SELECT timezone FROM users WHERE id = $1", [ids.userId]);
    timezone = validTimezone(stored.rows[0]?.timezone);
  }

  // External grant platform (feature-flagged): grant-team DMs and platform-
  // bound project channels run on the durable GCP workflow engine — same
  // teammates, same cards, different engine underneath. Everything else
  // (Maya, team channels, the website team, huddles) is untouched, and with
  // the platform unconfigured this branch never runs.
  if (deps.gcp && await gcpRoutesChannel(deps, client, channel)) {
    const handled = await handleGcpTurn(deps, client, ids, channel, body, fileId, out);
    if (handled) return out;
  }

  const contextStart = Date.now();
  const context = await buildContext(client, ids.tenantId, channel, body);
  if (fileId) context.lastUploadedFileId = fileId;
  // Observability: what context was actually loaded for this response.
  console.log(JSON.stringify({
    at: "agent_context", channelId: channel.id, projectId: channel.project_id,
    transcript: context.recentTranscript.length, artifacts: context.knownArtifacts.length,
    urls: Object.keys(context.knownUrls).length, retrieved: context.relevantHistory.length,
    tasks: context.taskState.length, hasMemory: !!context.projectMemory,
    ms: Date.now() - contextStart,
  }));

  // A saved application intent blocked on a document resumes automatically the
  // moment the file arrives — the user never repeats "apply for #N" (spec §12).
  if (fileId && context.pendingIntent && (context.pendingIntent as { type?: string }).type === "start_application") {
    const pending = context.pendingIntent as unknown as PendingApplication;
    const runId = await startPendingRun(deps, client, ids, pending, fileId, "file_upload");
    await say(
      `Got it — that's the announcement for "${pending.grantTitle}"${pending.opportunityNumber ? ` (${pending.opportunityNumber})` : ""}. Your application was already saved, so I'm resuming where we left off: parsing the announcement, extracting requirements, and checking eligibility.`,
      { runId, openWorkspace: true, ...(pending.channelId && pending.channelId !== channel.id ? { goToChannelId: pending.channelId } : {}) },
      executiveAssistant.agentKey
    );
    return out;
  }

  // Deterministic reference resolution while an application is blocked: retry
  // commands and "where/what" follow-ups are resolved from the saved intent
  // BEFORE any model routing, so no provider can lose this context.
  if (!fileId && context.pendingIntent && (context.pendingIntent as { type?: string }).type === "start_application") {
    const pending = context.pendingIntent as unknown as PendingApplication;
    const lower = body.toLowerCase();
    const externalId = deriveExternalId(pending);
    const wantsRetry =
      /\b(go\s+(and\s+)?get|get\s+it|fetch|retriev|try\s+again|retry|download\s+it|you\s+(get|download|do)\s+it|do\s+it\s+yourself|get\s+the\s+(announcement|document))\b/.test(lower);
    const asksWhere =
      /\b(where|how)\b[\s\S]{0,60}\b(find|get|download|locate)\b/.test(lower) ||
      /\b(what\s+(did\s+)?you\s+ask|which\s+document|what\s+document|the\s+document\s+you)\b/.test(lower);
    if (wantsRetry || asksWhere) {
      console.log(JSON.stringify({
        at: "REFERENCE_RESOLVED", via: "pending_intent_layer", channelId: channel.id,
        userText: body.slice(0, 120), grantTitle: pending.grantTitle, confidence: 0.97,
        reasonCodes: ["ACTIVE_PENDING_INTENT", wantsRetry ? "RETRY_COMMAND" : "DOCUMENT_FOLLOWUP"],
      }));
    }
    if (wantsRetry) {
      if (!externalId) {
        await say(
          `I don't have a machine-readable source for "${pending.grantTitle}"${pending.opportunityNumber ? ` (${pending.opportunityNumber})` : ""}, so I can't fetch it myself. ${pending.sourceUrl ? `Open ${pending.sourceUrl}, download the funding announcement, and upload it here.` : "Download the funding announcement from the funder and upload it here."} Your selection stays saved.`
        );
        return out;
      }
      const fid = await attemptAnnouncementRetrieval(deps, client, ids, pending.projectId, {
        title: pending.grantTitle, number: pending.opportunityNumber,
        sourceUrl: pending.sourceUrl, externalId,
      });
      if (fid) {
        const runId = await startPendingRun(deps, client, ids, pending, fid, "user_retry_command");
        await say(
          `Done — I retrieved the funding announcement for "${pending.grantTitle}"${pending.opportunityNumber ? ` (${pending.opportunityNumber})` : ""} from ${sourceLabel(deps)} and stored it in the workspace. Resuming your application: parsing the announcement, extracting requirements, and checking eligibility.`,
          { runId, openWorkspace: true, ...(pending.channelId && pending.channelId !== channel.id ? { goToChannelId: pending.channelId } : {}) },
          executiveAssistant.agentKey
        );
      } else {
        await say(
          `I tried again and ${sourceLabel(deps)} still didn't return usable announcement text for "${pending.grantTitle}"${pending.opportunityNumber ? ` (${pending.opportunityNumber})` : ""}. ${pending.sourceUrl ? `Open ${pending.sourceUrl}, download the funding announcement (PDF, Word, HTML, or text), and upload it here.` : "Download the funding announcement from the funder and upload it here."} Your application stays saved and resumes the moment the document arrives.`
        );
      }
      return out;
    }
    if (asksWhere) {
      await say(
        `That's the announcement for "${pending.grantTitle}"${pending.opportunityNumber ? `, opportunity ${pending.opportunityNumber}` : ""} — the document I asked you to upload. ${pending.sourceUrl ? `Open the details link (${pending.sourceUrl}) and look for the funding announcement or application package section.` : "Check the funder's opportunity page for the funding announcement section."} Any format works (PDF, Word, HTML, text) — or say "try again" and I'll re-attempt the retrieval myself. Your application selection is already saved.`
      );
      return out;
    }
  }

  let intent: IntentOutput;
  // The Apply button dispatches a structured event with the exact grant — no
  // LLM in the loop for resolution, no reliance on "#1" staying fresh (§11).
  if (action?.type === "start_grant_application") {
    intent = { action: "start_grant_application", resultIndex: action.index ?? 0 };
    console.log(JSON.stringify({
      at: "REFERENCE_RESOLVED", via: "structured_action", channelId: channel.id,
      title: action.title, opportunityNumber: action.number ?? null, confidence: 1,
      reasonCodes: ["UI_STRUCTURED_EVENT"],
    }));
  } else try {
    // Balance gating only applies once billing is actually configured — an
    // env/DB without Stripe wired up behaves exactly as it always has,
    // unmetered (same graceful-degradation reasoning as every other
    // "not configured yet" feature this session).
    const stripeConfig = await loadStripeConfig(client);
    if (stripeConfig && (await getBalance(client, ids.tenantId)) <= 0) {
      await say("Your token balance is empty — buy more in Settings → Billing to keep chatting.");
      return out;
    }

    // Identity travels with the context: who is speaking in this channel, and
    // the full roster, so agents can answer for themselves and the team.
    const mate = teammateByKey.get(persona);
    const speaker = mate ? { name: mate.name, role: mate.role } : { name: "Maya", role: "Executive Assistant" };
    // Every teammate works from the Mission Profile: what the organization
    // has told Deedwell about itself, its brand, and its knowledge base.
    const profile = await loadMissionProfile(client, deps.storage, ids.tenantId).catch(() => null);
    const result = await runAgentTask<IntentOutput>(
      deps.provider, executiveAssistant,
      `Choose the single best action for the user's message. You are speaking as ${speaker.name}, the ${speaker.role} — any "answer" text is in ${speaker.name}'s voice.`,
      [
        { label: "user_message", content: body },
        ...(profile ? [{ label: "mission_profile", content: missionProfileBlock(profile) }] : []),
        { label: "context", content: JSON.stringify({
          ...context,
          now: formatNow(timezone),
          speaker,
          teammates: TEAMMATES.map((t) => ({ name: t.name, role: t.role, team: t.team })),
        }) },
      ]
    );
    intent = result.output;
    await recordChatUsage(client, ids.tenantId, result.tokensEstimated, {
      agentKey: executiveAssistant.agentKey, channelId: channel.id,
    });
    if (intent.action === "start_grant_application") {
      const wanted = intent.resultIndex;
      const hit = context.lastSearchResults.find((r) => r.index === wanted);
      console.log(JSON.stringify({
        at: "REFERENCE_RESOLVED", via: "intent_router", channelId: channel.id,
        userText: body.slice(0, 120), resolvedTitle: hit?.title ?? null,
        reasonCodes: ["LAST_SEARCH_RESULT_SET"],
      }));
    }
  } catch (err) {
    await say(
      `I hit a problem understanding that (${err instanceof Error ? err.message.slice(0, 120) : "routing error"}). Could you rephrase?`
    );
    return out;
  }

  // Repeat-clarify guard: the model must never ask the same question twice in
  // a row (instructions say so, but this makes it structural, not hoped-for).
  if (intent.action === "clarify" && isRepeatQuestion(intent.question, context.lastAssistantRequest)) {
    console.log(JSON.stringify({
      at: "REPEAT_CLARIFY_BLOCKED", channelId: channel.id, question: intent.question.slice(0, 120),
    }));
    intent = { action: "answer", text: CAPABILITIES_ANSWER };
  }

  switch (intent.action) {
    case "answer":
      await say(intent.text);
      break;
    case "clarify":
      await say(intent.question);
      // The teammate is now waiting on the user; if they walk away, the
      // orchestrator may follow up later as the same teammate.
      await onAgentClarify(client, { tenantId: ids.tenantId, userId: ids.userId, channelId: channel.id, agentKey: persona, question: intent.question, userMessage: body }).catch(() => undefined);
      break;

    case "search_grants": {
      try {
        const results = await deps.grantSource.search(intent.keyword, 8);
        if (!results.length) {
          await say(`I searched ${sourceLabel(deps)} for "${intent.keyword}" and found nothing currently posted. Try a broader phrase?`);
          break;
        }
        const list = results.map((r, i) => ({
          index: i + 1, title: r.title, funder: r.agency, number: r.opportunityNumber,
          closeDate: r.closeDate, sourceUrl: r.sourceUrl, externalId: r.externalId,
        }));
        await say(
          `Here's what ${sourceLabel(deps)} has for "${intent.keyword}". These aren't recommendations yet — eligibility still needs verifying against your organization. Press Apply (or say "apply for #N") and I'll retrieve the announcement, build the requirements matrix, and check eligibility:`,
          { searchResults: list },
          channel.agent_key === "grant.funding_strategist" ? channel.agent_key : "grant.opportunity_researcher"
        );
      } catch (err) {
        await say(`The grant source is unavailable right now (${err instanceof Error ? err.message.slice(0, 100) : "error"}). No results were fabricated — try again shortly.`);
      }
      break;
    }

    case "start_grant_application": {
      const pick: SearchResultRef | undefined =
        action?.type === "start_grant_application"
          ? {
              index: action.index ?? 0, title: action.title, funder: action.funder ?? undefined,
              number: action.number ?? null, closeDate: action.closeDate ?? null,
              sourceUrl: action.sourceUrl ?? undefined, externalId: action.externalId ?? undefined,
            }
          : context.lastSearchResults.find((r) => r.index === intent.resultIndex);
      if (!pick) {
        await say(`I don't see a result #${intent.resultIndex} in this conversation's recent search. Run a search first ("find grants for …").`);
        break;
      }
      // Duplicate guard: a second "apply" in a project channel with a live
      // grant run points at the existing work instead of forking it.
      if (channel.project_id) {
        const running = await activeRunFor(client, channel.project_id, "grant");
        if (running) {
          await say(
            `A grant application is already in progress in this project (${running.status.replace(/_/g, " ")}). I won't start a second one — follow the existing work in the workspace panel.`,
            { runId: running.id, openWorkspace: true }
          );
          break;
        }
      }
      // The project lives in its own channel (spec §7): reuse this one if it's
      // a project channel, otherwise create #<grant-name> and bring the team in.
      let projectId = channel.project_id;
      let targetChannelId = channel.id;
      let createdChannelName: string | null = null;
      if (channel.kind !== "project") {
        const created = await createProjectChannel(
          client, ids.tenantId, ids.userId, pick.title.slice(0, 80), "grant_application"
        );
        projectId = created.projectId;
        targetChannelId = created.channelId;
        createdChannelName = created.channelName;
      }
      const opportunityId = uuidv7();
      await client.query(
        `INSERT INTO grant_opportunities (id, tenant_id, project_id, title, funder, source,
           opportunity_number, agency, deadline, source_url, file_id)
         VALUES ($1,$2,$3,$4,$5,'grants_gov',$6,$5,$7,$8,$9)`,
        [opportunityId, ids.tenantId, projectId, pick.title, pick.funder ?? "Unknown funder",
         pick.number ?? null, pick.closeDate ?? null,
         pick.sourceUrl?.startsWith("http") ? pick.sourceUrl : null, context.lastUploadedFileId]
      );
      await recordEvent(client, {
        tenantId: ids.tenantId, projectId: projectId!, eventType: "workspace_created",
        status: "completed", title: `Grant selected: ${pick.title}`,
        summary: `Application workspace created for "${pick.title}"${pick.number ? ` (${pick.number})` : ""}${pick.funder ? ` from ${pick.funder}` : ""}.`,
        metadata: { opportunityId, opportunityNumber: pick.number ?? null, sourceUrl: pick.sourceUrl ?? null },
      });

      // Retrieve the announcement automatically before asking the user for
      // anything (spec §6–§7): real fetch from the grant source, recorded as a
      // research source either way — success or failure, never invented.
      const externalId = deriveExternalId(pick);
      let announcementFileId = context.lastUploadedFileId;
      if (!announcementFileId && externalId) {
        const fid = await attemptAnnouncementRetrieval(deps, client, ids, projectId!, {
          title: pick.title, number: pick.number, funder: pick.funder,
          sourceUrl: pick.sourceUrl, externalId,
        });
        if (fid) {
          await client.query("UPDATE grant_opportunities SET file_id = $2 WHERE id = $1", [opportunityId, fid]);
          announcementFileId = fid;
        }
      }
      if (!announcementFileId) {
        // Preserve the intent (spec §12): the user never repeats this command.
        await setWorkspace(client, projectId!, "waiting_for_document", "Waiting for the announcement", {
          type: "start_application", opportunityId, grantTitle: pick.title,
          opportunityNumber: pick.number ?? null, sourceUrl: pick.sourceUrl ?? null,
          externalId, channelId: targetChannelId, requestedAt: new Date().toISOString(),
        });
        console.log(JSON.stringify({
          at: "PENDING_INTENT_SAVED", projectId, opportunityId,
          blockedBy: "MISSING_ANNOUNCEMENT_DOCUMENT", title: pick.title,
        }));
        const ask = `I've saved "${pick.title}"${pick.number ? ` (opportunity ${pick.number})` : ""} as your active application. I couldn't retrieve the full announcement automatically${pick.externalId ? "" : " (no machine-readable source id was available)"}. ${pick.sourceUrl?.startsWith("http") ? `Open the details link (${pick.sourceUrl}), download the funding announcement (PDF, Word, HTML, or text all work), and upload it here.` : "Download the funding announcement from the funder and upload it here — PDF, Word, HTML, or text all work."} The moment it arrives I'll continue automatically.`;
        if (createdChannelName) {
          await insertMessage(client, {
            tenantId: ids.tenantId, channelId: targetChannelId, authorKind: "agent",
            authorAgent: executiveAssistant.agentKey, body: ask, metadata: { pendingUpload: true },
          });
          await say(`I've set up #${createdChannelName} for "${pick.title}" and saved your request to apply — one document is needed before the team can start. Details in the channel.`, { goToChannelId: targetChannelId, openWorkspace: true });
        } else {
          await say(ask, { pendingUpload: true, openWorkspace: true });
        }
        break;
      }
      await setWorkspace(client, projectId!, "researching", "Analyzing requirements", null);
      const runId = await deps.engine.start(client, {
        tenantId: ids.tenantId, projectId: projectId!, definition: GRANT_FULL_WORKFLOW,
        createdBy: ids.userId,
        input: { opportunityId, fileId: announcementFileId },
      });
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, actorAgent: executiveAssistant.agentKey,
        action: "workflow.started", entityType: "workflow_run", entityId: runId,
        metadata: { via: "chat", opportunityId },
      });
      await recordEvent(client, {
        tenantId: ids.tenantId, projectId: projectId!, runId,
        eventType: "step:parse_document", status: "in_progress",
        title: "Parsing the announcement document",
        summary: "Extracting the text of the funding announcement and scanning it for prompt-injection content.",
        agentKey: "grant.requirements_analyst",
      });
      const auto = !context.lastUploadedFileId;
      const kickoff = `I've selected "${pick.title}"${pick.number ? `, opportunity ${pick.number}` : ""}.${auto ? " I retrieved the funding announcement automatically and stored it in the workspace." : ""} The team is parsing it, extracting every requirement into the compliance matrix, and checking eligibility against your certified facts. The live timeline is in the workspace panel — I'll come back to you at the go/no-go decision.`;
      if (createdChannelName) {
        await insertMessage(client, {
          tenantId: ids.tenantId, channelId: targetChannelId, authorKind: "agent",
          authorAgent: executiveAssistant.agentKey, body: kickoff, metadata: { runId, openWorkspace: true },
        });
        await say(`I've set up #${createdChannelName} for this application and brought the grant team in — the work continues there.`, { goToChannelId: targetChannelId, runId });
      } else {
        await say(kickoff, { runId, openWorkspace: true });
      }
      break;
    }

    case "build_website": {
      if (channel.project_id) {
        const running = await activeRunFor(client, channel.project_id, "website");
        if (running) {
          await say(
            `The Website Team already has a ${running.definition.replace(/-/g, " ")} in progress (${running.status.replace(/_/g, " ")}). I won't start a second one.`,
            { runId: running.id, openWorkspace: true }
          );
          break;
        }
      }
      let projectId = channel.project_id;
      let siteChannelName: string | null = null;
      let siteChannelId = channel.id;
      if (!projectId) {
        const created = await createProjectChannel(
          client, ids.tenantId, ids.userId, "Website Launch", "website"
        );
        projectId = created.projectId;
        siteChannelName = created.channelName;
        siteChannelId = created.channelId;
      }
      const orgSlugRow = await client.query("SELECT slug, name FROM organizations WHERE id = $1", [ids.tenantId]);
      const baseSlug: string = orgSlugRow.rows[0].slug;
      const siteName: string = intent.siteName ?? orgSlugRow.rows[0].name;
      const siteId = uuidv7();
      let slug = `${baseSlug}-${siteId.slice(0, 4)}`;
      for (const candidate of [baseSlug, `${baseSlug}-site`, `${baseSlug}-${siteId.slice(0, 4)}`]) {
        if (RESERVED_SITE_SLUGS.has(candidate)) continue; // router-owned path segments
        const taken = await client.query("SELECT 1 FROM sites WHERE slug = $1", [candidate]);
        if (!taken.rows[0]) { slug = candidate; break; }
      }
      await client.query(
        `INSERT INTO sites (id, tenant_id, project_id, slug, name, theme, created_by)
         VALUES ($1,$2,$3,$4,$5,'{"palette":"slate","headingFont":"serif"}',$6)`,
        [siteId, ids.tenantId, projectId, slug, siteName, ids.userId]
      );
      const runId = await deps.engine.start(client, {
        tenantId: ids.tenantId, projectId, definition: WEBSITE_BUILD_WORKFLOW, createdBy: ids.userId,
        input: { siteId, siteName, donateUrl: null },
      });
      const kickoff = `Website build started. Ava is drafting the brief and Emma will write the pages from your approved organizational facts. Your address will be ${sitesPublicBase()}/${slug}/ — you'll approve a preview before anything goes live.`;
      if (siteChannelName) {
        await insertMessage(client, {
          tenantId: ids.tenantId, channelId: siteChannelId, authorKind: "agent",
          authorAgent: "website.digital_strategist", body: kickoff, metadata: { runId, siteId },
        });
        await say(`I've created #${siteChannelName} and brought the Website Team in — follow the build there.`, { goToChannelId: siteChannelId, runId });
      } else {
        await say(kickoff, { runId, siteId }, "website.digital_strategist");
      }
      break;
    }

    case "create_content": {
      if (!canStartCampaign()) {
        await say(`The design studio is still finishing another set — give it a minute and ask again.`);
        break;
      }
      if ((process.env.MODEL_PROVIDER ?? "mock") !== "mock" && !(await readProviderKey(deps.appPool, "openai"))) {
        await say(`Image design isn't set up yet — an administrator needs to add an OpenAI API key in Platform Admin.`);
        break;
      }
      const label = { social: "social media designs", flyer: "flyer designs", buying_guide: "guide covers", event_promo: "event graphics" }[intent.kind];
      const { project, done } = await startCampaign(deps, client, { orgId: ids.tenantId, userId: ids.userId, kind: intent.kind, prompt: intent.prompt });
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, action: "content.generate",
        entityType: "content_projects", entityId: String(project.id), metadata: { kind: intent.kind, via: "chat" },
      });
      await say(`On it — designing ${label} for "${intent.prompt.slice(0, 80)}". They'll appear here in a couple of minutes, and in Artifacts and the Content page.`, { contentProjectId: project.id }, "content.designer");
      // The designs land after this request is long gone: post them into
      // the same channel when they do, on their own connection.
      const channelId = channel.id;
      const contentProjectId = String(project.id);
      void done.then(() => withContext(deps.appPool, { tenantId: ids.tenantId, userId: ids.userId }, async (c) => {
        const { rows: proj } = await c.query("SELECT status, error, title FROM content_projects WHERE id = $1", [contentProjectId]);
        const { rows: assets } = await c.query(
          "SELECT id, file_id, caption, post_text FROM content_assets WHERE content_project_id = $1 ORDER BY position", [contentProjectId]
        );
        const okay = proj[0]?.status === "ready" && assets.length > 0;
        await insertMessage(c, {
          tenantId: ids.tenantId, channelId, authorKind: "agent", authorAgent: "content.designer",
          body: okay
            ? `Here are ${assets.length} ${label} for "${proj[0].title}". Approve the ones you like on the Content page to schedule or publish them; they're also saved in Artifacts.`
            : `I couldn't finish those designs${proj[0]?.error ? ` — ${String(proj[0].error).slice(0, 200)}` : ""}.`,
          metadata: okay
            ? { contentProjectId, images: assets.map((a) => ({ assetId: a.id, fileId: a.file_id, caption: a.caption, postText: a.post_text ?? null })) }
            : { contentProjectId },
        });
      })).catch((err) => console.log(JSON.stringify({ at: "chat_content_post_failed", error: String((err as Error).message ?? err).slice(0, 200) })));
      break;
    }

    case "update_website": {
      const site = await client.query(
        `SELECT id, project_id FROM sites ${channel.project_id ? "WHERE project_id = $1" : ""} ORDER BY created_at DESC LIMIT 1`,
        channel.project_id ? [channel.project_id] : []
      );
      if (!site.rows[0]) {
        await say(`There's no website yet — say "build our website" and the team will create one first.`);
        break;
      }
      const inFlight = await activeRunFor(client, site.rows[0].project_id, "website");
      if (inFlight) {
        await say(
          `The Website Team is still working on the previous request (${inFlight.status.replace(/_/g, " ")}). Send this change again once that finishes — I won't queue conflicting edits.`,
          { runId: inFlight.id }
        );
        break;
      }
      const runId = await deps.engine.start(client, {
        tenantId: ids.tenantId, projectId: site.rows[0].project_id,
        definition: WEBSITE_UPDATE_WORKFLOW, createdBy: ids.userId,
        input: { siteId: site.rows[0].id, instruction: intent.instruction },
      });
      await say(`Passing that to Noah on the Website Team. If the request translates into a change, you'll get a new preview here to approve; if not, you'll get the reason.`, { runId });
      break;
    }

    case "provide_info": {
      const waitingRun = context.waitingRuns[0];
      if (!waitingRun) {
        await say(`Nobody on the team is waiting for information right now, so I've not recorded those values. If you want them in your Funding Passport anyway, use the Passport tool in the sidebar.`);
        break;
      }
      const conflicted: string[] = [];
      const recorded: string[] = [];
      for (const fact of intent.facts) {
        const { conflict } = await writeOrgFact(client, {
          tenantId: ids.tenantId, factKey: fact.key, value: fact.value, status: "user_certified",
          certifiedBy: ids.userId,
        });
        if (conflict) conflicted.push(fact.key); else recorded.push(fact.key);
      }
      if (recorded.length) {
        await deps.engine.signal(client, waitingRun.id, "info", { keys: recorded });
      }
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, action: "workflow.info_provided",
        entityType: "workflow_run", entityId: waitingRun.id,
        metadata: { via: "chat", keys: recorded, conflicts: conflicted },
      });
      const parts: string[] = [];
      if (recorded.length) {
        parts.push(`Recorded as user-certified facts: ${recorded.map((k) => k.replace(/_/g, " ")).join(", ")}.`);
      }
      if (conflicted.length) {
        parts.push(`${conflicted.map((k) => k.replace(/_/g, " ")).join(", ")} conflict${conflicted.length === 1 ? "s" : ""} with data already on file — I've flagged that for you to resolve instead of overwriting it.`);
      }
      await say(parts.length ? `${parts.join(" ")} The team is picking the work back up.` : "I didn't record anything from that.");
      break;
    }

    case "approve":
    case "reject": {
      const target = context.pendingApprovals[0];
      if (!target) {
        await say(`There's nothing waiting for approval${channel.kind === "project" ? " in this project" : ""} right now.`);
        break;
      }
      const decision = intent.action === "approve" ? "approved" : "rejected";
      const { rows } = await client.query(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), note = $4
         WHERE id = $1 AND status = 'pending' RETURNING run_id, kind`,
        [target.id, decision, ids.userId, intent.note]
      );
      if (!rows[0]) {
        await say(`That approval was already decided — nothing changed.`);
        break;
      }
      await deps.engine.signal(client, rows[0].run_id, "approval", { approvalId: target.id, decision });
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, action: `approval.${decision}`,
        entityType: "approval", entityId: target.id, metadata: { via: "chat" },
      });
      await say(
        decision === "approved"
          ? `Approved — the team is moving ahead with ${approvalLabel(rows[0].kind)}.`
          : `Understood — ${approvalLabel(rows[0].kind)} was declined and the team has been told.`
      );
      break;
    }

    case "status": {
      const runs = await client.query(
        `SELECT r.status, r.definition, p.name FROM workflow_runs r JOIN projects p ON p.id = r.project_id
         WHERE r.status NOT IN ('completed','cancelled') ORDER BY r.updated_at DESC LIMIT 10`
      );
      const approvals = await client.query(
        `SELECT COUNT(*)::int AS n FROM approvals WHERE status = 'pending'`
      );
      if (!runs.rows.length && !approvals.rows[0].n) {
        await say(`All quiet — no workflows in flight and nothing waiting on you.`);
        break;
      }
      const lines = runs.rows.map(
        (r) => `• ${r.name}: ${String(r.status).replace(/_/g, " ")} (${r.definition.replace(/-/g, " ")})`
      );
      if (approvals.rows[0].n) lines.push(`• ${approvals.rows[0].n} approval(s) waiting for you — say "approve" or check the Approvals tool.`);
      await say(`Here's where things stand:\n${lines.join("\n")}`);
      break;
    }
  }
  return out;
}

/** Duplicate-run guard (spec §7): the same action triggered twice must not
 *  start a second concurrent workflow on the same project. */
export async function activeRunFor(
  client: PoolClient,
  projectId: string,
  definitionPrefix: string
): Promise<{ id: string; status: string; definition: string } | null> {
  const { rows } = await client.query(
    `SELECT id, status, definition FROM workflow_runs
     WHERE project_id = $1 AND definition LIKE $2 || '%'
       AND status IN ('pending','running','waiting_for_info','waiting_approval')
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, definitionPrefix]
  );
  return rows[0] ?? null;
}

function validTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function formatNow(timezone: string | null): string {
  const d = new Date();
  if (timezone) {
    return `${d.toLocaleString("en-US", {
      timeZone: timezone, weekday: "long", year: "numeric", month: "long",
      day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    })} (${timezone})`;
  }
  return `${d.toISOString()} (${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}, UTC)`;
}

const CAPABILITIES_ANSWER =
  `Here's what the team can do:\n` +
  `• Find grants — "find grants for our youth program"\n` +
  `• Apply for one — press Apply on a result or say "apply for #2"; the team retrieves the announcement, builds the requirements matrix, and checks eligibility\n` +
  `• Build your website — "build our website"; you approve the brief and the preview before anything goes live\n` +
  `• Update the website — describe the change and Noah will patch it\n` +
  `• Record organizational facts the team asks for, and take your approve/reject decisions\n` +
  `Say "status" anytime to see what's in flight.`;

/**
 * A clarifying question that (nearly) restates the previous agent message
 * already failed once — re-asking cannot succeed. Token-overlap match, not
 * equality, because the model rephrases ("actions" → "areas").
 */
function isRepeatQuestion(question: string, lastAgentMessage: string | null): boolean {
  if (!lastAgentMessage) return false;
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const asked = tokens(question);
  const previous = tokens(lastAgentMessage);
  if (!asked.size || !previous.size) return false;
  let shared = 0;
  for (const w of asked) if (previous.has(w)) shared++;
  return shared / asked.size >= 0.8;
}

/** Public base for tenant sites (e.g. https://sites.deedwell.org). Published
 *  sites are served at <base>/<slug>/, previews at <base>/preview/<slug>/. */
function sitesPublicBase(): string {
  return process.env.SITES_PUBLIC_BASE ?? "http://178.104.188.229:8788";
}

function sourceLabel(deps: Deps): string {
  return deps.grantSource.name === "grants_gov" ? "Grants.gov" : `the ${deps.grantSource.name} source`;
}

function approvalLabel(kind: string): string {
  return kind === "bid_decision" ? "pursuing this grant"
    : kind === "final_export" ? "the final application export"
    : kind === "publish_site" ? "publishing the website"
    : kind === "section_export" ? "the section export" : kind;
}

// ---------------------------------------------------------------------------
// Engine → channel bridge: workflow milestones become team messages.
// ---------------------------------------------------------------------------

const MILESTONE_STATUSES = new Set(["waiting_for_info", "waiting_approval", "completed", "failed", "suspended_budget"]);
const inflight = new Set<Promise<void>>();

export function attachEngineBridge(deps: Deps): void {
  deps.engine.events.on("event", (event: { type: string; tenantId: string; runId: string; status: string; step: string }) => {
    if (event.type !== "run_updated" || !MILESTONE_STATUSES.has(event.status)) return;
    const p = bridgeMessage(deps, event).catch(() => undefined).then(() => { inflight.delete(p); });
    inflight.add(p);
  });
}

/** Tests await this so bridge messages are visible after engine.drain(). */
export async function bridgeFlush(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

async function bridgeMessage(
  deps: Deps,
  event: { tenantId: string; runId: string; status: string; step: string }
): Promise<void> {
  await withContext(deps.appPool, { tenantId: event.tenantId, userId: null }, async (client) => {
    const run = await client.query(
      `SELECT r.project_id, r.definition, r.state, r.last_error, p.name AS project_name
       FROM workflow_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [event.runId]
    );
    if (!run.rows[0]) return;
    await ensureChannels(client, event.tenantId);
    const channel = await client.query(
      "SELECT id FROM channels WHERE tenant_id = $1 AND project_id = $2",
      [event.tenantId, run.rows[0].project_id]
    );
    if (!channel.rows[0]) return;
    const channelId = channel.rows[0].id;
    const state = run.rows[0].state as Record<string, unknown>;

    let body = "";
    let agent = executiveAssistant.agentKey;
    let metadata: Record<string, unknown> = { runId: event.runId };

    if (event.status === "waiting_for_info") {
      const request = await resolveInfoRequest(client, event.runId);
      const fields = request.fields;
      if (!fields.length) return;
      if (request.context === "website_intake") {
        agent = "website.digital_strategist";
        body = `I have the facts I need about your organization. Now a few choices about how the site should look and what it should ask visitors to do:\n${fields
          .slice(0, 6)
          .map((f) => `• ${f.label}`)
          .join("\n")}${fields.length > 6 ? `\n…and ${fields.length - 6} more below.` : ""}\nNone of these are required — answer what you care about and let the team decide the rest.`;
      } else {
        body = `Before we go further I need a few organizational facts:\n${fields
          .map((f) => `• ${f.label}${f.help ? ` (${f.help})` : ""}`)
          .join("\n")}\nFill in the form below — partial answers are fine, the work resumes as facts arrive. Your answers are recorded as user-certified evidence.`;
      }
      metadata = {
        ...metadata,
        infoRequest: fields,
        infoRequestContext: request.context,
        allowSkip: request.allowSkip,
      };
    } else if (event.status === "waiting_approval") {
      const approval = await client.query(
        `SELECT id, kind, payload FROM approvals WHERE run_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [event.runId]
      );
      if (!approval.rows[0]) return;
      const kind: string = approval.rows[0].kind;
      const payload = approval.rows[0].payload as Record<string, unknown>;
      agent = kind === "bid_decision" ? "grant.funding_strategist"
        : kind === "publish_site" ? "website.qa_deployment"
        : kind === "website_brief" ? "website.digital_strategist"
        : kind === "final_export" ? "grant.reviewer_panel" : "grant.writer";
      body = kind === "website_brief"
        ? `The website brief is ready — goals, audiences, sitemap, and visual direction. Open it in the artifact panel, then say "approve" to start the build, or tell me what to change. Nothing gets built until you approve the plan.`
        : kind === "bid_decision"
        ? `Bid assessment ready: ${String(payload.recommendation ?? "").replace(/_/g, " ")} (${payload.total}/100). ${payload.rationale ?? ""}\nSay "approve" to pursue it or "reject" to pass.`
        : kind === "publish_site"
          ? `The website release is built and previewable${payload.version ? ` (v${payload.version})` : ""}. Say "approve" to publish or "reject" to hold it.`
          : `The application passed internal review${payload.reviewScore ? ` (panel score ${payload.reviewScore})` : ""} and is ready to export. Say "approve" to export or "reject" to send it back for redrafting.`;
      metadata = { ...metadata, approvalId: approval.rows[0].id, approvalKind: kind, approvalPayload: payload };
    } else if (event.status === "completed") {
      const blockingChecks = state.blockingChecks as string[] | undefined;
      body = blockingChecks?.length
        ? `The build finished but validation FAILED — the site was not published and won't be until these are fixed:\n${blockingChecks
            .slice(0, 6).map((c) => `• ${c}`).join("\n")}${blockingChecks.length > 6 ? `\n…and ${blockingChecks.length - 6} more (full test report in the artifact panel).` : ""}\nThe preview shows the current broken state. Tell me what to change, or fix the missing facts and rebuild.`
        : state.exported
        ? `Done — the application package is exported. Open the artifact panel to download it (markdown + budget CSV). A strong application improves your odds; funding is never guaranteed.`
        : state.published === true
          ? `The website is live.`
          : state.published === false
            ? `Noted — the release stays unpublished. Ask me for changes anytime.`
            : state.applied === false
              ? `The Website Team couldn't translate that request: ${state.reason ?? "no reason given"}.`
              : state.outcome === "not_pursued"
                ? `We're passing on this opportunity — it's recorded as not pursued.`
                : `That workflow finished.`;
      if (blockingChecks?.length) {
        metadata = { ...metadata, openWorkspace: true, artifactId: state.testReportArtifactId ?? null };
      }
    } else if (event.status === "failed") {
      body = `Something went wrong and the team stopped after several attempts: ${run.rows[0].last_error ?? "unknown error"}. The run is preserved and can be resumed once the cause is fixed.`;
    } else if (event.status === "suspended_budget") {
      body = `Pausing — this run hit its usage budget. A human needs to review before the team continues.`;
    }
    if (!body) return;
    // Persist durable memory alongside the message (spec: memory is a system,
    // not a prompt hack): decisions, status, and generated URLs survive here.
    const projectId = run.rows[0].project_id;
    const state2 = state as { bid?: { total?: number }; version?: number };
    try {
      if (event.status === "waiting_approval") {
        // A built preview is a generated link the agent must remember even
        // before publishing.
        const sitesBaseW = sitesPublicBase();
        const siteW = await client.query(
          "SELECT slug, preview_release_id FROM sites WHERE project_id = $1 LIMIT 1",
          [projectId]
        );
        const urlsW: Record<string, string> = {};
        if (siteW.rows[0]?.preview_release_id) {
          urlsW[`${siteW.rows[0].slug}_preview`] = `${sitesBaseW}/preview/${siteW.rows[0].slug}/`;
        }
        await updateProjectMemory(client, event.tenantId, projectId, {
          status: `Waiting for approval (${metadata.approvalKind ?? "gate"})`,
          urls: urlsW,
        });
      } else if (event.status === "completed") {
        const sitesBase = sitesPublicBase();
        const site = await client.query(
          "SELECT slug, active_release_id, preview_release_id FROM sites WHERE project_id = $1 LIMIT 1",
          [projectId]
        );
        const urls: Record<string, string> = {};
        if (site.rows[0]?.preview_release_id) urls[`${site.rows[0].slug}_preview`] = `${sitesBase}/preview/${site.rows[0].slug}/`;
        if (site.rows[0]?.active_release_id) urls[`${site.rows[0].slug}_live`] = `${sitesBase}/${site.rows[0].slug}/`;
        await updateProjectMemory(client, event.tenantId, projectId, {
          decision: state.published === true ? `Website published${state2.version ? ` (v${state2.version})` : ""}`
            : state.exported ? "Application package exported after final approval"
            : state.outcome === "not_pursued" ? "Decided not to pursue this opportunity"
            : `Workflow ${run.rows[0].definition} completed`,
          status: `Last completed: ${run.rows[0].definition}`,
          urls,
        });
      } else if (event.status === "failed") {
        await updateProjectMemory(client, event.tenantId, projectId, {
          status: `Needs attention: ${run.rows[0].definition} failed`,
        });
      }
    } catch { /* memory write is best-effort; the message still lands */ }
    await insertMessage(client, {
      tenantId: event.tenantId, channelId, authorKind: "agent", authorAgent: agent, body, metadata,
    });
    deps.engine.events.emit("event", { type: "message_created", tenantId: event.tenantId, channelId } as never);
  });
}
