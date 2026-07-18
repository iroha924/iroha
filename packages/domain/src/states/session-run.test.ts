import { describe, expect, it } from "vitest";
import {
  canTransitionSessionRunStatus,
  type SessionRunStatus,
  transitionSessionRunStatus,
  validateSessionRunEndedAtInvariant,
} from "./session-run.js";

const ALL_STATUSES: SessionRunStatus[] = ["active", "completed", "interrupted", "abandoned"];

const VALID_EDGES = new Set([
  "active->completed",
  "active->interrupted",
  "active->abandoned",
  "interrupted->abandoned",
]);

describe("session run status transitions", () => {
  it("matches implementation/database-schema.md §7 exactly for every from/to pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = VALID_EDGES.has(`${from}->${to}`);
        expect(canTransitionSessionRunStatus(from, to)).toBe(expected);
      }
    }
  });

  it("rejects every self-transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransitionSessionRunStatus(status, status)).toBe(false);
    }
  });

  it("never allows a transition back to active (resume creates a new Run)", () => {
    for (const from of ALL_STATUSES) {
      expect(canTransitionSessionRunStatus(from, "active")).toBe(false);
    }
  });

  it("transitionSessionRunStatus returns an INVALID_INPUT error for an illegal edge", () => {
    const result = transitionSessionRunStatus("completed", "active");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("validateSessionRunEndedAtInvariant", () => {
  it("accepts an active run with no endedAt", () => {
    expect(validateSessionRunEndedAtInvariant("active", null)).toEqual({ ok: true, value: true });
  });

  it("rejects an active run with endedAt set", () => {
    const result = validateSessionRunEndedAtInvariant("active", new Date());
    expect(result.ok).toBe(false);
  });

  it("accepts a completed run with endedAt set", () => {
    expect(validateSessionRunEndedAtInvariant("completed", new Date())).toEqual({
      ok: true,
      value: true,
    });
  });

  it("rejects a completed run with no endedAt", () => {
    const result = validateSessionRunEndedAtInvariant("completed", null);
    expect(result.ok).toBe(false);
  });
});
