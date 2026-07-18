import { IrohaError } from "../errors/error-code.js";
import { err, ok, type Result } from "../errors/result.js";
import { createTransitionValidator } from "./transition.js";

/**
 * Matches migrations/001_initial.sql `candidates.status` and
 * implementation/database-schema.md §7 "Candidate".
 */
export type CandidateStatus = "pending" | "approved" | "rejected" | "superseded";

const CANDIDATE_TRANSITIONS: ReadonlyArray<readonly [CandidateStatus, CandidateStatus]> = [
  ["pending", "approved"],
  ["pending", "rejected"],
  ["pending", "superseded"],
  ["approved", "superseded"],
];

export const canTransitionCandidateStatus = createTransitionValidator(CANDIDATE_TRANSITIONS);

export function transitionCandidateStatus(
  from: CandidateStatus,
  to: CandidateStatus,
): Result<CandidateStatus, IrohaError> {
  if (canTransitionCandidateStatus(from, to)) {
    return ok(to);
  }
  return err(
    new IrohaError("INVALID_INPUT", `Illegal candidate status transition: ${from} -> ${to}`, {
      details: { from, to },
    }),
  );
}
