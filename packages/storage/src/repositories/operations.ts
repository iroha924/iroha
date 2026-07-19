import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableNumber, nullableString } from "../row-helpers.js";

// --- sync_cursors ---------------------------------------------------

export interface SyncCursorRow {
  repositoryId: TypedId<"repo">;
  provider: string;
  cursor: string | null;
  stateJson: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
}

export interface UpsertSyncCursorInput {
  repositoryId: TypedId<"repo">;
  provider: string;
  cursor?: string;
  stateJson?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
}

function rowToSyncCursor(row: Record<string, unknown>): SyncCursorRow {
  return {
    repositoryId: row.repository_id as TypedId<"repo">,
    provider: String(row.provider),
    cursor: nullableString(row.cursor),
    stateJson: String(row.state_json),
    lastSuccessAt: nullableString(row.last_success_at),
    lastAttemptAt: nullableString(row.last_attempt_at),
    lastErrorCode: nullableString(row.last_error_code),
  };
}

/**
 * Keyed on `(repository_id, provider)`, its primary key.
 *
 * `cursor`/`stateJson`/`lastSuccessAt` track the last *successful* sync
 * position; `lastAttemptAt`/`lastErrorCode` track the most recent attempt,
 * success or failure. A caller recording a failed attempt after a prior
 * success typically omits the success-path fields — confirmed by
 * reproduction that unconditionally overwriting them with `excluded.*`
 * turns those omissions into `NULL`/`{}`, erasing the last known-good
 * cursor. Omitted success-path fields fall back to the existing row's
 * value instead; `lastAttemptAt`/`lastErrorCode` always take the new value,
 * since they must reflect the latest attempt regardless of outcome.
 */
