import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "./clock.js";

describe("SystemClock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const clock = new SystemClock();
    const now = clock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe("FixedClock", () => {
  it("always returns the fixed time", () => {
    const fixed = new Date("2026-07-18T00:00:00.000Z");
    const clock = new FixedClock(fixed);
    expect(clock.now().toISOString()).toBe("2026-07-18T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });

  it("returns a defensive copy, not the original instance", () => {
    const fixed = new Date("2026-07-18T00:00:00.000Z");
    const clock = new FixedClock(fixed);
    const first = clock.now();
    first.setFullYear(2000);
    expect(clock.now().toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });
});
