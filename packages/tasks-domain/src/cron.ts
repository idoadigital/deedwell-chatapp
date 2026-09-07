/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in
 * an IANA time zone. Supports `*`, lists, ranges, and steps (`*\/15`, `1-5/2`),
 * plus month and weekday names. Deliberately dependency-free: the schedule of
 * a recurring task must not hinge on a library's interpretation of "next".
 *
 * Day-of-month and day-of-week follow Vixie cron: when both are restricted,
 * a day matches if EITHER does.
 */
export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number> | null;   // null = unrestricted
  month: Set<number>;
  dayOfWeek: Set<number> | null;    // 0 = Sunday
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const PRESETS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 9 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 9 * * 1",
  "@monthly": "0 9 1 * *",
  "@yearly": "0 9 1 1 *",
  "@annually": "0 9 1 1 *",
};

export class CronError extends Error {}

function parseField(raw: string, min: number, max: number, names: string[] | null): Set<number> | null {
  const out = new Set<number>();
  let unrestricted = false;
  for (const part of raw.split(",")) {
    const [rangePart = "*", stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Bad step in "${part}"`);
    let lo: number; let hi: number;
    const norm = (s: string): number => {
      const lower = s.toLowerCase();
      const idx = names ? names.indexOf(lower.slice(0, 3)) : -1;
      if (idx >= 0) return idx + (names === MONTHS ? 1 : 0);
      const n = Number(s);
      if (!Number.isInteger(n)) throw new CronError(`Bad value "${s}"`);
      return n;
    };
    if (rangePart === "*" || rangePart === "?") {
      lo = min; hi = max;
      if (stepPart === undefined) unrestricted = true;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = norm(a!); hi = norm(b!);
    } else {
      lo = norm(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (names === DAYS) { if (lo === 7) lo = 0; if (hi === 7) hi = 0; }
    if (lo < min || hi > max || lo > hi) throw new CronError(`Value out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return unrestricted ? null : out;
}

export function parseCron(expression: string): CronSpec {
  const text = (PRESETS[expression.trim().toLowerCase()] ?? expression).trim().split(/\s+/);
  if (text.length !== 5) throw new CronError("A schedule needs five fields: minute hour day month weekday");
  const [m, h, dom, mon, dow] = text as [string, string, string, string, string];
  const full = (s: Set<number> | null, lo: number, hi: number) => s ?? new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  return {
    minute: full(parseField(m, 0, 59, null), 0, 59),
    hour: full(parseField(h, 0, 23, null), 0, 23),
    dayOfMonth: parseField(dom, 1, 31, null),
    month: full(parseField(mon, 1, 12, MONTHS), 1, 12),
    dayOfWeek: parseField(dow, 0, 7, DAYS),
  };
}

export function isValidCron(expression: string): boolean {
  try { parseCron(expression); return true; } catch { return false; }
}

interface WallClock { minute: number; hour: number; day: number; month: number; weekday: number; year: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: Date, timeZone: string): WallClock {
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    fmtCache.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute), hour: Number(parts.hour) % 24, day: Number(parts.day),
    month: Number(parts.month), year: Number(parts.year), weekday: DAYS.indexOf(parts.weekday!.toLowerCase()),
  };
}

function dayMatches(spec: CronSpec, wc: WallClock): boolean {
  if (!spec.month.has(wc.month)) return false;
  const domOk = spec.dayOfMonth === null || spec.dayOfMonth.has(wc.day);
  const dowOk = spec.dayOfWeek === null || spec.dayOfWeek.has(wc.weekday);
  if (spec.dayOfMonth !== null && spec.dayOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

/**
 * The first instant strictly after `after` that matches, or null if none
 * within ~2 years (e.g. "31 2 * * *" never fires). Walks minutes but skips
 * whole days and hours that cannot match, so a monthly schedule resolves in
 * well under a millisecond of work per day scanned.
 */
export function nextCronRun(expression: string, after: Date, timeZone = "UTC"): Date | null {
  const spec = parseCron(expression);
  const MINUTE = 60_000;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = after.getTime() + 2 * 366 * 24 * 60 * MINUTE;
  while (t <= limit) {
    const wc = wallClock(new Date(t), timeZone);
    if (!dayMatches(spec, wc)) {
      // Jump to the next local midnight-ish: advance to the end of this hour
      // repeatedly is wasteful, so step by the remaining minutes of the day.
      t += ((23 - wc.hour) * 60 + (60 - wc.minute)) * MINUTE;
      continue;
    }
    if (!spec.hour.has(wc.hour)) { t += (60 - wc.minute) * MINUTE; continue; }
    if (!spec.minute.has(wc.minute)) { t += MINUTE; continue; }
    return new Date(t);
  }
  return null;
}

/** Human summary for the UI and chat ("Every weekday at 9:00 AM"). */
export function describeCron(expression: string): string {
  let spec: CronSpec;
  try { spec = parseCron(expression); } catch { return expression; }
  const time = (() => {
    if (spec.minute.size === 1 && spec.hour.size === 1) {
      const h = [...spec.hour][0]!; const m = [...spec.minute][0]!;
      const ampm = h >= 12 ? "PM" : "AM"; const hh = h % 12 === 0 ? 12 : h % 12;
      return `at ${hh}:${String(m).padStart(2, "0")} ${ampm}`;
    }
    if (spec.minute.size === 1 && spec.hour.size === 24) return "every hour";
    return `at ${[...spec.hour].length} times a day`;
  })();
  const dow = spec.dayOfWeek ? [...spec.dayOfWeek].sort() : null;
  const dom = spec.dayOfMonth ? [...spec.dayOfMonth].sort((a, b) => a - b) : null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const names: Record<number, string> = { 0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday" };
  if (dow && !dom) {
    if (dow.join() === "1,2,3,4,5") return `Every weekday ${time}`;
    if (dow.length === 7) return `Every day ${time}`;
    return `Every ${dow.map((d) => names[d]).join(", ")} ${time}`;
  }
  if (dom && !dow) {
    if (spec.month.size === 12) return `Monthly on the ${dom.map(ordinal).join(", ")} ${time}`;
    return `On the ${dom.map(ordinal).join(", ")} of ${[...spec.month].map((m) => cap(MONTHS[m - 1]!)).join(", ")} ${time}`;
  }
  if (spec.minute.size === 1 && spec.hour.size === 24) return "Every hour";
  return `Every day ${time}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]; const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