export async function upsertSyncCursor(
  db: Executor,
  input: UpsertSyncCursorInput,
): Promise<Result<void, IrohaError>> {
  const cursor = input.cursor ?? null;
  const stateJson = input.stateJson ?? null;
  const lastSuccessAt = input.lastSuccessAt ?? null;
  const lastAttemptAt = input.lastAttemptAt ?? null;
  const lastErrorCode = input.lastErrorCode ?? null;
  try {
    await db.execute({
      sql: `INSERT INTO sync_cursors
        (repository_id, provider, cursor, state_json, last_success_at, last_attempt_at, last_error_code)
        VALUES (?, ?, ?, COALESCE(?, '{}'), ?, ?, ?)
        ON CONFLICT (repository_id, provider) DO UPDATE SET
          cursor = COALESCE(?, sync_cursors.cursor),
          state_json = COALESCE(?, sync_cursors.state_json),
          last_success_at = COALESCE(?, sync_cursors.last_success_at),
          last_attempt_at = ?,
          last_error_code = ?`,
      args: [
        input.repositoryId,
        input.provider,
        cursor,
        stateJson,
        lastSuccessAt,
        lastAttemptAt,
        lastErrorCode,
        cursor,
        stateJson,
        lastSuccessAt,
        lastAttemptAt,
        lastErrorCode,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert sync cursor"));
  }
}

export async function getSyncCursor(
  db: Executor,
  repositoryId: TypedId<"repo">,
  provider: string,
): Promise<Result<SyncCursorRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM sync_cursors WHERE repository_id = ? AND provider = ?",
      args: [repositoryId, provider],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSyncCursor(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read sync cursor"));
  }
}

// --- dirty_markers ---------------------------------------------------

export const DIRTY_MARKER_TYPES = [
  "canonical_db_divergence",
  "interrupted_run",
  "embedding_retry",
  "sync_required",
] as const;
export type DirtyMarkerType = (typeof DIRTY_MARKER_TYPES)[number];

export interface DirtyMarkerRow {
  id: TypedId<"dirty">;
  repositoryId: TypedId<"repo">;
  markerType: DirtyMarkerType;
  entityId: string | null;
  detailsJson: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface InsertDirtyMarkerInput {
  id: TypedId<"dirty">;
  repositoryId: TypedId<"repo">;
  markerType: DirtyMarkerType;
  entityId?: string;
  detailsJson: string;
  createdAt: string;
}

function rowToDirtyMarker(row: Record<string, unknown>): DirtyMarkerRow {
  return {
    id: row.id as TypedId<"dirty">,
    repositoryId: row.repository_id as TypedId<"repo">,
    markerType: row.marker_type as DirtyMarkerType,
    entityId: nullableString(row.entity_id),
    detailsJson: String(row.details_json),
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

/** A marker always starts unresolved (`resolved_at IS NULL`). */
export async function insertDirtyMarker(
  db: Executor,
  input: InsertDirtyMarkerInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO dirty_markers (id, repository_id, marker_type, entity_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.repositoryId,
        input.markerType,
        input.entityId ?? null,
        input.detailsJson,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert dirty marker"));
  }
}

/** Matches the `idx_dirty_markers_open` partial index. */
export async function listOpenDirtyMarkers(
  db: Executor,
  repositoryId: TypedId<"repo">,
  markerType?: DirtyMarkerType,
): Promise<Result<DirtyMarkerRow[], IrohaError>> {
  try {
    const result = await db.execute(
      markerType === undefined
        ? {
            sql: "SELECT * FROM dirty_markers WHERE repository_id = ? AND resolved_at IS NULL ORDER BY created_at",
            args: [repositoryId],
          }
        : {
            sql: "SELECT * FROM dirty_markers WHERE repository_id = ? AND marker_type = ? AND resolved_at IS NULL ORDER BY created_at",
            args: [repositoryId, markerType],
          },
    );
    return ok(result.rows.map(rowToDirtyMarker));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list open dirty markers"));
  }
}

export async function resolveDirtyMarker(
  db: Executor,
  id: TypedId<"dirty">,
  resolvedAt: string,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE dirty_markers SET resolved_at = ? WHERE id = ?",
      args: [resolvedAt, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to resolve dirty marker"));
  }
}

// --- local_settings ---------------------------------------------------

export interface LocalSettingRow {
  repositoryId: TypedId<"repo">;
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface UpsertLocalSettingInput {
  repositoryId: TypedId<"repo">;
  key: string;
  valueJson: string;
  updatedAt: string;
}

function rowToLocalSetting(row: Record<string, unknown>): LocalSettingRow {
  return {
    repositoryId: row.repository_id as TypedId<"repo">,
    key: String(row.key),
    valueJson: String(row.value_json),
    updatedAt: String(row.updated_at),
  };
}

/** Keyed on `(repository_id, key)`, its primary key. */
export async function upsertLocalSetting(
  db: Executor,
  input: UpsertLocalSettingInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO local_settings (repository_id, key, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (repository_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`,
      args: [input.repositoryId, input.key, input.valueJson, input.updatedAt],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert local setting"));
  }
}

export async function getLocalSetting(
  db: Executor,
  repositoryId: TypedId<"repo">,
  key: string,
): Promise<Result<LocalSettingRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM local_settings WHERE repository_id = ? AND key = ?",
      args: [repositoryId, key],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToLocalSetting(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read local setting"));
  }
}

// --- event_log ---------------------------------------------------

export type EventLogOutcome = "success" | "warning" | "failure" | "denied";

export interface EventLogRow {
  id: TypedId<"log">;
  repositoryId: TypedId<"repo"> | null;
  sessionId: TypedId<"ses"> | null;
  turnId: TypedId<"trn"> | null;
  eventType: string;
  adapter: string | null;
  durationMs: number | null;
  outcome: EventLogOutcome;
  errorCode: string | null;
  occurredAt: string;
}

export interface InsertEventLogInput {
  id: TypedId<"log">;
  repositoryId?: TypedId<"repo">;
  sessionId?: TypedId<"ses">;
  turnId?: TypedId<"trn">;
  eventType: string;
  adapter?: string;
  durationMs?: number;
  outcome: EventLogOutcome;
  errorCode?: string;
  occurredAt: string;
}

function rowToEventLog(row: Record<string, unknown>): EventLogRow {
  return {
    id: row.id as TypedId<"log">,
    repositoryId: row.repository_id === null ? null : (row.repository_id as TypedId<"repo">),
    sessionId: row.session_id === null ? null : (row.session_id as TypedId<"ses">),
    turnId: row.turn_id === null ? null : (row.turn_id as TypedId<"trn">),
    eventType: String(row.event_type),
    adapter: nullableString(row.adapter),
    durationMs: nullableNumber(row.duration_ms),
    outcome: row.outcome as EventLogOutcome,
    errorCode: nullableString(row.error_code),
    occurredAt: String(row.occurred_at),
  };
}

/** Append-only — no update/delete functions by design. */
export async function insertEventLog(
  db: Executor,
  input: InsertEventLogInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO event_log
        (id, repository_id, session_id, turn_id, event_type, adapter, duration_ms, outcome, error_code, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.repositoryId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.eventType,
        input.adapter ?? null,
        input.durationMs ?? null,
        input.outcome,
        input.errorCode ?? null,
        input.occurredAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert event log entry"));
  }
}

/** Matches the `idx_event_log_repository_time` index. */
export async function listEventLogByRepository(
  db: Executor,
  repositoryId: TypedId<"repo">,
  limit?: number,
): Promise<Result<EventLogRow[], IrohaError>> {
  try {
    const result = await db.execute(
      limit === undefined
        ? {
            sql: "SELECT * FROM event_log WHERE repository_id = ? ORDER BY occurred_at DESC",
            args: [repositoryId],
          }
        : {
            sql: "SELECT * FROM event_log WHERE repository_id = ? ORDER BY occurred_at DESC LIMIT ?",
            args: [repositoryId, limit],
          },
    );
    return ok(result.rows.map(rowToEventLog));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list event log entries"));
  }
}

// --- idempotency_keys ---------------------------------------------------

export interface IdempotencyRecordRow {
  repositoryId: TypedId<"repo">;
  operation: string;
  idempotencyKey: string;
  resultEntityId: string | null;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export interface InsertIdempotencyRecordInput {
  repositoryId: TypedId<"repo">;
  operation: string;
  idempotencyKey: string;
  resultEntityId?: string;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

function rowToIdempotencyRecord(row: Record<string, unknown>): IdempotencyRecordRow {
  return {
    repositoryId: row.repository_id as TypedId<"repo">,
    operation: String(row.operation),
    idempotencyKey: String(row.idempotency_key),
    resultEntityId: nullableString(row.result_entity_id),
    responseJson: String(row.response_json),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

/**
 * Design.md §9: "MCP/HTTP mutationは`idempotency_keys`で再試行しても重複を
 * 作らない". A plain `INSERT` (no `ON CONFLICT`) is intentional — a
 * `CONFLICT` on the `(repository_id, operation, idempotency_key)` primary
 * key means a concurrent request already recorded a result, and the MCP
 * layer should fetch that result via `getIdempotencyRecord` rather than
 * silently overwrite it.
 */
export async function insertIdempotencyRecord(
  db: Executor,
  input: InsertIdempotencyRecordInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO idempotency_keys
        (repository_id, operation, idempotency_key, result_entity_id, response_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.repositoryId,
        input.operation,
        input.idempotencyKey,
        input.resultEntityId ?? null,
        input.responseJson,
        input.createdAt,
        input.expiresAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to record idempotency result"));
  }
}

export async function getIdempotencyRecord(
  db: Executor,
  repositoryId: TypedId<"repo">,
  operation: string,
  idempotencyKey: string,
): Promise<Result<IdempotencyRecordRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM idempotency_keys WHERE repository_id = ? AND operation = ? AND idempotency_key = ?",
      args: [repositoryId, operation, idempotencyKey],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToIdempotencyRecord(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read idempotency record"));
  }
}

/** Matches the `idx_idempotency_keys_expiry` index — periodic maintenance (doctor/sync) cleanup. */
export async function deleteExpiredIdempotencyRecords(
  db: Executor,
  now: string,
): Promise<Result<number, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "DELETE FROM idempotency_keys WHERE expires_at <= ?",
      args: [now],
    });
    return ok(result.rowsAffected);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to delete expired idempotency records"));
  }
}
