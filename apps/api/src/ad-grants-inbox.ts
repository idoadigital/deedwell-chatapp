import { AD_GRANTS_WORKFLOW } from "@deedwell/adgrants-domain";
import { getGmailMessage, GOOGLE_SCOPE, GoogleConnectionError, searchGmail, type GmailMessage } from "@deedwell/connectors";
import { uuidv7, withContext } from "@deedwell/database";
import { emailOrgAdmins, orgNameOf } from "@deedwell/email";
import type { Deps } from "./bootstrap.js";

/**
 * Gmail monitoring for the Ad Grants application (process phase 5 —
 * "Monitor Gmail for Google emails, read them, extract what's needed").
 *
 * Every few minutes, for each workspace with an active Ad Grants run and a
 * Google connection that granted Gmail read access, search the connected
 * inbox for mail from Google for Nonprofits, Google Ads and Goodstack about
 * the application. Each new message becomes a timeline entry with its text,
 * classified as approved / rejected / action needed / informational. A
 * decision wakes a run parked on Google's review so it re-checks now
 * instead of at the next 15-minute poll; a request for action emails the
 * workspace admins with the message. Nothing is ever replied to or sent.
 */
export type EmailVerdict = "approved" | "rejected" | "action_needed" | "info";

const SEARCH = [
  "newer_than:45d",
  "(from:google.com OR from:goodstack.org OR from:percent.org)",
  '("Google for Nonprofits" OR "Ad Grants" OR "Ad Grant" OR Goodstack OR "nonprofit" OR "Google Ads")',
].join(" ");

