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

export type RequestStatus = "submitted" | "in_review" | "needs_info" | "in_progress" | "planned" | "building" | "live" | "completed" | "declined" | "cancelled";

export const OPEN_REQUEST_STATUSES: RequestStatus[] = ["submitted", "in_review", "needs_info", "in_progress", "planned", "building", "live"];
export const CLOSED_REQUEST_STATUSES: RequestStatus[] = ["completed", "declined", "cancelled"];

/** Statuses a customer may cancel from; once a campaign is live the
 *  administrator closes the request. */
export const CANCELLABLE_REQUEST_STATUSES: RequestStatus[] = ["submitted", "in_review", "needs_info", "in_progress", "planned"];

export const isOpenRequest = (status: string): boolean => (OPEN_REQUEST_STATUSES as string[]).includes(status);
