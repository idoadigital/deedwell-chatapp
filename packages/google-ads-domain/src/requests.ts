/** Campaign requests: the vocabulary shared by the API and the dashboards. */

export const REQUEST_GOALS = {
  service_access: { label: "Help people find a service", intent: "Find help, eligibility, applications, local services", outcome: "Eligible request, completed application, qualified call" },
  volunteering: { label: "Recruit volunteers", intent: "Local opportunities, skills, group volunteering", outcome: "Qualified application, booked orientation, attendance" },
  donations: { label: "Raise donations", intent: "Cause support, a specific appeal, the organization's name", outcome: "Completed gift, recurring donor signup" },
  events: { label: "Promote an event or visit", intent: "Workshops, exhibitions, classes, schedules", outcome: "Registration, ticket, qualified visit enquiry" },
  membership: { label: "Grow membership", intent: "Join, renew, participate", outcome: "Paid or approved membership" },
  education: { label: "Share a resource or training", intent: "Practical answers within the mission", outcome: "Useful download, completed training, opted-in subscription" },
  partnerships: { label: "Find partners or sponsors", intent: "Corporate volunteering, in-kind support, sponsorship", outcome: "Qualified partnership enquiry" },
  awareness: { label: "Raise awareness of the mission", intent: "Learn about the cause or the organization", outcome: "Engaged visit that leads to a real next step" },
  other: { label: "Something else", intent: "Described by the organization", outcome: "Described by the organization" },
} as const;
export type RequestGoal = keyof typeof REQUEST_GOALS;

export type RequestStatus =
  | "submitted" | "in_review" | "needs_info" | "needs_admin" | "in_progress" | "planned" | "building" | "awaiting_approval" | "publishing" | "live"
  | "completed" | "declined" | "cancelled";

export const OPEN_REQUEST_STATUSES: RequestStatus[] = ["submitted", "in_review", "needs_info", "needs_admin", "in_progress", "planned", "building", "awaiting_approval", "publishing", "live"];
export const CLOSED_REQUEST_STATUSES: RequestStatus[] = ["completed", "declined", "cancelled"];

/** Statuses a customer may cancel from; once publishing starts the
 *  administrator closes the request. */
export const CANCELLABLE_REQUEST_STATUSES: RequestStatus[] = ["submitted", "in_review", "needs_info", "needs_admin", "in_progress", "planned", "awaiting_approval"];

export const isOpenRequest = (status: string): boolean => (OPEN_REQUEST_STATUSES as string[]).includes(status);

/** Who a question from the account manager is for. */
export type QuestionAudience = "customer" | "admin";

/**
 * The project checklist both dashboards show for a request, in order. The
 * API computes each step's state from the request, its runs, builds and
 * drafts; the dashboards only render it.
 *
 *   done      finished (check mark)
 *   active    the pipeline is working on it right now (spinner)
 *   waiting   paused until somebody answers or approves (who says whom)
 *   failed    stopped with an error the administrator has to look at
 *   skipped   not needed for this request (no questions, no images)
 *   stopped   the request was declined or cancelled here
 *   todo      not reached yet
 */
export const REQUEST_STEPS = [
  { key: "submitted", label: "Request submitted" },
  { key: "handoff", label: "Handed to the account manager" },
  { key: "assess", label: "Account manager reviews the request" },
  { key: "questions", label: "Questions answered" },
  { key: "plan", label: "Campaign plan written" },
  { key: "build", label: "Ads, keywords and extensions written" },
  { key: "images", label: "Images generated" },
  { key: "approval", label: "Final approval" },
  { key: "publish", label: "Published to Google Ads" },
  { key: "live", label: "Campaign live" },
] as const;
export type RequestStepKey = (typeof REQUEST_STEPS)[number]["key"];
export type RequestStepState = "done" | "active" | "waiting" | "failed" | "skipped" | "stopped" | "todo";

export interface RequestStepActivity { message: string; at: string; customerVisible: boolean }
export interface RequestStep {
  key: RequestStepKey;
  label: string;
  state: RequestStepState;
  /** One line under the label: an error, "3 of 4 images", who we wait on. */
  detail: string | null;
  /** Who a `waiting` step waits on. */
  waitingOn: QuestionAudience | null;
  /** When the step finished (or last moved). */
  at: string | null;
  /** The live narration for the step, oldest first. */
  activity: RequestStepActivity[];
}
