import { IrohaError } from "../errors/error-code.js";
import { err, ok, type Result } from "../errors/result.js";
import { createTransitionValidator } from "./transition.js";

/**
 * Matches migrations/001_initial.sql `turns.status` and
 * implementation/database-schema.md §7 "Turn".
 */
export type TurnStatus = "active" | "completed" | "failed" | "interrupted";

const TURN_TRANSITIONS: ReadonlyArray<readonly [TurnStatus, TurnStatus]> = [
  ["active", "completed"],
  ["active", "failed"],
  ["active", "interrupted"],
];

export const canTransitionTurnStatus = createTransitionValidator(TURN_TRANSITIONS);

export function transitionTurnStatus(
  from: TurnStatus,
  to: TurnStatus,
): Result<TurnStatus, IrohaError> {
  if (canTransitionTurnStatus(from, to)) {
    return ok(to);
  }
  return err(
    new IrohaError("INVALID_INPUT", `Illegal turn status transition: ${from} -> ${to}`, {
      details: { from, to },
    }),
  );
}

/**
 * Matches migrations/001_initial.sql `turns.checkpoint_state`. No transition
 * graph is documented in implementation/database-schema.md beyond the valid
 * values themselves, so only the type is exported here — hooks-contract.md
 * §6.6 owns how a Turn moves between these values.
 */
export type CheckpointState = "not_required" | "pending" | "saved";
