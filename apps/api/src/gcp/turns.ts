import type { PoolClient } from "pg";
import { audit } from "@deedwell/database";
import type { Deps } from "../bootstrap.js";
import type { ChannelRow } from "../assistant.js";
import { createProjectChannel, insertMessage } from "../assistant.js";
import { teammateByKey } from "../teammates.js";
import type { GcpGrantPlatform, GcpIds, GcpTurnResult } from "./platform.js";
import {
  bindApplication, ensureChannelConversation, ensureGcpIds,
  getChannelLink, orgAllowed, watchChannel, watchDocument,
} from "./links.js";
import { isGrantTeamDm, taskPhrases, teammateForCapability } from "./teammate-map.js";

/**
 * Routes a chat turn to the external grant platform.
 *
 * The chat experience is unchanged: the same teammates answer, the same
 * message metadata drives the same cards, and every button still sends the
 * sentence a person would have typed. What changes is the engine underneath —
 * research, verification, the application workspace, the Evidence Library,
 * strategy, drafting, budget, compliance and DOCX/PDF all run on the platform,
 * which is also the durable shared context that survives switching teammates.
 *
 * Returns false when this turn is not the platform's to handle (feature off,
 * org not in the preview allowlist, or a channel the platform doesn't own) —
 * the caller then proceeds with the existing local behaviour, unchanged.
 */

interface TurnIds { tenantId: string; userId: string }
type Msg = Record<string, unknown>;

export async function gcpRoutesChannel(
  deps: Deps,
  client: PoolClient,
  channel: ChannelRow
): Promise<boolean> {
  if (!deps.gcp) return false;
  if (isGrantTeamDm(channel.kind, channel.agent_key)) return true;
  if (channel.kind === "project") return !!(await getChannelLink(client, channel.id));
  return false;
}

