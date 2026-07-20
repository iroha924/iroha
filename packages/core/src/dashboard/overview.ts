import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ok } from "@iroha/domain";
import {
  getOverviewCounts,
  getSyncCursor,
  listOpenDirtyMarkers,
  listSessions,
  probeCapabilities,
  type StorageCapabilities,
} from "@iroha/storage";
import { readSchemaVersion } from "../schema-version.js";
import { withDashboardRepository } from "./with-repository.js";

export interface OverviewRecentSession {
  id: string;
  platform: string;
  lastSeenAt: string;
  latestRunStatus: string | null;
}

export interface OverviewData {
  pendingCandidates: number;
  oldestPendingCreatedAt: string | null;
  approvedKnowledge: number;
  sessions: number;
  openDirtyMarkers: number;
  recentSessions: OverviewRecentSession[];
  lastCanonicalSyncAt: string | null;
}

export interface GetOverviewInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Overview page data (`GET /api/v1/overview`): pending-candidate pressure,
 * recent Sessions, unresolved dirty markers, and last sync. Deliberately has no
 * per-person metric — NFR-008 / FR-108 forbid individual ranking.
 */
export async function getOverview(
  input: GetOverviewInput,
): Promise<Result<OverviewData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const counts = await getOverviewCounts(ctx.db, ctx.repo.repositoryId);
      if (!counts.ok) {
        return counts;
      }
      const dirty = await listOpenDirtyMarkers(ctx.db, ctx.repo.repositoryId);
      if (!dirty.ok) {
        return dirty;
      }
      const recent = await listSessions(ctx.db, ctx.repo.repositoryId, { limit: 5 });
      if (!recent.ok) {
        return recent;
      }
      const cursor = await getSyncCursor(ctx.db, ctx.repo.repositoryId, "canonical");
      if (!cursor.ok) {
        return cursor;
      }
      return ok({
        pendingCandidates: counts.value.pendingCandidates,
        oldestPendingCreatedAt: counts.value.oldestPendingCreatedAt,
        approvedKnowledge: counts.value.approvedKnowledge,
        sessions: counts.value.sessions,
        openDirtyMarkers: dirty.value.length,
        recentSessions: recent.value.map((row) => ({
          id: row.id,
          platform: row.platform,
          lastSeenAt: row.lastSeenAt,
          latestRunStatus: row.latestRunStatus,
        })),
        lastCanonicalSyncAt: cursor.value?.lastSuccessAt ?? null,
      });
    },
  );
}

export interface BootstrapData {
  repository: {
    id: string;
    defaultLanguage: "ja" | "en";
    requireHumanApproval: boolean;
  };
  schema: {
    version: string | null;
    supported: boolean;
  };
  capabilities: StorageCapabilities;
  embedding: {
    enabled: boolean;
    /** Whether the configured API-key env var is set — never the value itself. */
    keyPresent: boolean;
  };
}

export interface GetBootstrapInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Startup summary the SPA loads first (`GET /api/v1/bootstrap`): repository
 * identity, UI language, schema status, and capability/embedding flags. The
 * embedding secret is reported only as a presence boolean (NFR-005: secrets are
 * never exposed).
 */
export async function getBootstrap(
  input: GetBootstrapInput,
): Promise<Result<BootstrapData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const schemaVersion = await readSchemaVersion(ctx.repo.irohaCanonicalDir);
      const capabilities = await probeCapabilities(ctx.db, ctx.random);
      const embedding = ctx.repo.config.search.embedding;
      return ok({
        repository: {
          id: ctx.repo.repositoryId,
          defaultLanguage: ctx.repo.config.default_language,
          requireHumanApproval: ctx.repo.config.canonical.require_human_approval,
        },
        schema: {
          version: schemaVersion.ok ? schemaVersion.value : null,
          supported: schemaVersion.ok && schemaVersion.value !== null,
        },
        capabilities,
        embedding: {
          enabled: embedding.enabled,
          keyPresent: process.env[embedding.api_key_env] !== undefined,
        },
      });
    },
  );
}
