/**
 * Grant utilization, computed with the internal forecasting model the
 * account-manager prompt prescribes (section 12). Pure arithmetic over
 * synced daily cost — the agent reads the result, it never estimates it.
 *
 *   nominal_utilization  = month_to_date_cost / monthly_limit
 *   elapsed_capacity     = min(monthly_limit, Σ daily caps of completed days)
 *   elapsed_utilization  = completed_day_cost / elapsed_capacity
 *   remaining_capacity   = min(monthly_limit − month_to_date_cost, Σ remaining daily caps)
 *   best_case_month_end  = month_to_date_cost + max(0, remaining_capacity)
 *   realistic_month_end  = month_to_date_cost + modeled remaining delivery
 *                          (average completed-day cost of the last 7 completed
 *                          days × remaining days, capped by remaining capacity)
 *
 * The current partial day is reported separately from completed days, and
 * "today" is taken in the account's timezone.
 */

/** Google's published Ad Grants allocation, in USD; verify per account. */
export const AD_GRANTS_MONTHLY_LIMIT_USD = 10_000;
export const AD_GRANTS_DAILY_CAP_USD = 329;

export interface UtilizationInput {
  /** Completed and partial days of the current month: ISO day → cost. */
  days: Array<{ day: string; costMicros: number }>;
  /** The account's timezone; "today" is resolved in it. */
  timeZone?: string | null;
  now?: Date;
  monthlyLimitUsd?: number | null;
  dailyCapUsd?: number | null;
}

export interface UtilizationForecast {
  month: string;
  today: string;
  timeZone: string;
  monthlyLimitUsd: number | null;
  dailyCapUsd: number | null;
  daysInMonth: number;
  completedDays: number;
  remainingDays: number;
  monthToDateCostUsd: number;
  completedDayCostUsd: number;
  partialDayCostUsd: number;
  nominalUtilization: number | null;
  elapsedCapacityUsd: number | null;
  elapsedUtilization: number | null;
  remainingCapacityUsd: number | null;
  bestCaseMonthEndUsd: number | null;
  realisticMonthEndUsd: number | null;
  averageCompletedDayCostUsd: number | null;
  /** Share of the last seven completed days' capacity that was used. */
  lastSevenDaysUtilization: number | null;
  assumptions: string[];
}

const dayInZone = (d: Date, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

export function utilizationForecast(input: UtilizationInput): UtilizationForecast {
  const timeZone = input.timeZone || "UTC";
  const today = dayInZone(input.now ?? new Date(), timeZone);
  const month = today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const dayOfMonth = Number(today.slice(8, 10));
  const completedDays = dayOfMonth - 1;
  const remainingDays = daysInMonth - completedDays; // includes today
  const monthlyLimit = input.monthlyLimitUsd ?? null;
  const dailyCap = input.dailyCapUsd ?? null;

  const inMonth = input.days.filter((d) => d.day.startsWith(month));
  const usd = (micros: number) => micros / 1_000_000;
  const completed = inMonth.filter((d) => d.day < today);
  const partial = inMonth.filter((d) => d.day === today);
  const completedDayCost = usd(completed.reduce((n, d) => n + Number(d.costMicros || 0), 0));
  const partialDayCost = usd(partial.reduce((n, d) => n + Number(d.costMicros || 0), 0));
  const monthToDate = completedDayCost + partialDayCost;

  const elapsedCapacity = dailyCap != null ? Math.min(monthlyLimit ?? Infinity, dailyCap * completedDays) : null;
  const remainingCapacity = dailyCap != null
    ? Math.max(0, Math.min(monthlyLimit != null ? monthlyLimit - monthToDate : Infinity, dailyCap * remainingDays))
    : monthlyLimit != null ? Math.max(0, monthlyLimit - monthToDate) : null;

  const lastSeven = completed.sort((a, b) => a.day.localeCompare(b.day)).slice(-7);
  const lastSevenCost = usd(lastSeven.reduce((n, d) => n + Number(d.costMicros || 0), 0));
  const averageCompletedDayCost = completedDays > 0 ? completedDayCost / completedDays : null;
  const modeledDaily = lastSeven.length ? lastSevenCost / lastSeven.length : averageCompletedDayCost;
  const modeledRemaining = modeledDaily != null ? modeledDaily * remainingDays - partialDayCost : null;
  const realistic = modeledRemaining != null
    ? monthToDate + Math.max(0, Math.min(modeledRemaining, remainingCapacity ?? Infinity))
    : null;

  const assumptions = [
    `Today is ${today} in ${timeZone}; ${completedDays} completed day(s), ${remainingDays} remaining including today.`,
    monthlyLimit != null ? `Monthly limit assumed ${monthlyLimit} (verify against the account).` : "Monthly limit UNKNOWN — nominal utilization not computed.",
    dailyCap != null ? `Daily cap assumed ${dailyCap} (verify against the account).` : "Daily cap UNKNOWN — capacity figures use the monthly limit only.",
    "Cost comes from synced daily metrics; Google's reporting can lag up to a day.",
    lastSeven.length ? `Realistic forecast projects the average of the last ${lastSeven.length} completed day(s).` : "No completed days yet — realistic forecast unavailable.",
  ];

  const ratio = (a: number, b: number | null) => (b != null && b > 0 ? Number((a / b).toFixed(4)) : null);
  const money = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));
  return {
    month, today, timeZone, monthlyLimitUsd: monthlyLimit, dailyCapUsd: dailyCap, daysInMonth, completedDays, remainingDays,
    monthToDateCostUsd: money(monthToDate)!, completedDayCostUsd: money(completedDayCost)!, partialDayCostUsd: money(partialDayCost)!,
    nominalUtilization: ratio(monthToDate, monthlyLimit),
    elapsedCapacityUsd: money(elapsedCapacity),
    elapsedUtilization: ratio(completedDayCost, elapsedCapacity),
    remainingCapacityUsd: money(remainingCapacity),
    bestCaseMonthEndUsd: remainingCapacity != null ? money(monthToDate + Math.max(0, remainingCapacity)) : null,
    realisticMonthEndUsd: money(realistic),
    averageCompletedDayCostUsd: money(averageCompletedDayCost),
    lastSevenDaysUtilization: dailyCap != null && lastSeven.length ? ratio(lastSevenCost, dailyCap * lastSeven.length) : null,
    assumptions,
  };
}
