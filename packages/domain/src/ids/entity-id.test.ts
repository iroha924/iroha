import { describe, expect, it } from "vitest";
import { FixedClock } from "../ports/clock.js";
import { FixedRandomSource } from "../ports/random.js";
import {
  CANONICAL_ID_PREFIXES,
  ID_PREFIXES,
  isCanonicalEntityId,
  isTypedId,
  LOCAL_ID_PREFIXES,
  makeTypedId,
  parseCanonicalEntityId,
  parseTypedId,
} from "./entity-id.js";

const clock = new FixedClock(new Date(1721260800000));
const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const ULID_SUFFIX = "01J31J6Y00XG40S40T50Y60Z7A";

describe("makeTypedId", () => {
  it("produces a value accepted by isTypedId for the same prefix", () => {
    for (const prefix of ID_PREFIXES) {
      const id = makeTypedId(prefix, clock, random);
      expect(isTypedId(prefix, id)).toBe(true);
    }
  });
});

describe("isTypedId / parseTypedId", () => {
  it("every prefix rejects a value tagged with a different prefix", () => {
    for (const ownPrefix of ID_PREFIXES) {
      const value = `${ownPrefix}_${ULID_SUFFIX}`;
      for (const otherPrefix of ID_PREFIXES) {
        if (otherPrefix === ownPrefix) {
          continue;
        }
        expect(isTypedId(otherPrefix, value)).toBe(false);
        const result = parseTypedId(otherPrefix, value);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("INVALID_INPUT");
        }
      }
    }
  });

  it("accepts a value with its own prefix and a valid ULID", () => {
    for (const prefix of ID_PREFIXES) {
      const value = `${prefix}_${ULID_SUFFIX}`;
      expect(isTypedId(prefix, value)).toBe(true);
      const result = parseTypedId(prefix, value);
      expect(result).toEqual({ ok: true, value });
    }
  });

  it("rejects a correct prefix with a malformed ULID suffix", () => {
    expect(isTypedId("ses", "ses_not-a-ulid")).toBe(false);
    expect(isTypedId("ses", "ses_")).toBe(false);
  });

  it("rejects a prefix that merely starts with the target prefix (no separator boundary bleed)", () => {
    // "session" starts with "ses" but is not the "ses_" prefix.
    expect(isTypedId("ses", `session_${ULID_SUFFIX}`)).toBe(false);
  });
});

describe("canonical vs local prefixes", () => {
  it("CANONICAL_ID_PREFIXES and LOCAL_ID_PREFIXES are disjoint and cover ID_PREFIXES", () => {
    const canonicalSet = new Set<string>(CANONICAL_ID_PREFIXES);
    const localSet = new Set<string>(LOCAL_ID_PREFIXES);
    for (const prefix of CANONICAL_ID_PREFIXES) {
      expect(localSet.has(prefix)).toBe(false);
    }
    expect(canonicalSet.size + localSet.size).toBe(ID_PREFIXES.length);
  });

  it("isCanonicalEntityId accepts every canonical prefix", () => {
    for (const prefix of CANONICAL_ID_PREFIXES) {
      expect(isCanonicalEntityId(`${prefix}_${ULID_SUFFIX}`)).toBe(true);
    }
  });

  it("isCanonicalEntityId rejects every local-only prefix", () => {
    for (const prefix of LOCAL_ID_PREFIXES) {
      expect(isCanonicalEntityId(`${prefix}_${ULID_SUFFIX}`)).toBe(false);
      const result = parseCanonicalEntityId(`${prefix}_${ULID_SUFFIX}`);
      expect(result.ok).toBe(false);
    }
  });
});
