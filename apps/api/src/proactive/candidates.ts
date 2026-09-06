import type { PoolClient } from "pg";
import { withContext } from "@deedwell/database";
import { ProactiveProposalInput } from "@deedwell/schemas";
import type { Deps } from "../bootstrap.js";
import { executiveAssistant } from "../assistant.js";
import { resolveInfoRequest } from "../fact-fields.js";
import { loadProactivePolicy } from "./policy.js";
import { derivePresence } from "./presence.js";
import {
  cancelCandidates, insertCandidate, loadUserActivity, logEvent, markReadInChannel, markResponded, openCandidateFor,
  resolveIntentsForRun, setGoalStatus, upsertGoal, upsertIntent,
} from "./store.js";

/**
 * Where proactive candidates come from.
 *
 * 1. `proposeProactiveMessage` — the one capability an agent has. It files a
 *    proposal; it cannot send.
 * 2. The engine bridge — every workflow milestone already flows through the
 *    engine's event bus. This listener turns those events into goal/intent
 *    state and, where the work now waits on the user, a follow-up candidate
 *    that becomes due later. When the run moves on, the candidate is
 *    cancelled: a follow-up is never sent for something already done.
 * 3. Hooks on the two chat paths that matter: the user speaking (which
 *    answers anything proactive in that channel) and content campaigns
 *    finishing outside a request.
 */

export async function proposeProactiveMessage(deps: Deps, tenantId: string, input: ProactiveProposalInput): Promise<{ candidateId: string; deduplicated: boolean }> {
  const p = ProactiveProposalInput.parse(input);
  return withContext(deps.appPool, { tenantId, userId: p.userId }, async (client) => {
    const existing = await openCandidateFor(client, tenantId, p.subjectKey);
    if (existing) {
      await logEvent(client, tenantId, existing.id, "proposal_deduplicated", `${p.agentKey} proposed the same subject`, { agent: p.agentKey });
      return { candidateId: existing.id as string, deduplicated: true };
    }
    const row = await insertCandidate(client, {
      tenantId, userId: p.userId, agentKey: p.agentKey, channelId: p.channelId ?? null, intentId: p.intentId ?? null, goalId: p.goalId ?? null,
      type: p.type, reason: p.reason, proposedMessage: p.proposedMessage ?? null, importance: p.importance, urgency: p.urgency,
      requiresResponse: p.requiresResponse, subjectKey: p.subjectKey, suggestedSendAt: p.suggestedSendAt ?? new Date(),
      expiresAt: p.expiresAt ?? new Date(Date.now() + 7 * 86400_000), relatedEntity: p.relatedEntity, metadata: p.metadata,
    });
    await logEvent(client, tenantId, row.id, "candidate_created", p.reason, { agent: p.agentKey, type: p.type, subject: p.subjectKey });
    return { candidateId: row.id as string, deduplicated: false };
  });
}

// ---- engine bridge ----------------------------------------------------------

const inflight = new Set<Promise<void>>();

export function attachProactiveBridge(deps: Deps): void {
  deps.engine.events.on("event", (event: { type: string; tenantId: string; runId: string; status: string; step: string }) => {
    if (event.type !== "run_updated") return;
    const p = handleRunEvent(deps, event).catch((err) => {
      console.error(JSON.stringify({ at: "proactive.bridge_error", runId: event.runId, error: String((err as Error).message ?? err).slice(0, 300) }));
    }).then(() => { inflight.delete(p); });
    inflight.add(p);
  });
}

