import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { runSync } from "./commands.js";
import { initRepository } from "./init-repository.js";
import { resolveInitializedRepository } from "./resolve-repository.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("iroha sync applies pending migrations", () => {
  let repoDir: string | undefined;
  let onlyV1Dir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
    if (onlyV1Dir) {
      await removeTempDir(onlyV1Dir);
      onlyV1Dir = undefined;
    }
  });

  it("upgrades a DB initialized at an older schema version (regression for the silent-hook-death finding)", async () => {
    // Initialize the repo with a migrations dir that only contains 001, leaving
    // the DB at user_version = 1 with no `session_tokens` table — the state an
    // older build would have left behind.
    onlyV1Dir = await mkdtemp(join(tmpdir(), "iroha-only-v1-"));
    await writeFile(
      join(onlyV1Dir, "001_initial.sql"),
      await readFile(join(MIGRATIONS_DIR, "001_initial.sql"), "utf8"),
      "utf8",
    );
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), onlyV1Dir);
    expect(init.ok).toBe(true);

    // A plain (non-rebuild) `iroha sync` with the current migrations dir must
    // apply every pending migration (002 and 003).
    const synced = await runSync(repoDir, MIGRATIONS_DIR);
    expect(synced.ok).toBe(true);

    const repo = await resolveInitializedRepository(repoDir);
    if (!repo.ok) throw new Error("repo not resolved");
    const opened = await openDatabase(repo.value.dbPath);
    if (!opened.ok) throw new Error("db not opened");
    try {
      const userVersion = await opened.value.execute("PRAGMA user_version");
      expect(userVersion.rows[0]?.user_version).toBe(3);
      const table = await opened.value.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_tokens'",
      );
      expect(table.rows.length).toBe(1);
    } finally {
      await closeDatabase(opened.value);
    }
  });
});
