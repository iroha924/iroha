import { IrohaError } from "../errors/error-code.js";
import { err, ok, type Result } from "../errors/result.js";
import { createTransitionValidator } from "./transition.js";

/**
 * Matches migrations/001_initial.sql `session_runs.status` and
 * implementation/database-schema.md §7 "Session Run". Resume creates a new
 * Run; it never reactivates a previous one, so no transition targets "active".
 */
export type SessionRunStatus = "active" | "completed" | "interrupted" | "abandoned";

const SESSION_RUN_TRANSITIONS: ReadonlyArray<readonly [SessionRunStatus, SessionRunStatus]> = [
  ["active", "completed"],
  ["active", "interrupted"],
  ["active", "abandoned"],
  ["interrupted", "abandoned"],
];

export const canTransitionSessionRunStatus = createTransitionValidator(SESSION_RUN_TRANSITIONS);

export function transitionSessionRunStatus(
  from: SessionRunStatus,
  to: SessionRunStatus,
): Result<SessionRunStatus, IrohaError> {
  if (canTransitionSessionRunStatus(from, to)) {
    return ok(to);
  }
  return err(
    new IrohaError("INVALID_INPUT", `Illegal session run status transition: ${from} -> ${to}`, {
      details: { from, to },
    }),
  );
}

/**
 * Matches the migration's `CHECK ((status = 'active' AND ended_at IS NULL) OR status <> 'active')`:
 * an active Run must not yet have an end timestamp, and a non-active Run must have one.
 */
export function validateSessionRunEndedAtInvariant(
  status: SessionRunStatus,
  endedAt: Date | null,
): Result<true, IrohaError> {
  if (status === "active" && endedAt !== null) {
    return err(
      new IrohaError("INVALID_INPUT", "An active session run must not have endedAt set", {
        details: { status, endedAt: endedAt.toISOString() },
      }),
    );
  }
  if (status !== "active" && endedAt === null) {
    return err(
      new IrohaError("INVALID_INPUT", `A "${status}" session run must have endedAt set`, {
        details: { status },
      }),
    );
  }
  return ok(true);
}
