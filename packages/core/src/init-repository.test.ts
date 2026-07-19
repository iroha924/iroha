import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import {
  closeDatabase,
  getRepositoryById,
  listCandidatesByStatus,
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
    expect(result.value.docsScanned).toEqual([]);
    expect(result.value.candidatesCreated).toBe(0);

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
      closeDatabase(opened.value);
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
    expect(second.value.candidatesCreated).toBe(0);
  });

  it("does not scan docs into candidates unless options.scan is set (canonical-schema.md §14: --scan only)", async () => {
    repoDir = await createTempGitRepo();
    await writeFile(join(repoDir, "AGENTS.md"), "# Agents\n\nFollow these rules.", "utf8");

    const withoutScan = await initRepository(
      repoDir,
      CLOCK,
      new CryptoRandomSource(),
      MIGRATIONS_DIR,
    );
    expect(withoutScan.ok).toBe(true);
    if (!withoutScan.ok) return;
    expect(withoutScan.value.docsScanned).toEqual([]);
    expect(withoutScan.value.candidatesCreated).toBe(0);

    const withScan = await initRepository(
      repoDir,
      CLOCK,
      new CryptoRandomSource(),
      MIGRATIONS_DIR,
      {
        scan: true,
      },
    );
    expect(withScan.ok).toBe(true);
    if (!withScan.ok) return;
    expect(withScan.value.docsScanned).toEqual(["AGENTS.md"]);
    expect(withScan.value.candidatesCreated).toBe(1);

    const opened = await openDatabase(withScan.value.dbPath);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const pending = await listCandidatesByStatus(
        opened.value,
        withScan.value.repositoryId,
        "pending",
      );
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        expect(pending.value.length).toBe(1);
        expect(pending.value[0]?.candidateType).toBe("rule");
      }
      closeDatabase(opened.value);
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
      closeDatabase(opened.value);
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
});
