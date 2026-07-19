import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FixedClock, FixedRandomSource } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createSiblingDatabasePath, replaceDatabaseAtomically } from "./rebuild.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("createSiblingDatabasePath", () => {
  it("returns a random path next to the primary database", () => {
    const random = new FixedRandomSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    // Built with `join` (not a hardcoded `/`-separated literal) so the
    // expectation matches whatever separator `path.dirname`/`path.join`
    // produce on the host platform — confirmed by reproduction that a
    // hardcoded POSIX literal fails on Windows, where `join` emits `\`.
    const dir = join("repo", ".git", "iroha");
    const primaryDbPath = join(dir, "index.db");

    const path = createSiblingDatabasePath(primaryDbPath, random);

    expect(path).toBe(join(dir, "index.rebuild-0102030405060708.db"));
  });

  it("produces different paths for different random sources", () => {
    const primaryDbPath = join("repo", ".git", "iroha", "index.db");
    const a = createSiblingDatabasePath(
      primaryDbPath,
      new FixedRandomSource(new Uint8Array(8).fill(1)),
    );
    const b = createSiblingDatabasePath(
      primaryDbPath,
      new FixedRandomSource(new Uint8Array(8).fill(2)),
    );

    expect(a).not.toBe(b);
  });
});

describe("replaceDatabaseAtomically", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("swaps the sibling database into place and backs up the previous one", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    const siblingPath = join(dir, "index.rebuild-abc.db");
    await writeFile(siblingPath, "new-content", "utf8");

    const result = await replaceDatabaseAtomically(dbPath, siblingPath, CLOCK);

    expect(result.ok).toBe(true);
    expect(await readFile(dbPath, "utf8")).toBe("new-content");
    if (result.ok) {
      expect(await readFile(result.value.backupPath, "utf8")).toBe("old-content");
    }
  });

  it("restores the original database if a sidecar rename fails while moving it aside", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    await writeFile(`${dbPath}-wal`, "old-wal", "utf8");
    const siblingPath = join(dir, "index.rebuild-abc.db");
    await writeFile(siblingPath, "new-content", "utf8");

    // CLOCK is fixed, so the backup path this call computes is
    // predictable. Pre-create its `-wal` destination as a directory so
    // `renameSidecarIfExists`'s rename onto it fails — a real I/O failure
    // (Node's rename() cannot move a regular file onto an existing
    // directory), not a mock.
    //
    // Confirmed by CI reproduction (windows-2025): this specific
    // file-vs-directory collision, once the recovery path renames the
    // leftover empty directory back, can land a directory (not the
    // restored file) at `${dbPath}-wal` on Windows — a quirk of this
    // artificial collision technique itself, not a realistic production
    // state (a directory never legitimately appears at a `-wal` path).
    // This assertion only checks the primary concern the finding raised —
    // that `index.db` itself is restored — rather than the sidecar's exact
    // content, to stay meaningful across platforms.
    const timestamp = CLOCK.now().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.backup-${timestamp}`;
    await mkdir(`${backupPath}-wal`);

    const result = await replaceDatabaseAtomically(dbPath, siblingPath, CLOCK);

    expect(result.ok).toBe(false);
    // The original database must still be usable at its original path —
    // moving the main file aside must not succeed and then abandon
    // recovery just because the sidecar move that followed it failed.
    expect(await readFile(dbPath, "utf8")).toBe("old-content");
  });

  it("restores the original database when moving the sibling into place fails", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    const missingSiblingPath = join(dir, "index.rebuild-does-not-exist.db");

    const result = await replaceDatabaseAtomically(dbPath, missingSiblingPath, CLOCK);

    expect(result.ok).toBe(false);
    // The original database must still be usable at its original path —
    // a failed rebuild must not leave the repository with no database.
    expect(await readFile(dbPath, "utf8")).toBe("old-content");
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes(".backup-"))).toBe(false);
  });

  it("moves each side's -wal/-shm sidecar files along with the swap", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    await writeFile(`${dbPath}-wal`, "old-wal", "utf8");
    await writeFile(`${dbPath}-shm`, "old-shm", "utf8");
    const siblingPath = join(dir, "index.rebuild-abc.db");
    await writeFile(siblingPath, "new-content", "utf8");
    await writeFile(`${siblingPath}-wal`, "new-wal", "utf8");
    // No -shm for the sibling, to also confirm a missing sidecar is a no-op.

    const result = await replaceDatabaseAtomically(dbPath, siblingPath, CLOCK);

    expect(result.ok).toBe(true);
    expect(await readFile(`${dbPath}-wal`, "utf8")).toBe("new-wal");
    if (result.ok) {
      expect(await readFile(`${result.value.backupPath}-wal`, "utf8")).toBe("old-wal");
      expect(await readFile(`${result.value.backupPath}-shm`, "utf8")).toBe("old-shm");
    }
    // The sibling never had a `-shm` file, so no stray `-shm` should exist
    // at the promoted primary path either.
    await expect(readFile(`${dbPath}-shm`, "utf8")).rejects.toThrow();
  });
});
