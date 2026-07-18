import { describe, expect, it } from "vitest";
import {
  type CandidateStatus,
  canTransitionCandidateStatus,
  transitionCandidateStatus,
} from "./candidate.js";

const ALL_STATUSES: CandidateStatus[] = ["pending", "approved", "rejected", "superseded"];

const VALID_EDGES = new Set([
  "pending->approved",
  "pending->rejected",
  "pending->superseded",
  "approved->superseded",
]);

describe("candidate status transitions", () => {
  it("matches implementation/database-schema.md §7 exactly for every from/to pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = VALID_EDGES.has(`${from}->${to}`);
        expect(canTransitionCandidateStatus(from, to)).toBe(expected);
      }
    }
  });

  it("rejects every self-transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransitionCandidateStatus(status, status)).toBe(false);
    }
  });

  it("transitionCandidateStatus returns ok for a documented edge", () => {
    const result = transitionCandidateStatus("pending", "approved");
    expect(result).toEqual({ ok: true, value: "approved" });
  });

  it("transitionCandidateStatus returns an INVALID_INPUT error for an illegal edge", () => {
    const result = transitionCandidateStatus("rejected", "approved");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects rejected/superseded as terminal states with no outgoing edges", () => {
    for (const to of ALL_STATUSES) {
      expect(canTransitionCandidateStatus("rejected", to)).toBe(false);
      expect(canTransitionCandidateStatus("superseded", to)).toBe(false);
    }
  });
});