export function classifyGoogleEmail(m: Pick<GmailMessage, "subject" | "text" | "snippet">): { verdict: EmailVerdict; reason: string } {
  const text = `${m.subject}\n${m.snippet}\n${m.text}`.toLowerCase();
  const has = (re: RegExp) => re.test(text);
  if (has(/(not|isn'?t|wasn'?t) (been )?(approved|eligible|verified)|has been declined|unable to (verify|approve)|rejected|ineligible|does not (meet|qualify)/)) {
    return { verdict: "rejected", reason: "The message says the application or verification was not approved." };
  }
  if (has(/(has been|is now|you'?re|you are|your organization is) (approved|verified|activated)|welcome to google for nonprofits|congratulations|your ad grants account is (now )?active/)) {
    return { verdict: "approved", reason: "The message says the application or verification was approved." };
  }
  if (has(/action required|action needed|we need|please (provide|upload|submit|confirm|verify|complete|respond)|additional (information|documentation)|missing information|respond by|within \d+ days|policy violation|suspended|will be (paused|suspended)/)) {
    return { verdict: "action_needed", reason: "The message asks for something or warns about the account." };
  }
  return { verdict: "info", reason: "Informational update." };
}

export const VERDICT_LABEL: Record<EmailVerdict, string> = {
  approved: "Approved", rejected: "Not approved", action_needed: "Action needed", info: "Update",
};

interface Candidate { tenantId: string; runId: string; status: string; waiting: string | null; projectId: string }

/** Workspaces with an Ad Grants run past the Google sign-in and a Gmail-readable connection. */
async function candidates(deps: Deps): Promise<Candidate[]> {
  const { rows } = await deps.adminPool.query(
    `SELECT DISTINCT ON (r.tenant_id) r.tenant_id, r.id AS run_id, r.status, r.project_id, r.state->'waiting'->>'payload' AS waiting
       FROM workflow_runs r
       JOIN connector_connections c ON c.tenant_id = r.tenant_id AND c.provider = 'google' AND c.connector_type = 'google_account'
            AND c.status = 'connected' AND $2 = ANY(c.scopes)
      WHERE r.definition = $1 AND r.status NOT IN ('completed','cancelled','failed')
        AND r.current_step IN ('submit_enrollment','await_google_review','handle_review_rejection','activate_google_products',
                               'activate_ad_grants_product','submit_activation','draft_campaign_plan','publish_campaign')
      ORDER BY r.tenant_id, r.created_at DESC`,
    [AD_GRANTS_WORKFLOW, GOOGLE_SCOPE.gmailRead]
  );
  return (rows as Array<Record<string, any>>).map((r) => ({ tenantId: r.tenant_id, runId: r.run_id, status: r.status, waiting: r.waiting ?? null, projectId: r.project_id }));
}

export interface InboxScanStats { workspaces: number; newMessages: number; woken: number; alerts: number }

export async function scanAdGrantsInboxes(deps: Deps, log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }): Promise<InboxScanStats> {
  const stats: InboxScanStats = { workspaces: 0, newMessages: 0, woken: 0, alerts: 0 };
  for (const c of await candidates(deps)) {
    stats.workspaces++;
    try {
      await withContext(deps.appPool, { tenantId: c.tenantId, userId: null }, async (client) => {
        const access = await deps.googleConnections.require(client, c.tenantId, { scopes: [GOOGLE_SCOPE.gmailRead], feature: "gmail" });
        const ids = await searchGmail(access.accessToken, SEARCH, 15);
        if (!ids.length) return;
        const seen = new Set((await client.query(
          "SELECT metadata->>'gmailId' AS id FROM workspace_events WHERE project_id = $1 AND event_type = 'ad_grants:email'", [c.projectId]
        )).rows.map((r: { id: string }) => r.id));
        let decision: EmailVerdict | null = null;
        for (const id of ids.filter((i) => !seen.has(i))) {
          const m = await getGmailMessage(access.accessToken, id);
          const { verdict, reason } = classifyGoogleEmail(m);
          const eventId = uuidv7();
          await client.query(
            `INSERT INTO workspace_events (id, tenant_id, project_id, run_id, event_type, title, summary, status, agent_key, metadata, completed_at, created_at)
             VALUES ($1,$2,$3,$4,'ad_grants:email',$5,$6,$7,'ad_grants.application',$8::jsonb, now(), COALESCE($9, now()))`,
            [eventId, c.tenantId, c.projectId, c.runId, `Email from ${m.from.replace(/<.*>/, "").trim() || "Google"}: ${m.subject || "(no subject)"}`.slice(0, 200),
             (m.text || m.snippet).replace(/\s+/g, " ").slice(0, 1500), verdict === "rejected" || verdict === "action_needed" ? "blocked" : "completed",
             JSON.stringify({ gmailId: m.id, threadId: m.threadId, from: m.from, subject: m.subject, verdict, reason, receivedAt: m.date?.toISOString() ?? null }), m.date]
          );
          stats.newMessages++;
          deps.engine.events.emit("event", { type: "ad_grants_email", tenantId: c.tenantId, runId: c.runId, eventId, verdict } as never);
          if (verdict === "approved" || verdict === "rejected") decision = verdict;
          if (verdict === "action_needed" || verdict === "rejected") {
            await emailOrgAdmins(client, c.tenantId, "ad_grants_email", {
              orgName: await orgNameOf(client, c.tenantId), from: m.from, subject: m.subject || "(no subject)",
              verdict: VERDICT_LABEL[verdict], excerpt: (m.text || m.snippet).replace(/\s+/g, " ").slice(0, 700),
            }, { dedupe: `ad_grants_email:${c.tenantId}:${m.id}` });
            stats.alerts++;
          }
        }
        // A decision arrived by email: re-check Google's page now rather than
        // at the next scheduled poll. The step re-verifies on Google itself.
        if (decision && c.status === "waiting_for_info" && (c.waiting ?? "").includes("google_review_pending")) {
          await deps.engine.signal(client, c.runId, "info", { emailVerdict: decision }).catch(() => undefined);
          stats.woken++;
        }
      });
    } catch (err) {
      if (err instanceof GoogleConnectionError) continue; // no usable Gmail access right now; the connector already told the admins
      log?.warn({ at: "ad_grants.inbox_scan_failed", tenantId: c.tenantId, err: String((err as Error).message ?? err).slice(0, 300) });
    }
  }
  return stats;
}

export function startAdGrantsInboxWorker(deps: Deps, opts: { intervalMs?: number; log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {}): () => void {
  const intervalMs = opts.intervalMs ?? Number(process.env.AD_GRANTS_INBOX_POLL_MS ?? 5 * 60_000);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const stats = await scanAdGrantsInboxes(deps, opts.log);
      if (stats.newMessages || stats.woken) opts.log?.info({ at: "ad_grants.inbox", ...stats });
    } catch (err) {
      opts.log?.error({ at: "ad_grants.inbox_failed", err: String(err) });
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { void tick(); }, Math.min(intervalMs, 20_000));
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
