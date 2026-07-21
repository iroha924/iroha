import { CryptoRandomSource, type IrohaError, ok, type Result, SystemClock } from "@iroha/domain";
import { type SearchTextHit, searchText } from "@iroha/search";
import { closeDatabase, type Database, openDatabase, runMigrations } from "@iroha/storage";
import { type RunEmbeddingSyncResult, runEmbeddingSync } from "./embedding-sync.js";
import {
  type ForgeSyncOutcome,
  resolveForgeProvider,
  resolveGitHubRef,
  runForgeSync,
} from "./forge-sync.js";
import {
  type InitRepositoryOptions,
  type InitRepositoryResult,
  initRepository,
} from "./init-repository.js";
import { type RebuildDatabaseResult, rebuildDatabase } from "./rebuild-database.js";
import { type ResolvedRepository, resolveInitializedRepository } from "./resolve-repository.js";
import { type SyncCanonicalResult, syncCanonicalToDatabase } from "./sync-canonical.js";

/**
 * These `run*` functions are `@iroha/cli`'s entire surface onto `@iroha/core`
 * (compatibility.md §4: `@iroha/cli` "may depend on" `core, api` — not
 * `domain`/`search`/`storage` directly). Each one owns its own `Clock`/
 * `RandomSource`/DB-connection lifecycle internally, matching `doctor.ts`'s
 * `runDoctor` — the CLI layer only ever passes primitives (`cwd`, flags) in
 * and reads a `Result` back out.
 */

export interface RunInitResult {
  init: InitRepositoryResult;
  sync: SyncCanonicalResult;
}

/** `iroha init`: bootstrap/reuse `.iroha/` + the local DB, then immediately reflect its current canonical documents (so a clone of an existing repository doesn't look empty until a separate `iroha sync`). */
export async function runInit(
  cwd: string,
  migrationsDir: string,
  options: InitRepositoryOptions = {},
): Promise<Result<RunInitResult, IrohaError>> {
  const clock = new SystemClock();
  const initResult = await initRepository(
    cwd,
    clock,
    new CryptoRandomSource(),
    migrationsDir,
    options,
  );
  if (!initResult.ok) {
    return initResult;
  }

  const opened = await openDatabase(initResult.value.dbPath);
  if (!opened.ok) {
    return opened;
  }
  try {
    const syncResult = await syncCanonicalToDatabase(
      opened.value,
      initResult.value.repositoryId,
      initResult.value.irohaCanonicalDir,
      clock,
      new CryptoRandomSource(),
    );
    if (!syncResult.ok) {
      return syncResult;
    }
    return ok({ init: initResult.value, sync: syncResult.value });
  } finally {
    await closeDatabase(opened.value);
  }
}

export interface RunSyncOptions {
  rebuild?: boolean;
}

export type RunSyncResult =
  | { rebuilt: true; rebuild: RebuildDatabaseResult }
  | {
      rebuilt: false;
      sync: SyncCanonicalResult;
      embedding: RunEmbeddingSyncResult;
      forge: ForgeSyncOutcome;
    };

/** `iroha sync` / `iroha sync --rebuild`. */
export async function runSync(
  cwd: string,
  migrationsDir: string,
  options: RunSyncOptions = {},
): Promise<Result<RunSyncResult, IrohaError>> {
  const clock = new SystemClock();

  if (options.rebuild) {
    const rebuildResult = await rebuildDatabase(
      cwd,
      clock,
      new CryptoRandomSource(),
      migrationsDir,
    );
    if (!rebuildResult.ok) {
      return rebuildResult;
    }
    return ok({ rebuilt: true, rebuild: rebuildResult.value });
  }

  const resolvedResult = await resolveInitializedRepository(cwd);
  if (!resolvedResult.ok) {
    return resolvedResult;
  }
  const opened = await openDatabase(resolvedResult.value.dbPath);
  if (!opened.ok) {
    return opened;
  }
  try {
    // Apply any pending migrations before syncing (database-schema.md §3: only
    // init/sync/doctor --repair migrate — hooks never do). Without this, a DB
    // from an older build stays behind after `iroha sync` and a later hook that
    // needs a not-yet-created table would silently fail-open.
    const migrated = await runMigrations(
      opened.value,
      migrationsDir,
      resolvedResult.value.dbPath,
      clock,
    );
    if (!migrated.ok) {
      return migrated;
    }
    const syncResult = await syncCanonicalToDatabase(
      opened.value,
      resolvedResult.value.repositoryId,
      resolvedResult.value.irohaCanonicalDir,
      clock,
      new CryptoRandomSource(),
    );
    if (!syncResult.ok) {
      return syncResult;
    }
    // Drain the embedding queue this sync just (re)filled. A provider outage
    // does not fail the sync — `runEmbeddingSync` degrades per job and only
    // returns `err` on a real DB error (CLAUDE.md: embedding failure degrades
    // to lexical search).
    const embeddingResult = await runEmbeddingSync(
      opened.value,
      resolvedResult.value.repositoryId,
      resolvedResult.value.config.search.embedding,
      clock,
      new CryptoRandomSource(),
    );
    if (!embeddingResult.ok) {
      return embeddingResult;
    }
    // Forge sync is fully non-fatal (design.md §12: "Forge failure must not fail
    // canonical/Git sync"). A disabled provider, a non-GitHub remote, a provider
    // outage, or even a DB write error yields an outcome here — never an `err`
    // that would fail the sync the canonical/embedding work already completed.
    const forge = await syncForge(opened.value, cwd, resolvedResult.value, clock);
    return ok({
      rebuilt: false,
      sync: syncResult.value,
      embedding: embeddingResult.value,
      forge,
    });
  } finally {
    await closeDatabase(opened.value);
  }
}

/** Resolve the GitHub provider + remote ref and run the non-fatal forge sync. */
async function syncForge(
  db: Database,
  cwd: string,
  resolved: ResolvedRepository,
  clock: SystemClock,
): Promise<ForgeSyncOutcome> {
  const provider = resolveForgeProvider(resolved.config.forge, process.env);
  if (provider === null) {
    const forge = resolved.config.forge;
    if (!forge.enabled || forge.provider !== "github") {
      return { status: "disabled" };
    }
    // Enabled but unresolvable → the token env var is unset; distinguish from
    // "disabled" so `iroha sync` can tell the user why forge did not run.
    return { status: "skipped", reason: `forge is enabled but ${forge.api_token_env} is not set` };
  }
  const refResult = await resolveGitHubRef(cwd);
  if (!refResult.ok) {
    return { status: "error", errorCode: refResult.error.code };
  }
  if (refResult.value === null) {
    return { status: "skipped", reason: "remote is not a github.com repository" };
  }
  return runForgeSync(
    db,
    resolved.repositoryId,
    refResult.value,
    provider,
    clock,
    new CryptoRandomSource(),
  );
}

export interface RunSearchOptions {
  limit?: number;
}

/** `iroha search <query>`: FTS-only, offline (database-schema.md §8-9's unicode/trigram subset). */
export async function runSearch(
  cwd: string,
  query: string,
  options: RunSearchOptions = {},
): Promise<Result<SearchTextHit[], IrohaError>> {
  const resolvedResult = await resolveInitializedRepository(cwd);
  if (!resolvedResult.ok) {
    return resolvedResult;
  }
  const opened = await openDatabase(resolvedResult.value.dbPath);
  if (!opened.ok) {
    return opened;
  }
  try {
    return await searchText(opened.value, query, options);
  } finally {
    await closeDatabase(opened.value);
  }
}
