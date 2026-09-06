import { z } from "zod";

/**
 * Proactive messaging: the model's part is small and late. Everything about
 * whether to reach out is decided by the orchestrator's policy; the model is
 * only asked to phrase an approved message as the responsible teammate — and
 * given one last veto if, seeing the full context, the message would not
 * materially help the user.
 */
export const ProactiveMessageOutput = z.object({
  /** The message as the agent would say it in chat. Short, specific, no greeting filler. */
  message: z.string().trim().min(1).max(900),
  /** One line for the notification centre. */
  summary: z.string().trim().min(1).max(140),
  /** false = seeing the context, this would not help the user; the orchestrator suppresses it. */
  shouldSend: z.boolean(),
  reason: z.string().trim().max(300).nullable(),
});
export type ProactiveMessageOutput = z.infer<typeof ProactiveMessageOutput>;

export const PROACTIVE_TYPES = [
  "waiting_on_user", "work_completed", "deadline", "blocked", "goal_progress",
  "opportunity", "check_in", "status_change",
] as const;
export type ProactiveType = (typeof PROACTIVE_TYPES)[number];

/** What an agent may submit. Delivery is never implied. */
export const ProactiveProposalInput = z.object({
  userId: z.string().uuid(),
  agentKey: z.string().min(1).max(80),
  channelId: z.string().uuid().nullable().optional(),
  intentId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  type: z.enum(PROACTIVE_TYPES),
  reason: z.string().trim().min(1).max(500),
  proposedMessage: z.string().trim().min(1).max(900).nullable().optional(),
  importance: z.number().int().min(1).max(5).default(3),
  urgency: z.number().int().min(1).max(5).default(2),
  requiresResponse: z.boolean().default(false),
  suggestedSendAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  /** Stable key for the subject, so two agents proposing the same thing collide. */
  subjectKey: z.string().min(1).max(200),
  relatedEntity: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
});
export type ProactiveProposalInput = z.infer<typeof ProactiveProposalInput>;
