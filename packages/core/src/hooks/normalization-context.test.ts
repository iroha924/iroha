import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { createNormalizationContext } from "./normalization-context.js";

const clock = new FixedClock(new Date("2026-07-20T00:00:00.000Z"));
const random = new CryptoRandomSource();
const saltA = new Uint8Array(32).fill(7);
const saltB = new Uint8Array(32).fill(9);

describe("createNormalizationContext", () => {
  it("produces a well-formed hmac-sha256 digest", () => {
    const ctx = createNormalizationContext(saltA, clock, random);
    expect(ctx.digest("pnpm test")).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic for the same value and salt", () => {
    const ctx = createNormalizationContext(saltA, clock, random);
    expect(ctx.digest("why repository pattern?")).toBe(ctx.digest("why repository pattern?"));
  });

  it("produces different digests for different values", () => {
    const ctx = createNormalizationContext(saltA, clock, random);
    expect(ctx.digest("a")).not.toBe(ctx.digest("b"));
  });

  it("produces different digests under a different repository salt", () => {
    const a = createNormalizationContext(saltA, clock, random);
    const b = createNormalizationContext(saltB, clock, random);
    expect(a.digest("same input")).not.toBe(b.digest("same input"));
  });

  it("mints a valid evt_ event id", () => {
    const ctx = createNormalizationContext(saltA, clock, random);
    expect(ctx.newEventId()).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("stamps the clock time as an ISO-8601 UTC string", () => {
    const ctx = createNormalizationContext(saltA, clock, random);
    expect(ctx.occurredAt()).toBe("2026-07-20T00:00:00.000Z");
  });
});