export async function handleGcpTurn(
  deps: Deps,
  client: PoolClient,
  ids: TurnIds,
  channel: ChannelRow,
  body: string,
  fileId: string | null,
  out: Msg[]
): Promise<boolean> {
  const platform = deps.gcp;
  if (!platform) return false;
  const { rows: orgRows } = await client.query("SELECT slug, name FROM organizations WHERE id = $1", [ids.tenantId]);
  if (!orgRows[0] || !orgAllowed(orgRows[0].slug)) return false;

  const persona = channel.kind === "dm" && channel.agent_key ? channel.agent_key : "grant.program_planner";
  const say = async (text: string, metadata: Record<string, unknown> = {}, agent = persona) => {
    out.push(await insertMessage(client, {
      tenantId: ids.tenantId, channelId: channel.id, authorKind: "agent",
      authorAgent: agent, body: text, metadata,
    }));
  };

  let gcpIds: GcpIds;
  let conversationId: string;
  try {
    gcpIds = await ensureGcpIds(platform, client, ids.tenantId, ids.userId);
    const link = await ensureChannelConversation(platform, client, ids.tenantId, channel.id, gcpIds);
    conversationId = link.gcp_conversation_id;
  } catch (err) {
    console.log(JSON.stringify({ at: "gcp_turn_setup_failed", channelId: channel.id, error: String(err instanceof Error ? err.message : err).slice(0, 300) }));
    await say("I couldn't reach the grant platform just now, so nothing was started. Please try again in a moment — nothing you typed was lost.");
    return true;
  }

  // A document shared in a routed conversation goes to the organization's
  // Evidence Library — durable, organization-level, never re-uploaded per
  // application. Ingestion continues in the background; the bridge reports
  // the outcome when the platform finishes.
  if (fileId) {
    try {
      const { rows } = await client.query("SELECT filename, mime, storage_key FROM files WHERE id = $1", [fileId]);
      if (!rows[0]) throw new Error("uploaded file not found");
      const bytes = await deps.storage.get(rows[0].storage_key);
      const uploaded = await platform.uploadDocument(gcpIds, rows[0].filename, rows[0].mime, bytes);
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, action: "gcp.document_uploaded",
        entityType: "file", entityId: fileId,
        metadata: { gcpDocumentId: uploaded.document_id ?? null, duplicate: !!uploaded.duplicate_of_existing },
      });
      if (uploaded.document_id) await watchDocument(client, channel.id, String(uploaded.document_id));
      if (uploaded.duplicate_of_existing) {
        await say(
          `**${rows[0].filename}** is already in the Evidence Library (identical content), so I treated this as a re-submission rather than storing a second copy. Its evidence stays available to every application.`,
          {}, "grant.eligibility_analyst");
      } else {
        await say(
          `I've stored **${rows[0].filename}** in the Evidence Library and started processing it — I extract facts with their exact source location and keep only what the document actually supports. I'll post here when it's done.`,
          { gcpDocumentId: uploaded.document_id ?? null }, "grant.eligibility_analyst");
      }
    } catch (err) {
      await say(`I couldn't process that document (${String(err instanceof Error ? err.message : err).slice(0, 140)}). Please try another copy — the rest of the Evidence Library is unaffected.`,
        {}, "grant.eligibility_analyst");
    }
    return true;
  }

  let turn: GcpTurnResult;
  try {
    turn = await platform.turn(conversationId, gcpIds, body);
  } catch (err) {
    console.log(JSON.stringify({ at: "gcp_turn_failed", channelId: channel.id, error: String(err instanceof Error ? err.message : err).slice(0, 300) }));
    await say("That request didn't make it through to the grant platform, so nothing was changed or started. Please try again in a moment.");
    return true;
  }

  const capability = turn.intent?.capability ?? "status_overview";
  const author = channel.kind === "dm" && channel.agent_key ? channel.agent_key : teammateForCapability(capability);
  const metadata: Record<string, unknown> = {
    gcpCapability: capability,
    gcpOutcome: turn.outcome,
  };

  // Opportunity lists become the existing grant card — same Apply button, and
  // pressing it sends the same sentence a person would type; the platform
  // resolves the ordinal against what this conversation was actually shown.
  const data = (turn.data ?? {}) as Record<string, unknown>;
  const opps = data.opportunities as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(opps) && opps.length) {
    metadata.searchResults = opps.map((o, i) => ({
      index: i + 1,
      title: String(o.program_name ?? o.title ?? "Untitled program"),
      funder: o.funder ? String(o.funder) : undefined,
      number: null,
      closeDate: o.deadline_text ? String(o.deadline_text) : (o.deadline_date ? String(o.deadline_date) : null),
      sourceUrl: o.official_url ? String(o.official_url) : (o.source_url ? String(o.source_url) : undefined),
    }));
  }

  // Async platform work: acknowledge now, let the bridge report milestones.
  // The platform reports started tasks as id strings; the capability's
  // task_type says what kind of work it is.
  // create_application's capability itself is synchronous — the task it
  // spawns is the requirements analysis that follows.
  const impliedType = turn.intent?.task_type
    ?? (capability === "create_application" ? "requirements_analysis" : "");
  const started = (turn.tasks ?? [])
    .map((t) => typeof t === "string"
      ? { task_id: t, task_type: impliedType, status: "queued" }
      : t)
    .filter((t) => t && t.task_id);
  if (started.length) {
    metadata.gcpTasks = started.map((t) => ({ task_id: t.task_id, task_type: t.task_type, status: t.status }));
    await watchChannel(client, channel.id);
  }

  let text = turn.message || "Done.";
  const startedTypes = [...new Set(started.map((t) => t.task_type).filter(Boolean))];
  if (startedTypes.length) {
    const doing = startedTypes.map((tt) => taskPhrases(tt).doing).join("; ");
    if (doing && !text.toLowerCase().includes(doing.split(" ")[0] ?? "")) {
      text += `\n\n(${firstName(author)} is ${doing} — I'll post here as it completes. You can leave and come back; nothing is lost.)`;
    }
  }

  // Handoff: applying binds a durable application workspace. It gets its own
  // project channel — the same pattern the product already uses — with the
  // platform conversation opened already focused on that application, so every
  // grant teammate in that channel continues from the same state.
  if (capability === "create_application" && turn.application_id && turn.outcome === "OK") {
    try {
      const overview = await platform.applicationOverview(turn.application_id, gcpIds);
      const app = (overview.application ?? overview) as Record<string, unknown>;
      const title = [app.funder, app.program_name].filter(Boolean).join(" — ") || "Grant application";
      const existing = await client.query(
        "SELECT channel_id FROM gcp_channel_conversations WHERE gcp_application_id = $1 LIMIT 1",
        [turn.application_id]);
      let projectChannelId = existing.rows[0]?.channel_id as string | undefined;
      if (!projectChannelId) {
        const created = await createProjectChannel(client, ids.tenantId, ids.userId, title, "grant_application");
        projectChannelId = created.channelId;
        await ensureChannelConversation(platform, client, ids.tenantId, projectChannelId, gcpIds, turn.application_id);
        await insertMessage(client, {
          tenantId: ids.tenantId, channelId: projectChannelId, authorKind: "agent",
          authorAgent: "grant.program_planner",
          body: `This channel is the workspace for **${title}**. The whole grant team works from the same application here — requirements, evidence, strategy, drafting, budget, and compliance. Ask "what do you need from me?" any time.`,
          metadata: { openWorkspace: true },
        });
        await watchChannel(client, projectChannelId);
      } else {
        await bindApplication(client, projectChannelId, turn.application_id);
      }
      await audit(client, {
        tenantId: ids.tenantId, actorUser: ids.userId, action: "gcp.application_channel_bound",
        entityType: "channel", entityId: projectChannelId!,
        metadata: { gcpApplicationId: turn.application_id },
      });
      metadata.goToChannelId = projectChannelId;
      if (channel.kind === "dm") {
        text += `\n\nI've opened the application workspace with Daniel and the team — continue there and everything we've established carries over.`;
      }
    } catch (err) {
      console.log(JSON.stringify({ at: "gcp_handoff_failed", error: String(err instanceof Error ? err.message : err).slice(0, 300) }));
      // The application exists on the platform even if the channel didn't get
      // created — say so honestly rather than pretending nothing happened.
      text += `\n\n(The application was created, but I couldn't open its project channel — ask me again and I'll retry.)`;
    }
  }

  if (channel.kind === "project" && turn.application_id) {
    metadata.openWorkspace = true;
  }

  await say(text, metadata, author);
  return true;
}

function firstName(agentKey: string): string {
  const mate = teammateByKey.get(agentKey);
  return mate ? mate.name.split(" ")[0]! : "The team";
}
