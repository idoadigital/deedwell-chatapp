import type { ModelProvider } from "@deedwell/agent-runtime";
import { ProactiveMessageOutput } from "@deedwell/schemas";

/**
 * Phrasing an approved proactive message as the teammate who owns the
 * work. The situation block carries the whole chain — intent, what the
 * agent did, what is blocking, the next best action, why now — so the
 * model continues a relationship rather than inventing one. The model may
 * still say "don't send": that veto is honoured.
 */
export interface ComposeContext {
  agentName: string; agentRole: string; orgName: string; userName: string;
  type: string; reason: string; goalTitle: string | null; intent: string | null;
  nextExpectedAction: string | null; nextExpectedActor: string | null;
  hoursSince: number; lastAgentMessage: string | null; proposedMessage: string | null;
  combined: string[];
  /** A question the agent asked in chat and is still waiting on. */
  question?: string | null;
}

const SYSTEM = `
You are a Deedwell AI teammate reaching out to a nonprofit staff member in your existing chat with them — not a notification system.
Write the message you would send. Rules:
- One to three short sentences. Lead with the fact ("I finished…", "I still need one thing…", "Something changed…"), then the single thing they can do or say.
- Sound like the same person who was working with them before; refer to the work by name. No "Hi!", no "just checking in", no exclamation marks, no bullet lists unless combining several items.
- Never invent facts, dates or progress not in the situation. If the situation includes other items to combine, mention them in one clause each.
- If nothing in the situation would actually help the user right now, set shouldSend to false and say why.
`.trim();

export function situationBlock(c: ComposeContext): string {
  return [
    `Agent: ${c.agentName} (${c.agentRole})`, `Organization: ${c.orgName}`, `User: ${c.userName}`,
    `Type: ${c.type}`, `Why now: ${c.reason}`,
    c.goalTitle ? `Goal: ${c.goalTitle}` : "", c.intent ? `Intent: ${c.intent}` : "",
    c.question ? `The agent asked and is waiting on: "${c.question}"` : "",
    c.nextExpectedAction ? `Next expected action: ${c.nextExpectedAction}`
      : c.proposedMessage ? "Next expected action: as described in the agent's draft"
      : c.type === "work_completed" ? "Next expected action: the user can ask to see the result"
      : c.type === "status_change" || c.type === "opportunity" || c.type === "deadline" || c.type === "blocked" ? "Next expected action: up to the user"
      : "Next expected action: nothing for the user to do",
    c.nextExpectedActor ? `Who must act: ${c.nextExpectedActor}` : "",
    `Hours since the last activity on this: ${Math.round(c.hoursSince)}`,
    c.lastAgentMessage ? `What the agent last said: ${c.lastAgentMessage.slice(0, 400)}` : "",
    c.proposedMessage ? `Draft from the agent: ${c.proposedMessage}` : "",
    c.combined.length ? `Also waiting for the user (combine briefly): ${c.combined.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : "",
  ].filter(Boolean).join("\n");
}

export async function composeProactiveMessage(model: ModelProvider, c: ComposeContext): Promise<ProactiveMessageOutput> {
  try {
    const res = await model.complete({
      system: SYSTEM,
      task: "Write this teammate's proactive message, or decline it.",
      outputSchemaRef: "proactive_message",
      dataBlocks: [{ label: "situation", content: situationBlock(c) }],
    });
    const raw = JSON.parse(res.text) as Partial<ProactiveMessageOutput>;
    if (raw && raw.shouldSend === false) {
      return { message: "", summary: "", shouldSend: false, reason: (raw.reason ?? "not helpful now").toString().slice(0, 300) };
    }
    return ProactiveMessageOutput.parse(raw);
  } catch (err) {
    console.log(JSON.stringify({ at: "proactive.compose_fallback", error: String((err as Error).message ?? err).slice(0, 200) }));
    const message = c.proposedMessage ?? fallbackMessage(c);
    return { message, summary: message.slice(0, 120), shouldSend: true, reason: null };
  }
}

/** Deterministic phrasing when the model is unavailable — still specific, never "Reminder:". */
export function fallbackMessage(c: ComposeContext): string {
  const about = c.goalTitle ?? c.intent ?? "our work";
  const extra = c.combined.length ? ` There ${c.combined.length === 1 ? "is one more thing" : `are also ${c.combined.length} things`} waiting for you: ${c.combined.join("; ")}.` : "";
  if (c.question) return `Earlier I asked: "${c.question.replace(/\s+/g, " ").slice(0, 160)}" — want to pick that up when you have a moment?${extra}`;
  if (c.type === "work_completed") return `I finished ${about}. Want me to show you what I came up with?${extra}`;
  if (c.type === "blocked") return `I couldn't continue ${about}${c.nextExpectedAction ? ` — ${c.nextExpectedAction}` : ""}. Want to sort that out now?${extra}`;
  if (c.nextExpectedAction) return `Quick update on ${about} — I'm still waiting on one thing: ${c.nextExpectedAction.replace(/\.$/, "")}. Want to finish that now?${extra}`;
  return `We started on ${about} and haven't finished. Do you still want to continue?${extra}`;
}
