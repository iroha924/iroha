import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepositoryConfig, type RepositoryConfig } from "@iroha/config";
import {
  type Clock,
  err,
  IrohaError,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import {
  type GitLocation,
  generateRepositoryId,
  resolveGitLocation,
  resolveGitPath,
} from "@iroha/git";
import {
  closeDatabase,
  type Database,
  getRepositoryById,
  getRepositoryByRootFingerprint,
  insertRepository,
  openDatabase,
  runMigrations,
} from "@iroha/storage";
import { stringify } from "yaml";
import { scanDocsIntoCandidates } from "./docs-scan.js";
import { assertSupportedSchemaVersion, readSchemaVersion } from "./schema-version.js";

const CANONICAL_SUBDIRECTORIES = [
  "decisions",
  "rules",
  "knowledge/concepts",
  "knowledge/insights",
  "knowledge/incidents",
  "knowledge/patterns",
  "knowledge/reviews",
  "sessions",
];

/** canonical-schema.md §3: `.iroha/.gitignore` contains exactly this. */
const IROHA_GITIGNORE_CONTENT = ".*.tmp\n";

/** Local-state subdirectories under `<git-path iroha>/` (database-schema.md §2). */
const LOCAL_STATE_SUBDIRECTORIES = ["locks", "dirty", "logs", "hook-outputs"];

/** Also used by `rebuild-database.ts` — a rebuilt DB's `repositories` row must agree with what `initRepository` would compute for the same clone. */
export function computeRootFingerprint(gitCommonDir: string): string {
  return `sha256:${createHash("sha256").update(gitCommonDir).digest("hex")}`;
}

function buildDefaultConfig(repositoryId: TypedId<"repo">): RepositoryConfig {
  return {
    schema_version: 1,
    repository_id: repositoryId,
    default_language: "en",
    canonical: {
      require_human_approval: true,
      session_auto_publish: false,
    },
    search: {
      embedding: {
        enabled: false,
        provider: "voyage",
        model: "voyage-4-large",
        dimension: 1024,
        api_key_env: "VOYAGE_API_KEY",
      },
    },
    forge: {
      provider: "github",
      enabled: false,
      api_token_env: "GITHUB_TOKEN",
      review_learning_threshold: 3,
    },
    privacy: {
      canonical_prompt_content: false,
      canonical_transcript_content: false,
    },
  };
}

/**
 * Creates `.iroha/`'s directory skeleton, `.gitignore`, `schema-version`,
 * and an empty `taxonomy/labels.yaml` (canonical-schema.md §3) — everything
 * except `config.yaml`, which needs a `repository_id` resolved against the
 * local DB first (see `resolveOrRegisterRepository`). Every file here has
 * content that is identical no matter which racing process's write lands
 * last, so unlike `config.yaml` this needs no atomic-write handling: two
 * concurrent `iroha init` calls both writing the same bytes is harmless.
 * A caller must only reach this once `readSchemaVersion` has already
 * confirmed no `.iroha/` exists yet.
 */
async function createCanonicalSkeleton(irohaCanonicalDir: string): Promise<void> {
  for (const subdirectory of CANONICAL_SUBDIRECTORIES) {
    await mkdir(join(irohaCanonicalDir, subdirectory), { recursive: true });
  }
  await writeFile(join(irohaCanonicalDir, ".gitignore"), IROHA_GITIGNORE_CONTENT, "utf8");
  await writeFile(join(irohaCanonicalDir, "schema-version"), "1\n", "utf8");

  await mkdir(join(irohaCanonicalDir, "taxonomy"), { recursive: true });
  await writeFile(
    join(irohaCanonicalDir, "taxonomy", "labels.yaml"),
    stringify({ schema_version: 1, labels: [] }),
    "utf8",
  );
}

/**
 * Temp-file-then-`rename` — matches `@iroha/git`'s `salt.ts` pattern for the
 * same reason: a torn read of a partially-written `config.yaml` by a racing
 * process must not be possible. The temp name includes `random.bytes(8)`,
 * not just `process.pid`-`Date.now()`: confirmed by reproduction that two
 * racing calls within the same process (this file's own concurrency test)
 * or two OS processes racing within the same millisecond can otherwise
 * compute the *same* temp path, so the loser's `rename` fails with `ENOENT`
 * (its source file was already moved away by the winner) instead of the
 * intended "both write the same final content, harmlessly" outcome.
 */
async function writeConfigAtomic(
  irohaCanonicalDir: string,
  repositoryId: TypedId<"repo">,
  random: RandomSource,
): Promise<void> {
  const configPath = join(irohaCanonicalDir, "config.yaml");
  const suffix = Buffer.from(random.bytes(8)).toString("hex");
  const tempPath = `${configPath}.tmp-${process.pid}-${suffix}`;
  await writeFile(tempPath, stringify(buildDefaultConfig(repositoryId)), "utf8");
  await rename(tempPath, configPath);
}

/**
 * Resolves this clone's `repository_id`, registering it in the local DB if
 * needed, without letting two processes racing a repository's very first
 * `iroha init` diverge permanently. `repositories.root_fingerprint`
 * (deterministic per clone, `UNIQUE`) is the tiebreaker: whichever process's
 * `insertRepository` call actually lands first becomes the source of truth,
 * and every other racer discovers that row (via the `UNIQUE` conflict, or
 * via `getRepositoryByRootFingerprint` before ever attempting its own
 * insert) and adopts its `id` — rather than each process generating and
 * durably writing a different random `repository_id` to `config.yaml`
 * independently, which would leave `config.yaml` and the winning DB row
 * permanently disagreeing (not self-correcting the way a plain retry fixes
 * ID-024(5)'s migration-insert race).
 */
async function resolveOrRegisterRepository(
  db: Database,
  irohaCanonicalDir: string,
  gitLocation: GitLocation,
  clock: Clock,
  random: RandomSource,
): Promise<Result<TypedId<"repo">, IrohaError>> {
  const now = clock.now().toISOString();
  const rootFingerprint = computeRootFingerprint(gitLocation.commonDir);

  let existingConfig: string | undefined;
  try {
    existingConfig = await readFile(join(irohaCanonicalDir, "config.yaml"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(new IrohaError("INTERNAL_ERROR", "Failed to read .iroha/config.yaml", { cause }));
    }
  }

  let repositoryId: TypedId<"repo">;
  if (existingConfig !== undefined) {
    const parsed = parseRepositoryConfig(existingConfig);
    if (!parsed.ok) {
      return parsed;
    }
    repositoryId = parsed.value.repository_id as TypedId<"repo">;
  } else {
    const byFingerprint = await getRepositoryByRootFingerprint(db, rootFingerprint);
    if (!byFingerprint.ok) {
      return byFingerprint;
    }
    repositoryId = byFingerprint.value?.id ?? generateRepositoryId(clock, random);
  }

  const existingRow = await getRepositoryById(db, repositoryId);
  if (!existingRow.ok) {
    return existingRow;
  }
  if (existingRow.value === null) {
    const inserted = await insertRepository(db, {
      id: repositoryId,
      rootFingerprint,
      createdAt: now,
      updatedAt: now,
    });
    if (!inserted.ok) {
      if (inserted.error.code !== "CONFLICT") {
        return inserted;
      }
      // Lost a race against a concurrent `insertRepository` for this same
      // clone. If it collided on `root_fingerprint`, that row is now this
      // clone's real identity — adopt it. If it collided on the primary
      // key instead (someone already inserted this exact `repositoryId`),
      // the desired end state already exists either way.
      const winner = await getRepositoryByRootFingerprint(db, rootFingerprint);
      if (!winner.ok) {
        return winner;
      }
      if (winner.value !== null) {
        repositoryId = winner.value.id;
      }
    }
  }

  if (existingConfig === undefined) {
    await writeConfigAtomic(irohaCanonicalDir, repositoryId, random);
  }

  return ok(repositoryId);
}

export interface InitRepositoryResult {
  repositoryId: TypedId<"repo">;
  gitRoot: string;
  irohaCanonicalDir: string;
  dbPath: string;
  freshInit: boolean;
  docsScanned: string[];
  candidatesCreated: number;
}

export interface InitRepositoryOptions {
  /** canonical-schema.md §14: `iroha init --scan` only. Plain `iroha init` never scans. */
  scan?: boolean;
}

/**
 * `iroha init` (implementation-plan.md WP-05, requirements.md Scenario A):
 * resolves Git identity, bootstraps `.iroha/` on a genuinely fresh
 * repository (or reuses the existing `repository_id` otherwise), opens and
 * migrates the local DB, ensures the `repositories` row exists, and — only
 * when `options.scan` is set (canonical-schema.md §14: `iroha init --scan`)
 * — scans `AGENTS.md`/`CLAUDE.md`/`.claude/rules/**\/*.md` into local
 * (non-canonical) `rule` candidates. Idempotent: a second run against the
 * same repository makes no further changes (Scenario A: "再実行しても既存
 * データを破壊しない").
 *
 * Canonical-file import is deliberately not done here — that is
 * `syncCanonicalToDatabase`'s job; the CLI layer composes the two so `iroha
 * init` still feels like one command to a user with an existing `.iroha/`.
 */
export async function initRepository(
  cwd: string,
  clock: Clock,
  random: RandomSource,
  migrationsDir: string,
  options: InitRepositoryOptions = {},
): Promise<Result<InitRepositoryResult, IrohaError>> {
  const locationResult = await resolveGitLocation(cwd);
  if (!locationResult.ok) {
    return locationResult;
  }
  const gitLocation = locationResult.value;

  const irohaStatePathResult = await resolveGitPath(cwd, "iroha");
  if (!irohaStatePathResult.ok) {
    return irohaStatePathResult;
  }
  const irohaStateDir = irohaStatePathResult.value;
  const irohaCanonicalDir = join(gitLocation.root, ".iroha");

  const schemaVersionResult = await readSchemaVersion(irohaCanonicalDir);
  if (!schemaVersionResult.ok) {
    return schemaVersionResult;
  }

  const existingSchemaVersion = schemaVersionResult.value;
  const freshInit = existingSchemaVersion === null;
  if (freshInit) {
    await createCanonicalSkeleton(irohaCanonicalDir);
  } else {
    const supported = assertSupportedSchemaVersion(existingSchemaVersion);
    if (!supported.ok) {
      return supported;
    }
  }

  const dbPath = join(irohaStateDir, "index.db");
  const openResult = await openDatabase(dbPath);
  if (!openResult.ok) {
    return openResult;
  }
  const db: Database = openResult.value;
  try {
    const migrated = await runMigrations(db, migrationsDir, dbPath, clock);
    if (!migrated.ok) {
      return migrated;
    }

    const repositoryIdResult = await resolveOrRegisterRepository(
      db,
      irohaCanonicalDir,
      gitLocation,
      clock,
      random,
    );
    if (!repositoryIdResult.ok) {
      return repositoryIdResult;
    }
    const repositoryId = repositoryIdResult.value;

    for (const subdirectory of LOCAL_STATE_SUBDIRECTORIES) {
      await mkdir(join(irohaStateDir, subdirectory), { recursive: true });
    }

    let docsScanned: string[] = [];
    let candidatesCreated = 0;
    if (options.scan) {
      const scanResult = await scanDocsIntoCandidates(
        db,
        gitLocation.root,
        repositoryId,
        clock,
        random,
      );
      if (!scanResult.ok) {
        return scanResult;
      }
      docsScanned = scanResult.value.docsScanned;
      candidatesCreated = scanResult.value.candidatesCreated;
    }

    return ok({
      repositoryId,
      gitRoot: gitLocation.root,
      irohaCanonicalDir,
      dbPath,
      freshInit,
      docsScanned,
      candidatesCreated,
    });
  } finally {
    await closeDatabase(db);
  }
}
