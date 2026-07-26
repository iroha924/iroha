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
  type Database,
  type Executor,
  getLocalSetting,
  type LocalEventCounts,
  listPrunableSessions,
  pruneDigestIssues,
  pruneEventLog,
  pruneSession,
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

export interface RetentionSettingRead {
  setting: RetentionSetting;
  /**
   * The stored JSON exactly as written, or `null` for an absent row. Carried out
   * of the same read as `setting` so a sweep's guard and its cutoff can never come
   * from two different reads — which would let a change between them produce a
   * guard that matches while the cutoff belongs to the superseded window.
   */
  rawJson: string | null;
}

/**
 * Reads the retention window. A malformed or unparseable stored value is an
 * error, not a silent fallback to "keep everything": the value governs deletion,
 * so guessing at intent is the wrong failure mode.
 */
export async function readRetentionSetting(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<RetentionSettingRead, IrohaError>> {
  const row = await getLocalSetting(db, repositoryId, RETENTION_SETTING_KEY);
  if (!row.ok) {
    return row;
  }
  if (row.value === null) {
    return ok({ setting: RETENTION_DISABLED, rawJson: null });
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
  return ok({ setting: validated.data, rawJson: row.value.valueJson });
}

/** The ISO-8601 instant `days` before now, or `null` when retention is off. */
export function retentionCutoff(setting: RetentionSetting, clock: Clock): string | null {
  if (setting.days === null) {
    return null;
  }
  return new Date(clock.now().getTime() - setting.days * 86_400_000).toISOString();
}

/** What a sweep removed, reported by `iroha sync`. */
export interface PruneCounts {
  sessions: number;
  checkpoints: number;
  eventLogRows: number;
  /**
   * Composed Digest issues older than the window. Pruned with the data they
   * narrate: an issue that says "{{local.denials.total}} denials, all in
   * packages/git" renders "0 denials, all in packages/git" once the sweep removes
   * the sessions behind it — an unreviewed claim outliving its evidence, under the
   * one setting whose purpose is deliberate deletion. Losing it costs nothing;
   * `/iroha:digest` regenerates prose.
   */
  digestIssues: number;
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
  db: Database,
  repositoryId: TypedId<"repo">,
  clock: Clock,
): Promise<RetentionOutcome> {
  const setting = await readRetentionSetting(db, repositoryId);
  if (!setting.ok) {
    return { status: "failed", days: null, errorCode: setting.error.code };
  }
  const days = setting.value.setting.days;
  const cutoff = retentionCutoff(setting.value.setting, clock);
  if (cutoff === null) {
    return { status: "disabled", days: null };
  }

  const candidates = await listPrunableSessions(db, repositoryId, cutoff);
  if (!candidates.ok) {
    return { status: "failed", days, errorCode: candidates.error.code };
  }

  // The policy this sweep is authorized under. `pruneSession` re-reads it inside
  // its own write transaction and refuses to delete once it stops matching, so a
  // change committed on the dashboard's connection cannot land between the check
  // and the delete. Everything already deleted was deleted under the window in
  // force at the time, which is the intended behavior.
  const guard = { key: RETENTION_SETTING_KEY, expectedValueJson: setting.value.rawJson };

  const pruned: PruneCounts = {
    sessions: 0,
    checkpoints: 0,
    eventLogRows: 0,
    digestIssues: 0,
  };
  let policyChanged = false;
  for (const sessionId of candidates.value) {
    const result = await pruneSession(db, repositoryId, cutoff, sessionId, guard);
    if (!result.ok) {
      return { status: "failed", days, errorCode: result.error.code };
    }
    if (result.value !== null) {
      pruned.sessions += 1;
      pruned.checkpoints += result.value.checkpoints;
      continue;
    }
    // `null` means the transaction declined: either the policy no longer matches,
    // or a hook/MCP write made this session ineligible. Distinguish them, because
    // a policy change must stop the whole sweep — including the diagnostics prune
    // below — while an ineligible session only means skip this one.
    const current = await readRetentionSetting(db, repositoryId);
    if (!current.ok || current.value.setting.days !== days) {
      policyChanged = true;
      break;
    }
  }

  // The loop's guard is per-session, so the policy could still have changed after
  // the last one. Re-read before the two sweep-wide deletes rather than trusting a
  // flag set earlier: both would otherwise run with the superseded cutoff.
  if (!policyChanged) {
    const current = await readRetentionSetting(db, repositoryId);
    if (!current.ok || current.value.setting.days !== days) {
      return { status: "pruned", days, pruned };
    }
  }
  if (!policyChanged) {
    const eventLogRows = await pruneEventLog(db, repositoryId, cutoff);
    if (!eventLogRows.ok) {
      return { status: "failed", days, errorCode: eventLogRows.error.code };
    }
    pruned.eventLogRows = eventLogRows.value;
    const digestIssues = await pruneDigestIssues(db, repositoryId, cutoff);
    if (!digestIssues.ok) {
      return { status: "failed", days, errorCode: digestIssues.error.code };
    }
    pruned.digestIssues = digestIssues.value;
  }

  return { status: "pruned", days, pruned };
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
  const counts = await countLocalEventData(
    db,
    repositoryId,
    retentionCutoff(setting.value.setting, clock),
  );
  if (!counts.ok) {
    return counts;
  }
  return ok({ days: setting.value.setting.days, counts: counts.value });
}
