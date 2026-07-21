import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ok } from "@iroha/domain";
import { getSyncCursor, listOpenDirtyMarkers } from "@iroha/storage";
import { type SyncCanonicalResult, syncCanonicalToDatabase } from "../sync-canonical.js";
import { withDashboardRepository } from "./with-repository.js";

export interface SyncStatusData {
  canonical: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastErrorCode: string | null;
  } | null;
  github: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastErrorCode: string | null;
  } | null;
  dirtyMarkers: Array<{
    id: string;
    type: string;
    entityId: string | null;
    createdAt: string;
  }>;
}

export interface GetSyncStatusInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/** Sync cursors and open dirty markers (`GET /api/v1/sync/status`). */
export async function getSyncStatus(
  input: GetSyncStatusInput,
): Promise<Result<SyncStatusData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const cursor = await getSyncCursor(ctx.db, ctx.repo.repositoryId, "canonical");
      if (!cursor.ok) {
        return cursor;
      }
      const github = await getSyncCursor(ctx.db, ctx.repo.repositoryId, "github");
      if (!github.ok) {
        return github;
      }
      const dirty = await listOpenDirtyMarkers(ctx.db, ctx.repo.repositoryId);
      if (!dirty.ok) {
        return dirty;
      }
      return ok({
        canonical:
          cursor.value === null
            ? null
            : {
                lastSuccessAt: cursor.value.lastSuccessAt,
                lastAttemptAt: cursor.value.lastAttemptAt,
                lastErrorCode: cursor.value.lastErrorCode,
              },
        github:
          github.value === null
            ? null
            : {
                lastSuccessAt: github.value.lastSuccessAt,
                lastAttemptAt: github.value.lastAttemptAt,
                lastErrorCode: github.value.lastErrorCode,
              },
        dirtyMarkers: dirty.value.map((marker) => ({
          id: marker.id,
          type: marker.markerType,
          entityId: marker.entityId,
          createdAt: marker.createdAt,
        })),
      });
    },
  );
}

export interface RunDashboardSyncInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Reconciles the local DB with `.iroha/` canonical files (`POST /api/v1/sync`).
 * This is the non-rebuild canonical sync — it repairs the DB divergence a failed
 * approval records (FR-053) without needing migrations. Forge/Git sync remains
 * out of scope for v0.1's dashboard sync.
 */
export async function runDashboardSync(
  input: RunDashboardSyncInput,
): Promise<Result<SyncCanonicalResult, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    (ctx) =>
      syncCanonicalToDatabase(
        ctx.db,
        ctx.repo.repositoryId,
        ctx.repo.irohaCanonicalDir,
        ctx.clock,
        ctx.random,
      ),
  );
}
