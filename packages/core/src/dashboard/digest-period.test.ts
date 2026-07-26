import type { Clock } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import {
  priorDigestPeriod,
  resolveDigestPeriod,
  resolveDigestPeriodByKey,
} from "./digest-period.js";

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/**
 * Boundaries are UTC, so every assertion below must hold in *any* zone. `withTz`
 * exists to prove that — not to make the assertions work.
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

  it("resolves the same key to the same instants in every timezone", () => {
    // The team scope's whole claim is that a given period means the same window
    // for every teammate. With local-midnight boundaries it did not: at this
    // instant Tokyo is already Monday while New York is still Sunday, so the two
    // resolved the same key to intervals eight hours apart and the "shared"
    // knowledge totals diverged.
    const instant = "2026-07-20T01:00:00.000Z";
    const zones = ["UTC", "Asia/Tokyo", "America/New_York", "Asia/Kathmandu", "Pacific/Apia"];

    const resolved = zones.map((tz) =>
      withTz(tz, () => resolveDigestPeriod("week", 0, clockAt(instant))),
    );

    for (const period of resolved) {
      expect(period).toEqual(resolved[0]);
    }
    expect(resolved[0]?.key).toBe("2026-07-20");
    expect(resolved[0]?.start).toBe("2026-07-20T00:00:00.000Z");
  });

  it("keeps a whole year of week boundaries identical across zones", () => {
    const clock = clockAt("2026-07-23T12:00:00.000Z");
    for (let offset = 0; offset < 52; offset++) {
      const utc = withTz("UTC", () => resolveDigestPeriod("week", offset, clock));
      for (const tz of ["Asia/Tokyo", "America/New_York", "Asia/Kathmandu"]) {
        expect(
          withTz(tz, () => resolveDigestPeriod("week", offset, clock)),
          `${tz} @${offset}`,
        ).toEqual(utc);
      }
    }
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

  it("is always 168 hours, because UTC has no DST transitions", () => {
    // A local-calendar week spanning a DST change is 167 or 169 hours. Anchoring
    // in UTC removes the case, and with it the boundary overlap it produced.
    withTz("America/New_York", () => {
      const period = resolveDigestPeriod("week", 0, clockAt("2026-03-05T12:00:00.000Z"));

      expect(period.key).toBe("2026-03-02");
      const hours = (new Date(period.end).getTime() - new Date(period.start).getTime()) / 3_600_000;
      expect(hours).toBe(168);
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

describe("adjacent periods share their boundary exactly", () => {
  /**
   * Both zones move their clock at local midnight, which is what first exposed
   * this: deriving a period's end by advancing from its own (shifted) start
   * carried the shift into the end while the next period recomputed midnight
   * cleanly, leaving a one-hour overlap in which one event counted toward both
   * `value` and `priorValue`. UTC anchoring removes the shift, and deriving the
   * end from the same anchor keeps the property structural rather than incidental
   * — these zones stay in the suite as the regression that proved it.
   */
  const OVERLAP_CASES = [
    { tz: "America/Asuncion", unit: "month" as const, now: "2023-11-15T12:00:00.000Z" },
    { tz: "Asia/Tehran", unit: "week" as const, now: "2021-03-30T12:00:00.000Z" },
  ];

  for (const { tz, unit, now } of OVERLAP_CASES) {
    it(`neither overlaps nor gaps across a midnight DST transition (${tz}, ${unit})`, () => {
      withTz(tz, () => {
        const clock = clockAt(now);
        for (let offset = 0; offset < 4; offset++) {
          const current = resolveDigestPeriod(unit, offset, clock);
          const prior = resolveDigestPeriod(unit, offset + 1, clock);

          expect(prior.end, `${prior.key} → ${current.key}`).toBe(current.start);
          expect(new Date(prior.start).getTime()).toBeLessThan(new Date(prior.end).getTime());
        }
      });
    });
  }

  it("keeps every boundary shared across a year of weeks under a half-hour-offset host zone", () => {
    withTz("Asia/Kathmandu", () => {
      const clock = clockAt("2026-07-23T12:00:00.000Z");
      for (let offset = 0; offset < 52; offset++) {
        const current = resolveDigestPeriod("week", offset, clock);
        const prior = resolveDigestPeriod("week", offset + 1, clock);
        expect(prior.end, prior.key).toBe(current.start);
      }
    });
  });
});

describe("resolveDigestPeriodByKey", () => {
  it("finds the period a key names", () => {
    withTz("UTC", () => {
      const clock = clockAt("2026-07-23T12:00:00.000Z");

      const found = resolveDigestPeriodByKey("week", "2026-07-13", clock, 520);

      expect(found?.key).toBe("2026-07-13");
      expect(found?.offset).toBe(1);
      expect(found?.start).toBe("2026-07-13T00:00:00.000Z");
    });
  });

  it("finds the current period's own key", () => {
    withTz("UTC", () => {
      const found = resolveDigestPeriodByKey(
        "week",
        "2026-07-20",
        clockAt("2026-07-23T12:00:00.000Z"),
        520,
      );

      expect(found?.offset).toBe(0);
    });
  });

  it("resolves a month key", () => {
    withTz("UTC", () => {
      const found = resolveDigestPeriodByKey(
        "month",
        "2026-05",
        clockAt("2026-07-23T12:00:00.000Z"),
        520,
      );

      expect(found?.offset).toBe(2);
      expect(found?.end).toBe("2026-06-01T00:00:00.000Z");
    });
  });

  it("returns null for a key no period produces", () => {
    withTz("UTC", () => {
      const clock = clockAt("2026-07-23T12:00:00.000Z");

      // A Wednesday — never a week start — and a future week.
      expect(resolveDigestPeriodByKey("week", "2026-07-22", clock, 520)).toBeNull();
      expect(resolveDigestPeriodByKey("week", "2026-08-03", clock, 520)).toBeNull();
      expect(resolveDigestPeriodByKey("week", "not-a-date", clock, 520)).toBeNull();
    });
  });

  it("returns null for a key beyond the offset it is allowed to search", () => {
    withTz("UTC", () => {
      const clock = clockAt("2026-07-23T12:00:00.000Z");

      expect(resolveDigestPeriodByKey("week", "2026-07-13", clock, 0)).toBeNull();
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
