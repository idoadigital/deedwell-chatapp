import type { ChatMessage } from "./types";

/**
 * Working indicator for grant-platform tasks.
 *
 * Platform tasks announce start (metadata.gcpTasks on the teammate's
 * acknowledgement) and completion (metadata.gcpTaskId on the bridge's
 * milestone message). Between the two the team is genuinely working — show it,
 * exactly like local runs do. Labels mirror the API's task phrases.
 */
const GCP_TASK_LABELS: Record<string, string> = {
  research: "David is researching grant opportunities…",
  verification: "Grace is verifying eligibility against the funder's own materials…",
  requirements_analysis: "Naomi is reading the funder's application requirements…",
  document_ingestion: "Grace is processing the document into the Evidence Library…",
  strategy_generation: "Amara is drafting the application strategy…",
  section_drafting: "Sophia is drafting the application sections…",
  section_revision: "Sophia is revising the draft…",
  budget_narrative: "Michael is working on the budget…",
  compliance: "Naomi is running the compliance checks…",
  document_generation: "Daniel is generating the application package…",
};
const GCP_WORKING_MAX_MS = 30 * 60 * 1000; // stop claiming progress on stale tasks

export function pendingGcpWork(
  messages: Array<Pick<ChatMessage, "metadata" | "created_at">>,
  now = Date.now()
): { label: string } | null {
  const started = new Map<string, { type: string; at: string }>();
  const finished = new Set<string>();
  for (const m of messages) {
    const tasks = m.metadata?.gcpTasks;
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        if (t?.task_id) started.set(String(t.task_id), { type: String(t.task_type ?? ""), at: m.created_at });
      }
    }
    if (m.metadata?.gcpTaskId) finished.add(String(m.metadata.gcpTaskId));
  }
  const pending = [...started.entries()].filter(([id]) => !finished.has(id));
  const newest = pending.at(-1)?.[1];
  if (!newest) return null;
  if (now - new Date(newest.at).getTime() > GCP_WORKING_MAX_MS) return null;
  return { label: GCP_TASK_LABELS[newest.type] ?? "The grant team is working on it — updates will land here…" };
}
