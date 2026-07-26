import type { Clock } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { priorDigestPeriod, resolveDigestPeriod } from "./digest-period.js";

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/**
 * Every assertion here is written against a fixed `TZ`. Calendar boundaries are
 * local by design, so a test that did not pin the zone would assert the machine's
 * configuration rather than the arithmetic.
 */
const ORIGINAL_TZ = process.env.TZ;

function withTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  }
}

describe("resolveDigestPeriod — week", () => {
  it("anchors to the Monday of the current week in local time", () => {
    withTz("UTC", () => {
      // 2026-07-23 is a Thursday.
      const period = resolveDigestPeriod("week", 0, clockAt("2026-07-23T12:00:00.000Z"));

      expect(period.key).toBe("2026-07-20");
      expect(period.start).toBe("2026-07-20T00:00:00.000Z");
      expect(period.end).toBe("2026-07-27T00:00:00.000Z");
    });
  });

  it("treats Sunday as the last day of its week, not the first of the next", () => {
    withTz("UTC", () => {
      // 2026-07-26 is a Sunday; ISO-8601 puts it in the week starting 07-20.
      const period = resolveDigestPeriod("week", 0, clockAt("2026-07-26T23:00:00.000Z"));

      expect(period.key).toBe("2026-07-20");
    });
  });

  it("derives boundaries from the local calendar, not the UTC one", () => {
    // 2026-07-20T01:00Z is 2026-07-20 10:00 in Tokyo (Monday) but still
    // 2026-07-19 21:00 in New York (Sunday) — so the two zones are in different
    // ISO weeks at the same instant.
    const instant = "2026-07-20T01:00:00.000Z";

    const tokyo = withTz("Asia/Tokyo", () => resolveDigestPeriod("week", 0, clockAt(instant)));
    const newYork = withTz("America/New_York", () =>
      resolveDigestPeriod("week", 0, clockAt(instant)),
    );

    expect(tokyo.key).toBe("2026-07-20");
    expect(newYork.key).toBe("2026-07-13");
    // Tokyo's local midnight is the previous UTC day — the key must come from
    // local date parts, which `toISOString()` would have shifted back to 07-19.
    expect(tokyo.start).toBe("2026-07-19T15:00:00.000Z");
  });

  it("walks back whole weeks for a back issue", () => {
    withTz("UTC", () => {
      const period = resolveDigestPeriod("week", 3, clockAt("2026-07-23T12:00:00.000Z"));

      expect(period.key).toBe("2026-06-29");
      expect(period.start).toBe("2026-06-29T00:00:00.000Z");
      expect(period.end).toBe("2026-07-06T00:00:00.000Z");
      expect(period.offset).toBe(3);
    });
  });

  it("crosses a year boundary", () => {
    withTz("UTC", () => {
      const period = resolveDigestPeriod("week", 1, clockAt("2027-01-06T12:00:00.000Z"));

      expect(period.key).toBe("2026-12-28");
      expect(period.end).toBe("2027-01-04T00:00:00.000Z");
    });
  });

  it("keeps calendar boundaries across a DST transition rather than a fixed 168 hours", () => {
    withTz("America/New_York", () => {
      // US DST began 2026-03-08, inside the week starting Monday 2026-03-02.
      const period = resolveDigestPeriod("week", 0, clockAt("2026-03-05T12:00:00.000Z"));

      expect(period.key).toBe("2026-03-02");
      const hours = (new Date(period.end).getTime() - new Date(period.start).getTime()) / 3_600_000;
      expect(hours).toBe(167);
    });
  });
});

describe("resolveDigestPeriod — month", () => {
  it("anchors to the first of the local month", () => {
    withTz("UTC", () => {
      const period = resolveDigestPeriod("month", 0, clockAt("2026-07-23T12:00:00.000Z"));

      expect(period.key).toBe("2026-07");
      expect(period.start).toBe("2026-07-01T00:00:00.000Z");
      expect(period.end).toBe("2026-08-01T00:00:00.000Z");
    });
  });

  it("does not overflow when stepping back from a 31-day month", () => {
    withTz("UTC", () => {
      // Naively shifting the month on the 31st would land in March.
      const period = resolveDigestPeriod("month", 1, clockAt("2026-03-31T12:00:00.000Z"));

      expect(period.key).toBe("2026-02");
      expect(period.start).toBe("2026-02-01T00:00:00.000Z");
      expect(period.end).toBe("2026-03-01T00:00:00.000Z");
    });
  });

  it("walks back across a year boundary", () => {
    withTz("UTC", () => {
      const period = resolveDigestPeriod("month", 2, clockAt("2027-01-15T12:00:00.000Z"));

      expect(period.key).toBe("2026-11");
      expect(period.end).toBe("2026-12-01T00:00:00.000Z");
    });
  });
});

describe("priorDigestPeriod", () => {
  it("is the period immediately before, sharing its unit", () => {
    withTz("UTC", () => {
      const clock = clockAt("2026-07-23T12:00:00.000Z");
      const current = resolveDigestPeriod("week", 0, clock);

      const prior = priorDigestPeriod(current, clock);

      expect(prior.key).toBe("2026-07-13");
      expect(prior.end).toBe(current.start);
      expect(prior.unit).toBe("week");
      expect(prior.offset).toBe(1);
    });
  });

  it("gives the previous month its own real length, not the current month's", () => {
    withTz("UTC", () => {
      const clock = clockAt("2026-03-15T12:00:00.000Z");
      const current = resolveDigestPeriod("month", 0, clock);

      const prior = priorDigestPeriod(current, clock);

      expect(prior.key).toBe("2026-02");
      expect(prior.start).toBe("2026-02-01T00:00:00.000Z");
      // February 2026 has 28 days; subtracting March's 31 would have landed in January.
      expect(prior.end).toBe("2026-03-01T00:00:00.000Z");
    });
  });
});
