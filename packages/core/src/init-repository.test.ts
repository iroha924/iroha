import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import {
  closeDatabase,
  getRepositoryById,
  listCandidatesByStatus,
  listKnowledgeEntities,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository } from "./init-repository.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("initRepository", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("bootstraps .iroha/ and the local DB on a fresh repository", async () => {
    repoDir = await createTempGitRepo();

    const result = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.freshInit).toBe(true);
    expect(result.value.docsImported).toEqual([]);
    expect(result.value.entitiesWritten).toBe(0);

    const schemaVersion = await readFile(join(repoDir, ".iroha", "schema-version"), "utf8");
    expect(schemaVersion.trim()).toBe("1");

    const configContent = await readFile(join(repoDir, ".iroha", "config.yaml"), "utf8");
    expect(configContent).toContain(result.value.repositoryId);

    const labelsContent = await readFile(
      join(repoDir, ".iroha", "taxonomy", "labels.yaml"),
      "utf8",
    );
    expect(labelsContent).toContain("schema_version");

    const opened = await openDatabase(result.value.dbPath);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const repoRow = await getRepositoryById(opened.value, result.value.repositoryId);
      expect(repoRow.ok).toBe(true);
      if (repoRow.ok) {
        expect(repoRow.value).not.toBeNull();
      }
      await closeDatabase(opened.value);
    }
  });

  it("is idempotent: a second run makes no further changes", async () => {
    repoDir = await createTempGitRepo();

    const first = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.freshInit).toBe(false);
    expect(second.value.repositoryId).toBe(first.value.repositoryId);
    expect(second.value.entitiesWritten).toBe(0);
  });

  it("imports repository docs as knowledge, never as candidates (contracts/canonical.md §14)", async () => {
    repoDir = await createTempGitRepo();
    await writeFile(join(repoDir, "AGENTS.md"), "# Agents\n\nFollow these rules.", "utf8");

    const result = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsImported).toEqual(["AGENTS.md"]);
    expect(result.value.entitiesWritten).toBe(1);

    const opened = await openDatabase(result.value.dbPath);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const pending = await listCandidatesByStatus(
        opened.value,
        result.value.repositoryId,
        "pending",
      );
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        expect(pending.value).toEqual([]);
      }

      const imported = await listKnowledgeEntities(opened.value, result.value.repositoryId, {
        statuses: ["imported"],
        limit: 10,
      });
      expect(imported.ok).toBe(true);
      if (imported.ok) {
        expect(imported.value).toHaveLength(1);
        expect(imported.value[0]?.sourceRef).toBe("AGENTS.md");
        expect(imported.value[0]?.sourceKind).toBe("import");
      }
      await closeDatabase(opened.value);
    }

    const rerun = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(rerun.ok).toBe(true);
    if (rerun.ok) {
      expect(rerun.value.entitiesWritten).toBe(0);
    }
  });

  it("converges to the same repository_id when two processes race the very first init", async () => {
    repoDir = await createTempGitRepo();

    const [first, second] = await Promise.all([
      initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR),
      initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.repositoryId).toBe(first.value.repositoryId);

    const configContent = await readFile(join(repoDir, ".iroha", "config.yaml"), "utf8");
    expect(configContent).toContain(first.value.repositoryId);

    const opened = await openDatabase(first.value.dbPath);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const repoRow = await getRepositoryById(opened.value, first.value.repositoryId);
      expect(repoRow.ok).toBe(true);
      if (repoRow.ok) {
        expect(repoRow.value).not.toBeNull();
      }
      await closeDatabase(opened.value);
    }

    const third = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.value.repositoryId).toBe(first.value.repositoryId);
      expect(third.value.freshInit).toBe(false);
    }
  });

  it("refuses to initialize against an unsupported .iroha/ schema version", async () => {
    repoDir = await createTempGitRepo();
    await mkdir(join(repoDir, ".iroha"), { recursive: true });
    await writeFile(join(repoDir, ".iroha", "schema-version"), "2\n", "utf8");

    const result = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_MISMATCH");
    }
  });
  it("removes the pre-0.6.0 secret-location keys from the file, not just from the parse", async () => {
    repoDir = await createTempGitRepo();
    const first = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const configPath = join(first.value.irohaCanonicalDir, "config.yaml");
    const legacy = (await readFile(configPath, "utf8"))
      .replace("    dimension: 1024", "    dimension: 1024\n    api_key_env: VOYAGE_API_KEY")
      .replace("  provider: github", "  provider: github\n  api_token_env: GITHUB_TOKEN")
      .replace("default_language: en", "default_language: ja");
    await writeFile(configPath, legacy, "utf8");

    const migrated = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(migrated.ok).toBe(true);

    // Dropping them on read is invisible to the teammate who opens the committed
    // file, sets the variable it names, and gets nothing.
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("api_key_env");
    expect(after).not.toContain("api_token_env");
    // The rewrite must not reset the user's own settings to the defaults.
    expect(after).toContain("default_language: ja");
    expect(after).toContain(first.value.repositoryId);
  });

  it("leaves a current config.yaml byte-identical, so init stays idempotent", async () => {
    repoDir = await createTempGitRepo();
    const first = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const configPath = join(first.value.irohaCanonicalDir, "config.yaml");
    const before = await readFile(configPath, "utf8");

    await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);

    expect(await readFile(configPath, "utf8")).toBe(before);
  });
});
