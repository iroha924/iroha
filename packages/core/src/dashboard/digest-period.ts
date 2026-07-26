/**
 * Digest period arithmetic: anchored calendar periods, not a rolling window.
 *
 * A back issue needs a stable identity — "the week of 2026-07-20" must mean the
 * same seven days whenever it is opened, so prose composed for it still lines up
 * with its numbers a month later. A rolling "last 7 days" has no such identity:
 * every page load would silently be a different period.
 *
 * Boundaries are calendar boundaries **in the host's local timezone**, then
 * converted to UTC instants for querying — the same split
 * contracts/dashboard-api.md §8 makes everywhere else (values UTC, display
 * local). A developer's "this week" starts at local midnight Monday, not at
 * whatever local time UTC midnight happens to be.
 *
 * All arithmetic goes through `Date`'s local-time setters, which is what makes
 * the period a calendar period rather than a fixed number of milliseconds: a
 * week spanning a DST transition is correctly 167 or 169 hours, and adding a
 * month to January 31 lands on March 1 only if that is what the calendar says.
 * The period *key* is likewise built from local date parts — `toISOString()`
 * would shift the date across the UTC boundary and label a Monday-start week
 * with the preceding Sunday in any timezone east of UTC.
 */
import type { Clock } from "@iroha/domain";

export type DigestPeriodUnit = "week" | "month";

export interface DigestPeriod {
  unit: DigestPeriodUnit;
  /**
   * Stable identity for a back issue: the local start date (`2026-07-20`) for a
   * week, the local month (`2026-07`) for a month.
   */
  key: string;
  /** Inclusive start, as a UTC instant. */
  start: string;
  /** Exclusive end, as a UTC instant — the window is half-open `[start, end)`. */
  end: string;
  /** 0 is the period containing "now"; 1 the one before it, and so on. */
  offset: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local midnight of `instant`'s calendar day, as a new Date. */
function startOfLocalDay(instant: Date): Date {
  const day = new Date(instant.getTime());
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * Local midnight of the Monday that starts `instant`'s week, `offset` weeks
 * back. `getDay()` is 0 for Sunday, so `(day + 6) % 7` is the number of days
 * since Monday — which makes Sunday the last day of its week (ISO-8601), not the
 * first day of the next.
 */
function weekStart(instant: Date, offset: number): Date {
  const start = startOfLocalDay(instant);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - offset * 7);
  return start;
}

/**
 * Local midnight of the first day of `instant`'s month, `offset` months back.
 * The day is pinned to 1 *before* the month is shifted: shifting first would
 * overflow (setting January 31 back one month lands in March).
 */
function monthStart(instant: Date, offset: number): Date {
  const start = startOfLocalDay(instant);
  start.setDate(1);
  start.setMonth(start.getMonth() - offset);
  return start;
}

/** Local midnight at which the `offset`-th period back begins. */
function periodStart(unit: DigestPeriodUnit, instant: Date, offset: number): Date {
  return unit === "week" ? weekStart(instant, offset) : monthStart(instant, offset);
}

function periodKey(unit: DigestPeriodUnit, start: Date): string {
  const yearMonth = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`;
  return unit === "week" ? `${yearMonth}-${pad2(start.getDate())}` : yearMonth;
}

/**
 * The period `offset` units before the one containing `clock.now()`. `offset: 0`
 * is the current, still-incomplete period — the Digest is meant to be readable
 * mid-week, so its window deliberately extends past "now" and simply contains no
 * events yet for the days that have not happened.
 *
 * The end is the *next* period's start, anchored the same way, never this start
 * plus one unit. Those differ: `setHours(0,0,0,0)` cannot produce a local midnight
 * that does not exist, so on a day whose DST transition is at midnight it resolves
 * an hour off — and advancing from that shifted start carries the shift into the
 * end, while the next period recomputes midnight cleanly. Adjacent windows would
 * then overlap by an hour and count one event in both (reproduced for
 * `America/Asuncion` 2023-11-01 and `Asia/Tehran` 2021-03-22). Deriving the end
 * from the same anchor makes the boundary shared by construction, so no overlap
 * or gap is representable.
 */
export function resolveDigestPeriod(
  unit: DigestPeriodUnit,
  offset: number,
  clock: Clock,
): DigestPeriod {
  const now = clock.now();
  const start = periodStart(unit, now, offset);
  const end = periodStart(unit, now, offset - 1);
  return {
    unit,
    key: periodKey(unit, start),
    start: start.toISOString(),
    end: end.toISOString(),
    offset,
  };
}

/**
 * The period immediately before `period`, for the prior-period comparison.
 * Re-resolved from the clock rather than derived by subtracting `period`'s own
 * duration, so the previous month is that month's real length.
 */
export function priorDigestPeriod(period: DigestPeriod, clock: Clock): DigestPeriod {
  return resolveDigestPeriod(period.unit, period.offset + 1, clock);
}

/**
 * The period a stored `key` names, or `null` when no period within
 * `maxOffset` produces it.
 *
 * Resolved by walking offsets rather than parsing the key back into local
 * boundaries: the key is *produced* by this module's anchoring, so re-deriving it
 * the same way is the only way to be sure the two agree. An inverse parser would
 * be a second implementation of the calendar rules, free to disagree exactly where
 * it matters (DST, month length).
 *
 * This is what lets a composition name the period it was written for instead of
 * re-resolving one from an offset the caller may have dropped — the bug where an
 * omitted argument published last week's narrative as this week's issue.
 */
export function resolveDigestPeriodByKey(
  unit: DigestPeriodUnit,
  key: string,
  clock: Clock,
  maxOffset: number,
): DigestPeriod | null {
  for (let offset = 0; offset <= maxOffset; offset++) {
    const period = resolveDigestPeriod(unit, offset, clock);
    if (period.key === key) {
      return period;
    }
  }
  return null;
}
