// Standard 5-field cron expressions ("minute hour day-of-month month day-of-week"), evaluated in UTC.

export type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, min: number, max: number, names: string[] | null, label: string): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    const lower = s.toLowerCase();
    const named = names?.indexOf(lower.slice(0, 3)) ?? -1;
    const n = named >= 0 && /^[a-z]+$/.test(lower) ? named + (min === 1 ? 1 : 0) : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`Invalid cron ${label} "${s}": expected ${min}-${max}${names ? ` or a name like "${names[1]}"` : ""}.`);
    }
    return n;
  };
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/") as [string, string | undefined];
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}" in ${label}.`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      [lo, hi] = [num(a), num(b)];
      if (lo > hi) throw new Error(`Invalid cron range "${range}" in ${label}.`);
    } else {
      lo = num(range);
      hi = stepStr === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields "minute hour day month weekday", e.g. "*/15 * * * *".`);
  }
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const weekdays = parseField(dow, 0, 7, DAY_NAMES, "weekday");
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes: parseField(mi, 0, 59, null, "minute"),
    hours: parseField(h, 0, 23, null, "hour"),
    days: parseField(dom, 1, 31, null, "day of month"),
    months: parseField(mon, 1, 12, MONTH_NAMES, "month"),
    weekdays,
    anyDay: dom === "*",
    anyWeekday: dow === "*",
  };
}

/** The first matching minute strictly after `after` (ms since epoch, UTC). */
export function nextCronTime(cron: ParsedCron, after: number): number {
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const dayMatches = () => {
    const dom = cron.days.has(d.getUTCDate());
    const dow = cron.weekdays.has(d.getUTCDay());
    if (cron.anyDay && cron.anyWeekday) return true;
    if (cron.anyDay) return dow;
    if (cron.anyWeekday) return dom;
    return dom || dow; // classic cron: either restriction matches
  };
  for (let i = 0; i < 100_000; i++) {
    if (!cron.months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0);
    } else if (!dayMatches()) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0);
    } else if (!cron.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0);
    } else if (!cron.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
    } else {
      return d.getTime();
    }
  }
  throw new Error("Cron expression never matches (e.g. February 30th).");
}
