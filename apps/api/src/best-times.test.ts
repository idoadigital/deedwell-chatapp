import { describe, expect, it } from "vitest";
import { bestTimes } from "./routes-content.js";

const now = new Date("2026-09-07T03:00:00Z"); // a Monday, early UTC

describe("bestTimes", () => {
  it("suggests platform windows in the viewer's timezone, spread apart, soonest first among equals", () => {
    const slots = bestTimes({ platform: "facebook_page", timezone: "America/Chicago", days: 14, count: 6, taken: [], now });
    expect(slots.length).toBe(6);
    for (const s of slots) {
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.local).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
    }
    // Never two picks within six hours of each other.
    for (let i = 0; i < slots.length; i += 1) for (let j = i + 1; j < slots.length; j += 1) {
      expect(Math.abs(new Date(slots[i]!.at).getTime() - new Date(slots[j]!.at).getTime())).toBeGreaterThanOrEqual(6 * 3600_000);
    }
    // Top pick is a mid-week morning, the strongest Facebook window.
    expect(slots[0]!.local).toMatch(/^(Tue|Wed|Thu)/);
  });

  it("steers clear of what is already queued", () => {
    const free = bestTimes({ platform: "instagram_account", timezone: "UTC", days: 7, count: 3, taken: [], now });
    const busyAt = new Date(free[0]!.at);
    const avoided = bestTimes({ platform: "instagram_account", timezone: "UTC", days: 7, count: 3, taken: [busyAt], now });
    for (const s of avoided) expect(Math.abs(new Date(s.at).getTime() - busyAt.getTime())).toBeGreaterThanOrEqual(3 * 3600_000);
  });

  it("only offers times in the future", () => {
    for (const s of bestTimes({ platform: "facebook_page", timezone: "Asia/Tokyo", days: 5, count: 5, taken: [], now })) {
      expect(new Date(s.at).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
