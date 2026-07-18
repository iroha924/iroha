import { describe, expect, it } from "vitest";
import { FixedClock } from "../ports/clock.js";
import { FixedRandomSource } from "../ports/random.js";
import { generateUlid, isValidUlid } from "./ulid.js";

/**
 * Expected values below were computed independently in Python (big-integer
 * bit shifting, not the streaming bit-buffer this module uses) to cross-check
 * the encoder rather than merely asserting the implementation agrees with itself.
 */
describe("generateUlid", () => {
  it("encodes timestamp 0 and all-zero randomness", () => {
    const clock = new FixedClock(new Date(0));
    const random = new FixedRandomSource(new Uint8Array(10));
    expect(generateUlid(clock, random)).toBe("0000000000" + "0000000000000000");
  });

  it("encodes timestamp 1 with sequential randomness bytes", () => {
    const clock = new FixedClock(new Date(1));
    const random = new FixedRandomSource(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(generateUlid(clock, random)).toBe("0000000001" + "000G40R40M30E209");
  });

  it("encodes an arbitrary timestamp and descending-byte randomness", () => {
    const clock = new FixedClock(new Date(1721260800000));
    const random = new FixedRandomSource(
      Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248, 247, 246]),
    );
    expect(generateUlid(clock, random)).toBe("01J31J6Y00ZZZFVZ7VZBWZHXZP");
  });

  it("encodes all-0xFF randomness as all Z", () => {
    const clock = new FixedClock(new Date(0));
    const random = new FixedRandomSource(new Uint8Array(10).fill(0xff));
    expect(generateUlid(clock, random)).toBe("0000000000" + "ZZZZZZZZZZZZZZZZ");
  });

  it("encodes the maximum 48-bit timestamp", () => {
    const clock = new FixedClock(new Date(2 ** 48 - 1));
    const random = new FixedRandomSource(new Uint8Array(10));
    expect(generateUlid(clock, random)).toBe("7ZZZZZZZZZ" + "0000000000000000");
  });

  it("throws for a timestamp beyond the 48-bit range", () => {
    const clock = new FixedClock(new Date(2 ** 48));
    const random = new FixedRandomSource(new Uint8Array(10));
    expect(() => generateUlid(clock, random)).toThrow(RangeError);
  });

  it("always produces a value that matches isValidUlid", () => {
    const clock = new FixedClock(new Date(1721260800000));
    const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const id = generateUlid(clock, random);
    expect(id).toHaveLength(26);
    expect(isValidUlid(id)).toBe(true);
  });
});

describe("isValidUlid", () => {
  it("accepts a well-formed 26-character Crockford Base32 string", () => {
    expect(isValidUlid("01J31J6Y00ZZZFVZ7VZBWZHXZP")).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isValidUlid("01J31J6Y00ZZZFVZ7VZBWZHXZ")).toBe(false);
    expect(isValidUlid("01J31J6Y00ZZZFVZ7VZBWZHXZPP")).toBe(false);
  });

  it("rejects excluded letters I, L, O, U", () => {
    for (const bad of ["I", "L", "O", "U"]) {
      expect(isValidUlid(`0000000000000000000000000${bad}`)).toBe(false);
    }
  });

  it("rejects lowercase letters", () => {
    expect(isValidUlid("01j31j6y00zzzfvz7vzbwzhxzp")).toBe(false);
  });
});