/** Tests await this after engine.drain() so intents and candidates are visible. */
export async function proactiveFlush(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

const GOAL_TITLES: Record<string, (project: string, org: string) => string> = {
  "grant-application-slice": (project) => `Apply for ${project}`,
  "grant-application-full": (project) => `Apply for ${project}`,
  "website-build": (_p, org) => `Launch the ${org} website`,
  "website-update": (_p, org) => `Update the ${org} website`,
  "ad-grants-application": () => "Get approved for Google Ad Grants",
  "ad-grants-automation": () => "Get approved for Google Ad Grants",
};
const isAdGrants = (definition: string) => definition.startsWith("ad-grants");
const humanKey = (k: string) => k.replace(/_/g, " ").replace(/\bein\b/i, "EIN").replace(/\burl\b/i, "URL");

export async function handleRunEvent(deps: Deps, event: { tenantId: string; runId: string; status: string; step: string }): Promise<void> {
  await withContext(deps.appPool, { tenantId: event.tenantId, userId: null }, async (client) => {
    const run = (await client.query(
      `SELECT r.id, r.definition, r.status, r.state, r.created_by, r.project_id, p.name AS project_name, o.name AS org_name,
              (SELECT id FROM channels c WHERE c.tenant_id = r.tenant_id AND c.project_id = r.project_id LIMIT 1) AS channel_id
         FROM workflow_runs r JOIN projects p ON p.id = r.project_id JOIN organizations o ON o.id = r.tenant_id WHERE r.id = $1`,
      [event.runId]
    )).rows[0];
    if (!run) return;
    const tenantId = event.tenantId;
    const userId: string = run.created_by;
    const title = (GOAL_TITLES[run.definition] ?? ((p: string) => `${humanKey(run.definition)}: ${p}`))(run.project_name, run.org_name);
    const goalSubject = `run:${run.id}`;
    const policy = await loadProactivePolicy(client);
    const agentFor = async () => {
      const last = await client.query(
        "SELECT author_agent FROM messages WHERE tenant_id = $1 AND author_kind = 'agent' AND metadata->>'runId' = $2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, run.id]
      );
      return (last.rows[0]?.author_agent as string) ?? executiveAssistant.agentKey;
    };

    if (event.status === "waiting_for_info" || event.status === "waiting_approval") {
      const goalId = await upsertGoal(client, { tenantId, userId, subjectKey: goalSubject, title, status: "blocked", priority: isAdGrants(run.definition) ? 4 : 3, channelId: run.channel_id, runId: run.id });
      const agentKey = await agentFor();
      let nextAction: string;
      let intentText: string;
      let subject: string;
      if (event.status === "waiting_for_info") {
        subject = `run:${run.id}:info`;
        const request = await resolveInfoRequest(client, run.id).catch(() => null);
        const fields = (request?.fields ?? []).map((f: { label?: string; key?: string }) => f.label ?? humanKey(String(f.key ?? ""))).filter(Boolean);
        const missing = fields;
        nextAction = missing.length ? `provide ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}` : "answer the questions in chat";
        intentText = `Provide the information needed for ${title.toLowerCase()}`;
      } else {
        subject = `run:${run.id}:approval`;
        const approval = (await client.query("SELECT id, kind FROM approvals WHERE run_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [run.id])).rows[0];
        nextAction = `review and approve the ${humanKey(String(approval?.kind ?? "next step"))}`;
        intentText = `Approve the ${humanKey(String(approval?.kind ?? "next step"))} for ${title.toLowerCase()}`;
      }
      const delayMs = policy.followUpDelayHours.waiting_on_user * 3600_000;
      const intentId = await upsertIntent(client, {
        tenantId, userId, subjectKey: subject, goalId, agentKey, intent: intentText, status: "waiting_on_user",
        nextExpectedAction: nextAction, nextExpectedActor: "user", followUpEligibleAt: new Date(Date.now() + delayMs),
        channelId: run.channel_id, runId: run.id, metadata: { step: event.step },
      });
      // One open follow-up per subject; a repeat milestone re-arms the clock.
      await cancelCandidates(client, tenantId, { subjectKey: subject }, "milestone re-raised");
      const row = await insertCandidate(client, {
        tenantId, userId, agentKey, channelId: run.channel_id, intentId, goalId, type: "waiting_on_user",
        reason: `${title} is waiting on the user to ${nextAction}`, importance: isAdGrants(run.definition) ? 4 : 3, urgency: 3,
        requiresResponse: true, subjectKey: subject, suggestedSendAt: new Date(Date.now() + delayMs), expiresAt: new Date(Date.now() + 10 * 86400_000),
        relatedEntity: { runId: run.id, projectId: run.project_id, nextExpectedAction: nextAction }, metadata: { trigger: "INTENT_WAITING_ON_USER" },
      });
      await logEvent(client, tenantId, row.id, "candidate_created", row.reason, { agent: agentKey, type: "waiting_on_user", dueAt: row.suggested_send_at });
      return;
    }

    if (event.status === "completed" || event.status === "failed" || event.status === "suspended_budget") {
      const done = event.status === "completed";
      await upsertGoal(client, { tenantId, userId, subjectKey: goalSubject, title, status: done ? "completed" : "blocked", channelId: run.channel_id, runId: run.id });
      const intents = await resolveIntentsForRun(client, tenantId, run.id, done ? "completed" : "blocked");
      await cancelCandidates(client, tenantId, { subjectPrefix: `run:${run.id}:` }, done ? "run completed" : "run stopped");
      // The milestone bridge already wrote the chat message; record it in the
      // ledger (so every agent knows the user just heard from this one) and
      // surface a notification only if the user is not here to see it.
      const agentKey = await agentFor();
      const msg = (await client.query(
        "SELECT id, channel_id FROM messages WHERE tenant_id = $1 AND author_kind = 'agent' AND metadata->>'runId' = $2 ORDER BY created_at DESC LIMIT 1",
        [tenantId, run.id]
      )).rows[0];
      const activity = await loadUserActivity(client, tenantId, userId);
      const presence = derivePresence({ last_active_at: activity.lastActiveAt, presence: activity.presence });
      const row = await insertCandidate(client, {
        tenantId, userId, agentKey, channelId: msg?.channel_id ?? run.channel_id, intentId: intents[0] ?? null, goalId: null,
        type: done ? "work_completed" : "blocked", reason: done ? `${title}: work completed` : `${title}: ${event.status}`,
        importance: 4, urgency: done ? 3 : 4, requiresResponse: !done, subjectKey: `run:${run.id}:${event.status}`, suggestedSendAt: new Date(),
        relatedEntity: { runId: run.id, projectId: run.project_id }, metadata: { trigger: done ? "AGENT_TASK_COMPLETED" : "AGENT_TASK_BLOCKED", viaBridge: true },
        delivered: { messageId: msg?.id ?? null, notified: presence !== "ONLINE_ACTIVE" && Boolean(msg?.id) },
      });
      await logEvent(client, tenantId, row.id, "delivered", "milestone message via engine bridge", { agent: agentKey, presence, notified: row.notified, messageId: msg?.id ?? null });
      if (row.notified) deps.engine.events.emit("event", { type: "notification_created", tenantId, userId, candidateId: row.id } as never);
      return;
    }

    // running / pending after a wait: the user (or the agent) moved it on.
    if (event.status === "running" || event.status === "pending") {
      const resolved = await resolveIntentsForRun(client, tenantId, run.id, "in_progress");
      if (resolved.length) {
        await setGoalStatus(client, tenantId, goalSubject, "in_progress");
        await cancelCandidates(client, tenantId, { subjectPrefix: `run:${run.id}:` }, "work resumed — the user acted");
      } else {
        await upsertGoal(client, { tenantId, userId, subjectKey: goalSubject, title, status: "in_progress", channelId: run.channel_id, runId: run.id });
      }
    }
  });
}

// ---- hooks from the chat and campaign paths ---------------------------------

/** The user wrote in a channel: proactive messages there are answered, and
 *  their presence is fresh. Cheap and inside the request's own transaction. */
export async function onUserMessage(client: PoolClient, ids: { tenantId: string; userId: string; channelId: string }): Promise<void> {
  await markResponded(client, ids.tenantId, ids.userId, ids.channelId);
  await client.query(
    "UPDATE organization_memberships SET last_active_at = now(), presence = 'active' WHERE tenant_id = $1 AND user_id = $2",
    [ids.tenantId, ids.userId]
  );
  await client.query(
    "UPDATE user_intents SET last_activity_at = now() WHERE tenant_id = $1 AND user_id = $2 AND channel_id = $3 AND status NOT IN ('completed','abandoned')",
    [ids.tenantId, ids.userId, ids.channelId]
  );
}

export async function onChannelRead(client: PoolClient, ids: { tenantId: string; userId: string; channelId: string }): Promise<void> {
  await client.query(
    `INSERT INTO channel_reads (tenant_id, user_id, channel_id, last_read_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (tenant_id, user_id, channel_id) DO UPDATE SET last_read_at = now()`,
    [ids.tenantId, ids.userId, ids.channelId]
  );
  await markReadInChannel(client, ids.tenantId, ids.userId, ids.channelId);
}

/** A content campaign finished outside any request. If it was started from
 *  chat, the designer may propose to tell the user — the orchestrator decides. */
export async function onContentCampaignFinished(deps: Deps, args: { tenantId: string; userId: string; projectId: string; title?: string; status: "ready" | "failed"; error?: string | null }): Promise<void> {
  try {
    const channelId = await withContext(deps.appPool, { tenantId: args.tenantId, userId: args.userId }, async (client) => {
      if (!args.title) args.title = String((await client.query("SELECT title FROM content_projects WHERE id = $1", [args.projectId])).rows[0]?.title ?? "your designs");
      const goalId = await upsertGoal(client, { tenantId: args.tenantId, userId: args.userId, subjectKey: `content:${args.projectId}`, title: `Create ${args.title}`, status: args.status === "ready" ? "completed" : "blocked", priority: 3 });
      const origin = await client.query(
        "SELECT channel_id FROM messages WHERE tenant_id = $1 AND metadata->>'contentProjectId' = $2 ORDER BY created_at ASC LIMIT 1",
        [args.tenantId, args.projectId]
      );
      return { channelId: (origin.rows[0]?.channel_id as string) ?? null, goalId };
    });
    if (!channelId.channelId) return; // started from Content Studio: its own page shows the result
    await proposeProactiveMessage(deps, args.tenantId, {
      userId: args.userId, agentKey: "content.designer", channelId: channelId.channelId, goalId: channelId.goalId,
      type: args.status === "ready" ? "work_completed" : "blocked",
      reason: args.status === "ready" ? `The designs for "${args.title}" are ready` : `The designs for "${args.title}" could not be generated${args.error ? `: ${args.error}` : ""}`,
      proposedMessage: args.status === "ready"
        ? `I finished the designs for "${args.title}". Want me to show you what I came up with?`
        : `I couldn't finish the designs for "${args.title}"${args.error ? ` — ${args.error}` : ""}. Want me to try a different approach?`,
      importance: 4, urgency: args.status === "ready" ? 3 : 4, requiresResponse: false,
      subjectKey: `content:${args.projectId}:${args.status}`, expiresAt: new Date(Date.now() + 3 * 86400_000),
      relatedEntity: { contentProjectId: args.projectId }, metadata: { trigger: args.status === "ready" ? "BACKGROUND_RESULT_AVAILABLE" : "AGENT_TASK_BLOCKED" },
    });
  } catch (err) {
    console.error(JSON.stringify({ at: "proactive.campaign_hook_error", projectId: args.projectId, error: String((err as Error).message ?? err).slice(0, 300) }));
  }
}
