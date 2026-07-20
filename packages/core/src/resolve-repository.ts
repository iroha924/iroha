import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepositoryConfig, type RepositoryConfig } from "@iroha/config";
import { err, IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import { type GitLocation, resolveGitLocation, resolveGitPath } from "@iroha/git";
import { assertSupportedSchemaVersion, readSchemaVersion } from "./schema-version.js";

export interface ResolvedRepository {
  gitLocation: GitLocation;
  irohaCanonicalDir: string;
  irohaStateDir: string;
  dbPath: string;
  repositoryId: TypedId<"repo">;
  /** The parsed `.iroha/config.yaml` — callers needing embedding/forge settings avoid re-reading it. */
  config: RepositoryConfig;
}

/**
 * Resolves an already-initialized repository's identity from `.iroha/
 * config.yaml` (shared by `rebuildDatabase` and the CLI's `sync` command —
 * `initRepository` has its own variant of this because it must also handle
 * the "not yet initialized" case by bootstrapping rather than failing).
 */
export async function resolveInitializedRepository(
  cwd: string,
): Promise<Result<ResolvedRepository, IrohaError>> {
  const locationResult = await resolveGitLocation(cwd);
  if (!locationResult.ok) {
    return locationResult;
  }
  const gitLocation = locationResult.value;

  const irohaPathResult = await resolveGitPath(cwd, "iroha");
  if (!irohaPathResult.ok) {
    return irohaPathResult;
  }
  const irohaStateDir = irohaPathResult.value;
  const irohaCanonicalDir = join(gitLocation.root, ".iroha");

  const schemaVersionResult = await readSchemaVersion(irohaCanonicalDir);
  if (!schemaVersionResult.ok) {
    return schemaVersionResult;
  }
  if (schemaVersionResult.value === null) {
    return err(
      new IrohaError("NOT_INITIALIZED", ".iroha/ does not exist yet (run `iroha init` first)"),
    );
  }
  const supported = assertSupportedSchemaVersion(schemaVersionResult.value);
  if (!supported.ok) {
    return supported;
  }

  let configContent: string;
  try {
    configContent = await readFile(join(irohaCanonicalDir, "config.yaml"), "utf8");
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to read .iroha/config.yaml", { cause }));
  }
  const configResult = parseRepositoryConfig(configContent);
  if (!configResult.ok) {
    return configResult;
  }

  return ok({
    gitLocation,
    irohaCanonicalDir,
    irohaStateDir,
    dbPath: join(irohaStateDir, "index.db"),
    repositoryId: configResult.value.repository_id as TypedId<"repo">,
    config: configResult.value,
  });
}
