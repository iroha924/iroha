import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepositoryConfig, type RepositoryConfig } from "@iroha/config";
import {
  type Clock,
  err,
  IrohaError,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import { generateRepositoryId, resolveGitLocation, resolveGitPath } from "@iroha/git";
import {
  closeDatabase,
  type Database,
  getLocalSetting,
  getRepositoryById,
  insertCandidate,
  insertRepository,
  openDatabase,
  runMigrations,
  upsertLocalSetting,
} from "@iroha/storage";
import { stringify } from "yaml";
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

/**
 * `AGENTS.md`/`CLAUDE.md` scanned at the repository root become "rule" type
 * candidates (WP-05 deliverable: "docs scan into local Candidates") — these
 * are project-instruction documents, closest in kind to the canonical
 * "rule" type among the 8 candidate types.
 */
const DOC_SCAN_FILENAMES = ["AGENTS.md", "CLAUDE.md"];

/** Also used by `rebuild-database.ts` — a rebuilt DB's `repositories` row must agree with what `initRepository` would compute for the same clone. */
export function computeRootFingerprint(gitCommonDir: string): string {
  return `sha256:${createHash("sha256").update(gitCommonDir).digest("hex")}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw cause;
  }
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
        model: "voyage-4",
        dimension: 1024,
        api_key_env: "VOYAGE_API_KEY",
      },
    },
    forge: {
      provider: "github",
      enabled: false,
    },
    privacy: {
      canonical_prompt_content: false,
      canonical_transcript_content: false,
    },
  };
}

/**
 * Bootstraps `.iroha/` (canonical-schema.md §3) the first time a repository
 * is initialized: directory skeleton, `.gitignore`, `schema-version`,
 * `config.yaml` (with a freshly generated, then-committed `repository_id` —
 * §9: "generated once and committed"), and an empty `taxonomy/labels.yaml`.
 * A caller must only reach this once `readSchemaVersion` has already
 * confirmed no `.iroha/` exists yet.
 */
async function bootstrapCanonicalDirectory(
  irohaCanonicalDir: string,
  clock: Clock,
  random: RandomSource,
): Promise<TypedId<"repo">> {
  for (const subdirectory of CANONICAL_SUBDIRECTORIES) {
    await mkdir(join(irohaCanonicalDir, subdirectory), { recursive: true });
  }
  await writeFile(join(irohaCanonicalDir, ".gitignore"), IROHA_GITIGNORE_CONTENT, "utf8");
  await writeFile(join(irohaCanonicalDir, "schema-version"), "1\n", "utf8");

  const repositoryId = generateRepositoryId(clock, random);
  const config = buildDefaultConfig(repositoryId);
  await writeFile(join(irohaCanonicalDir, "config.yaml"), stringify(config), "utf8");

  await mkdir(join(irohaCanonicalDir, "taxonomy"), { recursive: true });
  await writeFile(
    join(irohaCanonicalDir, "taxonomy", "labels.yaml"),
    stringify({ schema_version: 1, labels: [] }),
    "utf8",
  );

  return repositoryId;
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

/**
 * `iroha init` (implementation-plan.md WP-05, requirements.md Scenario A):
 * resolves Git identity, bootstraps `.iroha/` on a genuinely fresh
 * repository (or reuses the existing `repository_id` otherwise), opens and
 * migrates the local DB, ensures the `repositories` row exists, and scans
 * `AGENTS.md`/`CLAUDE.md` into local (non-canonical) `rule` candidates.
 * Idempotent: a second run against the same repository makes no further
 * changes (Scenario A: "再実行しても既存データを破壊しない").
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
  let repositoryId: TypedId<"repo">;
  if (freshInit) {
    repositoryId = await bootstrapCanonicalDirectory(irohaCanonicalDir, clock, random);
  } else {
    const supported = assertSupportedSchemaVersion(existingSchemaVersion);
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
    repositoryId = configResult.value.repository_id as TypedId<"repo">;
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

    const now = clock.now().toISOString();
    const existingRepository = await getRepositoryById(db, repositoryId);
    if (!existingRepository.ok) {
      return existingRepository;
    }
    if (existingRepository.value === null) {
      const inserted = await insertRepository(db, {
        id: repositoryId,
        rootFingerprint: computeRootFingerprint(gitLocation.commonDir),
        createdAt: now,
        updatedAt: now,
      });
      if (!inserted.ok) {
        return inserted;
      }
    }

    for (const subdirectory of LOCAL_STATE_SUBDIRECTORIES) {
      await mkdir(join(irohaStateDir, subdirectory), { recursive: true });
    }

    const docsScanned: string[] = [];
    let candidatesCreated = 0;
    for (const filename of DOC_SCAN_FILENAMES) {
      const filePath = join(gitLocation.root, filename);
      if (!(await pathExists(filePath))) {
        continue;
      }
      const content = await readFile(filePath, "utf8");
      const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      docsScanned.push(filename);

      const settingKey = `docs_scan:${filename}`;
      const existingSetting = await getLocalSetting(db, repositoryId, settingKey);
      if (!existingSetting.ok) {
        return existingSetting;
      }
      const previousHash =
        existingSetting.value === null
          ? undefined
          : (JSON.parse(existingSetting.value.valueJson) as { hash: string }).hash;
      if (previousHash === contentHash) {
        continue;
      }

      const inserted = await insertCandidate(db, {
        id: makeTypedId("cand", clock, random),
        repositoryId,
        candidateType: "rule",
        payloadJson: JSON.stringify({
          title: `Project instructions from ${filename}`,
          body: content,
          source: { type: "document", path: filename },
        }),
        revisionToken: contentHash,
        createdAt: now,
      });
      if (!inserted.ok) {
        return inserted;
      }
      candidatesCreated += 1;

      const settingUpdate = await upsertLocalSetting(db, {
        repositoryId,
        key: settingKey,
        valueJson: JSON.stringify({ hash: contentHash }),
        updatedAt: now,
      });
      if (!settingUpdate.ok) {
        return settingUpdate;
      }
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
    closeDatabase(db);
  }
}
