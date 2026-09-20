import { describe, expect, it } from "vitest";
import { utilizationForecast } from "./utilization.js";

describe("utilizationForecast (section 12 model)", () => {
  const now = new Date("2026-09-11T15:00:00Z"); // day 11 → 10 completed days
  const days = Array.from({ length: 11 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, costMicros: 200 * 1_000_000 }));

  it("separates completed days from the partial day and applies both caps", () => {
    const f = utilizationForecast({ days, now, timeZone: "UTC", monthlyLimitUsd: 10_000, dailyCapUsd: 329 });
    expect(f).toMatchObject({ month: "2026-09", today: "2026-09-11", daysInMonth: 30, completedDays: 10, remainingDays: 20 });
    expect(f.completedDayCostUsd).toBe(2000);
    expect(f.partialDayCostUsd).toBe(200);
    expect(f.monthToDateCostUsd).toBe(2200);
    expect(f.nominalUtilization).toBe(0.22);
    expect(f.elapsedCapacityUsd).toBe(3290);
    expect(f.elapsedUtilization).toBeCloseTo(2000 / 3290, 4);
    expect(f.remainingCapacityUsd).toBe(Math.min(10_000 - 2200, 329 * 20));
    expect(f.bestCaseMonthEndUsd).toBe(2200 + 6580);
    // 200/day projected over the 20 remaining days, minus what today already spent.
    expect(f.realisticMonthEndUsd).toBe(2200 + (200 * 20 - 200));
    expect(f.lastSevenDaysUtilization).toBeCloseTo(1400 / (329 * 7), 4);
  });

  it("reports unknown limits instead of inventing them", () => {
    const f = utilizationForecast({ days, now, timeZone: "UTC" });
    expect(f.nominalUtilization).toBeNull();
    expect(f.elapsedCapacityUsd).toBeNull();
    expect(f.bestCaseMonthEndUsd).toBeNull();
    expect(f.assumptions.join(" ")).toMatch(/UNKNOWN/);
  });

  it("resolves today in the account timezone", () => {
    const f = utilizationForecast({ days: [], now: new Date("2026-09-01T02:00:00Z"), timeZone: "America/Los_Angeles", monthlyLimitUsd: 10_000, dailyCapUsd: 329 });
    expect(f.today).toBe("2026-08-31");
    expect(f.month).toBe("2026-08");
  });
});
