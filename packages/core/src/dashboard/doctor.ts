import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import { runDashboardSync } from "./sync.js";

/** The allowlisted repair operations (dashboard-api.md §5: "Repair operations are allowlisted"). */
export const DOCTOR_REPAIR_OPERATIONS = ["resync"] as const;
export type DoctorRepairOperation = (typeof DOCTOR_REPAIR_OPERATIONS)[number];

export interface DoctorRepairData {
  operation: DoctorRepairOperation;
  detail: Record<string, number>;
}

export interface DoctorRepairInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  operation: string;
}

/**
 * Runs one allowlisted repair (`POST /api/v1/doctor/repair`). The browser can
 * only trigger a fixed set of safe operations — never an arbitrary command. v0.1
 * exposes `resync`, which reconciles the DB from `.iroha/` (the repair for a
 * failed-approval dirty marker); a full `rebuild` needs the bundled migrations
 * path and is deferred.
 */
export async function doctorRepair(
  input: DoctorRepairInput,
): Promise<Result<DoctorRepairData, IrohaError>> {
  if (input.operation !== "resync") {
    return err(
      new IrohaErrorClass("INVALID_INPUT", `Unknown repair operation: ${input.operation}`, {
        details: { allowed: DOCTOR_REPAIR_OPERATIONS },
      }),
    );
  }
  const result = await runDashboardSync({
    cwd: input.cwd,
    clock: input.clock,
    random: input.random,
  });
  if (!result.ok) {
    return result;
  }
  return ok({
    operation: "resync",
    detail: {
      added: result.value.added,
      changed: result.value.changed,
      unchanged: result.value.unchanged,
      deleted: result.value.deleted,
    },
  });
}
