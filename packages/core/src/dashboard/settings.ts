import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type RepositoryConfig, serializeRepositoryConfig } from "@iroha/config";
import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import { getLocalSetting, upsertLocalSetting } from "@iroha/storage";
import { type CredentialProvider, hasApiKey, writeApiKey } from "../credentials.js";
import {
  RETENTION_SETTING_KEY,
  readRetentionSetting,
  retentionSettingSchema,
} from "../retention.js";
import { withDashboardRepository } from "./with-repository.js";

export interface SettingsData {
  shared: RepositoryConfig;
  local: {
    /** Presence only — no endpoint returns a stored key's value. */
    embeddingKeyPresent: boolean;
    forgeTokenPresent: boolean;
    /**
     * The stored entry exists but could not be read. Distinct from "no key":
     * rendering an unreadable entry as absent tells the user to re-enter a key
     * that is already there, and hides the one thing they need to act on.
     *
     * Per provider, because each entry is validated on its own — one malformed
     * entry must not make the other provider's working key read as broken.
     */
    embeddingKeyUnreadable: boolean;
    forgeTokenUnreadable: boolean;
    /** Local event-data retention: the window in days, or `null` when off. */
    retentionDays: number | null;
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
    async (ctx) => {
      // An unreadable window must not fail the whole Settings read. This page is
      // the only place a bad value can be overwritten, so failing here would
      // render the error state and leave no way to repair it — while `iroha
      // doctor` keeps reporting the invalid setting. Reading it as "off" is safe:
      // `applyRetention` still refuses to delete anything it cannot parse.
      const retention = await readRetentionSetting(ctx.db, ctx.repo.repositoryId);
      const embeddingKey = await hasApiKey("voyage");
      const forgeToken = await hasApiKey("github");
      return ok({
        shared: ctx.repo.config,
        local: {
          embeddingKeyPresent: embeddingKey.ok && embeddingKey.value,
          forgeTokenPresent: forgeToken.ok && forgeToken.value,
          embeddingKeyUnreadable: !embeddingKey.ok,
          forgeTokenUnreadable: !forgeToken.ok,
          retentionDays: retention.ok ? retention.value.setting.days : null,
        },
      });
    },
  );
}

export interface SetProviderCredentialInput {
  provider: CredentialProvider;
  apiKey: string;
}

/**
 * Stores a provider API key from the dashboard (`PUT /api/v1/settings/credentials`).
 *
 * Deliberately repository-independent: the key lives in `~/.config/iroha/credentials.json`
 * and is shared by every repository on the machine, so resolving one here would
 * only add a way to fail. The response reports presence, never the value — the
 * key travels in one direction and there is no endpoint that reads it back.
 */
export async function setProviderCredential(
  input: SetProviderCredentialInput,
): Promise<Result<{ provider: CredentialProvider; present: boolean }, IrohaError>> {
  const written = await writeApiKey(input.provider, input.apiKey);
  return written.ok ? ok({ provider: input.provider, present: true }) : written;
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
 * contracts/canonical.md §9), so a mismatch is rejected. The file is written to a
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
      // The API accepts any `(key, value)` pair, so a known key must be
      // validated here or a malformed window would be stored and only rejected
      // later, when it is read to decide what to delete.
      if (input.key === RETENTION_SETTING_KEY) {
        const parsed = retentionSettingSchema.safeParse(input.value);
        if (!parsed.success) {
          return err(
            new IrohaErrorClass(
              "INVALID_INPUT",
              `${RETENTION_SETTING_KEY} must be {"days": <1-3650>} or {"days": null}`,
            ),
          );
        }
      }
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
