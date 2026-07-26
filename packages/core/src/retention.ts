/**
 * Local event-data retention (FR-111): the one privacy control over how long the
 * disposable local index keeps raw session activity.
 *
 * The setting lives in the `local_settings` table, not `.iroha/config.yaml`.
 * `config.yaml` is Git-tracked and shared, so a retention window there would
 * impose one developer's disk and privacy preference on the whole team; the data
 * being bounded is local-only and rebuildable, so the choice is per-developer.
 * This also keeps the shared canonical config contract unchanged.
 *
 * Retention is **off unless set**. An upgrade must not silently delete history a
 * developer already has, and FR-111 asks for the window to be configurable, not
 * for a default deletion policy.
 */
import type { Clock, IrohaError, Result, TypedId } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import {
  countLocalEventData,
  type Executor,
  getLocalSetting,
  type LocalEventCounts,
  type PruneCounts,
  pruneLocalEventData,
} from "@iroha/storage";
import { z } from "zod";

/** `local_settings.key` holding the retention window. */
export const RETENTION_SETTING_KEY = "retention.local_events";

/**
 * The stored value. `days: null` means keep everything — the same state as an
 * absent row, so a developer can turn retention back off without deleting the
 * setting. The 3650-day ceiling keeps a typo from producing a cutoff so far in
 * the past that the window is meaningless.
 */
export const retentionSettingSchema = z.strictObject({
  days: z.number().int().positive().max(3650).nullable(),
});

export type RetentionSetting = z.infer<typeof retentionSettingSchema>;

export const RETENTION_DISABLED: RetentionSetting = { days: null };

/**
 * Reads the retention window. A malformed or unparseable stored value is an
 * error, not a silent fallback to "keep everything": the value governs deletion,
 * so guessing at intent is the wrong failure mode.
 */
export async function readRetentionSetting(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<RetentionSetting, IrohaError>> {
  const row = await getLocalSetting(db, repositoryId, RETENTION_SETTING_KEY);
  if (!row.ok) {
    return row;
  }
  if (row.value === null) {
    return ok(RETENTION_DISABLED);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value.valueJson);
  } catch (cause) {
    return err(
      new IrohaErrorClass("INVALID_INPUT", `Stored ${RETENTION_SETTING_KEY} is not valid JSON`, {
        cause,
      }),
    );
  }
  const validated = retentionSettingSchema.safeParse(parsed);
  if (!validated.success) {
    return err(
      new IrohaErrorClass("INVALID_INPUT", `Stored ${RETENTION_SETTING_KEY} is not a valid window`),
    );
  }
  return ok(validated.data);
}

/** The ISO-8601 instant `days` before now, or `null` when retention is off. */
export function retentionCutoff(setting: RetentionSetting, clock: Clock): string | null {
  if (setting.days === null) {
    return null;
  }
  return new Date(clock.now().getTime() - setting.days * 86_400_000).toISOString();
}

export interface RetentionOutcome {
  status: "disabled" | "pruned" | "failed";
  days: number | null;
  pruned?: PruneCounts;
  errorCode?: string;
}

/**
 * Applies the configured window, if any. Called from `iroha sync` rather than a
 * daemon (the no-daemon invariant), and **non-fatal**: a retention failure
 * reports an outcome instead of failing the sync whose canonical work already
 * succeeded, mirroring how forge and embedding failures are handled.
 */
export async function applyRetention(
  db: Executor,
  repositoryId: TypedId<"repo">,
  clock: Clock,
): Promise<RetentionOutcome> {
  const setting = await readRetentionSetting(db, repositoryId);
  if (!setting.ok) {
    return { status: "failed", days: null, errorCode: setting.error.code };
  }
  const cutoff = retentionCutoff(setting.value, clock);
  if (cutoff === null) {
    return { status: "disabled", days: null };
  }
  const pruned = await pruneLocalEventData(db, repositoryId, cutoff);
  if (!pruned.ok) {
    return { status: "failed", days: setting.value.days, errorCode: pruned.error.code };
  }
  return { status: "pruned", days: setting.value.days, pruned: pruned.value };
}

export interface RetentionStatus {
  days: number | null;
  counts: LocalEventCounts;
}

/** The window plus current row counts, so the setting's effect is observable. */
export async function readRetentionStatus(
  db: Executor,
  repositoryId: TypedId<"repo">,
  clock: Clock,
): Promise<Result<RetentionStatus, IrohaError>> {
  const setting = await readRetentionSetting(db, repositoryId);
  if (!setting.ok) {
    return setting;
  }
  const counts = await countLocalEventData(db, repositoryId, retentionCutoff(setting.value, clock));
  if (!counts.ok) {
    return counts;
  }
  return ok({ days: setting.value.days, counts: counts.value });
}
