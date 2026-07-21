import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type RepositoryConfig, serializeRepositoryConfig } from "@iroha/config";
import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import { getLocalSetting, upsertLocalSetting } from "@iroha/storage";
import { withDashboardRepository } from "./with-repository.js";

export interface SettingsData {
  shared: RepositoryConfig;
  local: {
    /** Presence only — the embedding API key value is never returned (NFR-005). */
    embeddingKeyPresent: boolean;
  };
}

export interface GetSettingsInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/** Shared config plus redacted local status (`GET /api/v1/settings`). */
export async function getSettings(
  input: GetSettingsInput,
): Promise<Result<SettingsData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) =>
      ok({
        shared: ctx.repo.config,
        local: {
          embeddingKeyPresent:
            process.env[ctx.repo.config.search.embedding.api_key_env] !== undefined,
        },
      }),
  );
}

export interface UpdateSharedConfigInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  /** Full replacement config, already validated against `repositoryConfigSchema` at the API boundary. */
  config: RepositoryConfig;
}

/**
 * Safely rewrites `.iroha/config.yaml` (`PATCH /api/v1/settings/shared`). The
 * `repository_id` is immutable (it is generated once and committed,
 * canonical-schema.md §9), so a mismatch is rejected. The file is written to a
 * sibling temp file and atomically renamed, so a crash never leaves a partial
 * shared config in the Git-tracked tree.
 */
export async function updateSharedConfig(
  input: UpdateSharedConfigInput,
): Promise<Result<RepositoryConfig, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      if (input.config.repository_id !== ctx.repo.repositoryId) {
        return err(new IrohaErrorClass("INVALID_INPUT", "repository_id cannot be changed"));
      }
      const content = serializeRepositoryConfig(input.config);
      const targetPath = join(ctx.repo.irohaCanonicalDir, "config.yaml");
      const tempSuffix = Buffer.from(ctx.random.bytes(8)).toString("hex");
      const tempPath = join(ctx.repo.irohaCanonicalDir, `.config.${tempSuffix}.tmp`);
      try {
        const handle = await open(tempPath, "w");
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, targetPath);
      } catch (cause) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return err(
          new IrohaErrorClass("INTERNAL_ERROR", "Failed to write shared config", { cause }),
        );
      }
      return ok(input.config);
    },
  );
}

export interface UpdateLocalSettingsInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  key: string;
  value: unknown;
}

/** Updates one Git-internal local setting (`PATCH /api/v1/settings/local`); never written to canonical. */
export async function updateLocalSettings(
  input: UpdateLocalSettingsInput,
): Promise<Result<{ key: string }, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const updated = await upsertLocalSetting(ctx.db, {
        repositoryId: ctx.repo.repositoryId,
        key: input.key,
        valueJson: JSON.stringify(input.value),
        updatedAt: ctx.clock.now().toISOString(),
      });
      if (!updated.ok) {
        return updated;
      }
      // Read back so a caller sees the persisted setting exists.
      const readback = await getLocalSetting(ctx.db, ctx.repo.repositoryId, input.key);
      if (!readback.ok) {
        return readback;
      }
      return ok({ key: input.key });
    },
  );
}
