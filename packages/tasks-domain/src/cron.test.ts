import { describe, expect, it } from "vitest";
import { describeCron, isValidCron, nextCronRun, parseCron } from "./cron.js";

describe("cron", () => {
  it("parses fields, names, steps and presets", () => {
    expect([...parseCron("*/15 9-17 * * mon-fri").minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9 1 jan,jul *").month]).toEqual([1, 7]);
    expect([...parseCron("@weekly").dayOfWeek!]).toEqual([1]);
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("0 25 * * *")).toBe(false);
    expect(isValidCron("every monday")).toBe(false);
  });

  it("finds the next run in the given time zone", () => {
    // 2026-09-07 is a Monday. 14:30Z = 10:30 New York (EDT).
    const from = new Date("2026-09-07T14:30:00Z");
    expect(nextCronRun("0 9 * * *", from, "America/New_York")?.toISOString()).toBe("2026-09-08T13:00:00.000Z");
    expect(nextCronRun("0 9 * * mon-fri", new Date("2026-09-11T20:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-09-14T13:00:00.000Z");
    expect(nextCronRun("0 9 1 * *", from, "UTC")?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(nextCronRun("*/15 * * * *", from, "UTC")?.toISOString()).toBe("2026-09-07T14:45:00.000Z");
    expect(nextCronRun("0 0 31 2 *", from, "UTC")).toBeNull();
  });

  it("crosses a daylight-saving change without drifting", () => {
    // US DST ends 2026-11-01 at 2:00 local. 9 AM local stays 9 AM local.
    const before = nextCronRun("0 9 * * *", new Date("2026-10-31T14:00:00Z"), "America/New_York");
    const after = nextCronRun("0 9 * * *", before!, "America/New_York");
    expect(before?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("describes common schedules", () => {
    expect(describeCron("0 9 * * mon-fri")).toBe("Every weekday at 9:00 AM");
    expect(describeCron("30 17 * * *")).toBe("Every day at 5:30 PM");
    expect(describeCron("0 8 1 * *")).toBe("Monthly on the 1st at 8:00 AM");
    expect(describeCron("0 10 * * 1,4")).toBe("Every Monday, Thursday at 10:00 AM");
  });
});
