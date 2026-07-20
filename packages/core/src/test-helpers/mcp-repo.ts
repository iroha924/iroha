import { fileURLToPath } from "node:url";
import type { RandomSource, TypedId } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import { runInit } from "../commands.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { createTempGitRepo } from "./tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

export interface McpTestRepo {
  repoDir: string;
  repositoryId: TypedId<"repo">;
  dbPath: string;
  irohaStateDir: string;
  salt: Uint8Array;
}

/**
 * Creates a temp Git repo, runs `iroha init` (creating and migrating the local
 * DB), and returns the resolved identity plus salt — the shared fixture for the
 * MCP read-tool use-case tests. Callers open their own DB connection to seed
 * rows, then call the use-case (which opens its own connection against the same
 * file). Clean up with `removeTempDir(repoDir)`.
 */
export async function setupMcpRepo(random: RandomSource): Promise<McpTestRepo> {
  const repoDir = await createTempGitRepo();
  const init = await runInit(repoDir, MIGRATIONS_DIR);
  if (!init.ok) {
    throw new Error(`init failed: ${init.error.code}: ${init.error.message}`);
  }
  const resolved = await resolveInitializedRepository(repoDir);
  if (!resolved.ok) {
    throw new Error(`resolve failed: ${resolved.error.code}: ${resolved.error.message}`);
  }
  const salt = await ensureRepositorySalt(resolved.value.irohaStateDir, random);
  if (!salt.ok) {
    throw new Error(`salt failed: ${salt.error.code}: ${salt.error.message}`);
  }
  return {
    repoDir,
    repositoryId: resolved.value.repositoryId,
    dbPath: resolved.value.dbPath,
    irohaStateDir: resolved.value.irohaStateDir,
    salt: salt.value,
  };
}
