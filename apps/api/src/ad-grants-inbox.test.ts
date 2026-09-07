import { describe, expect, it } from "vitest";
import { classifyGoogleEmail } from "./ad-grants-inbox.js";

describe("Ad Grants inbox classification", () => {
  const c = (subject: string, text = "") => classifyGoogleEmail({ subject, text, snippet: "" }).verdict;
  it("reads approvals", () => {
    expect(c("Welcome to Google for Nonprofits")).toBe("approved");
    expect(c("Your organization has been verified", "Goodstack has verified Riverbend Youth Center.")).toBe("approved");
    expect(c("Congratulations! Your Ad Grants account is active")).toBe("approved");
  });
  it("reads rejections before approvals", () => {
    expect(c("Update on your request", "Unfortunately your organization is not eligible for Google for Nonprofits.")).toBe("rejected");
    expect(c("Your application was not approved")).toBe("rejected");
  });
  it("reads requests for action", () => {
    expect(c("Action required: verify your organization", "Please upload your IRS determination letter within 14 days.")).toBe("action_needed");
    expect(c("Your Ad Grants account will be paused", "Policy violation: click-through rate below 5%.")).toBe("action_needed");
  });
  it("treats the rest as updates", () => {
    expect(c("Tips for your first campaign")).toBe("info");
  });
});
