import { describe, expect, it } from "vitest";
import { canTransitionTurnStatus, type TurnStatus, transitionTurnStatus } from "./turn.js";

const ALL_STATUSES: TurnStatus[] = ["active", "completed", "failed", "interrupted"];

const VALID_EDGES = new Set(["active->completed", "active->failed", "active->interrupted"]);

describe("turn status transitions", () => {
  it("matches implementation/database-schema.md §7 exactly for every from/to pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = VALID_EDGES.has(`${from}->${to}`);
        expect(canTransitionTurnStatus(from, to)).toBe(expected);
      }
    }
  });

  it("rejects every self-transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransitionTurnStatus(status, status)).toBe(false);
    }
  });

  it("treats completed/failed/interrupted as terminal", () => {
    for (const from of ["completed", "failed", "interrupted"] as const) {
      for (const to of ALL_STATUSES) {
        expect(canTransitionTurnStatus(from, to)).toBe(false);
      }
    }
  });

  it("transitionTurnStatus returns an INVALID_INPUT error for an illegal edge", () => {
    const result = transitionTurnStatus("completed", "failed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
