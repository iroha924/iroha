import { access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  getEntityById,
  getSearchDocumentByEntityId,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository } from "./init-repository.js";
import { rebuildDatabase } from "./rebuild-database.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

// `replaceDatabaseAtomically`'s own rename retries (packages/storage/src/rebuild.ts,
// up to ~3s worst case) can push these tests past vitest's 5000ms default.
const REBUILD_TEST_TIMEOUT_MS = 15000;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("rebuildDatabase", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("refuses to rebuild a repository that was never initialized", async () => {
    repoDir = await createTempGitRepo();

    const result = await rebuildDatabase(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_INITIALIZED");
    }
  });

  it(
    "rebuilds a fresh database that reflects .iroha/'s current canonical documents",
    async () => {
      repoDir = await createTempGitRepo();
      const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const decisionId = makeTypedId("dec", CLOCK, new CryptoRandomSource());
      const written = await writeCanonicalDocument(
        {
          frontmatter: {
            schema_version: 1,
            id: decisionId,
            type: "decision",
            title: "Use libSQL",
            status: "approved",
            revision: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            created_by: { provider: "git", display_name: "Example Developer" },
            approved_by: { provider: "git", display_name: "Example Reviewer" },
            approved_at: "2026-01-01T00:00:00.000Z",
            labels: [],
            scope: { repository: init.value.repositoryId, paths: [], symbols: [] },
            sources: [{ type: "url", ref: "https://example.com" }],
            relations: [],
            decision: { kind: "architecture" },
          },
          body: [
            "# Use libSQL",
            "## Context",
            "",
            "Context.",
            "## Decision",
            "",
            "Decision.",
            "## Rationale",
            "",
            "Rationale.",
            "## Consequences",
            "",
            "Consequences.",
            "## Alternatives considered",
            "",
            "None.",
          ].join("\n\n"),
        },
        init.value.irohaCanonicalDir,
        new CryptoRandomSource(),
      );
      expect(written.ok).toBe(true);

      const rebuilt = await rebuildDatabase(
        repoDir,
        CLOCK,
        new CryptoRandomSource(),
        MIGRATIONS_DIR,
      );
      expect(
        rebuilt.ok,
        rebuilt.ok
          ? undefined
          : `${rebuilt.error.code}: ${rebuilt.error.message} (cause: ${String(rebuilt.error.cause)})`,
      ).toBe(true);
      if (!rebuilt.ok) return;

      expect(rebuilt.value.repositoryId).toBe(init.value.repositoryId);
      expect(rebuilt.value.sync.added).toBe(1);
      // This repo was already initialized (index.db existed), so the rebuild
      // moves the previous database aside to a real backup path.
      const { backupPath } = rebuilt.value;
      expect(backupPath).not.toBeNull();
      if (backupPath !== null) {
        expect(await fileExists(backupPath)).toBe(true);
      }

      const opened = await openDatabase(rebuilt.value.dbPath);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        const entity = await getEntityById(opened.value, decisionId);
        expect(entity.ok).toBe(true);
        if (entity.ok) {
          expect(entity.value?.authority).toBe(100);
        }
        const searchDoc = await getSearchDocumentByEntityId(opened.value, decisionId);
        expect(searchDoc.ok).toBe(true);
        if (searchDoc.ok) {
          expect(searchDoc.value).not.toBeNull();
        }
        await closeDatabase(opened.value);
      }
    },
    REBUILD_TEST_TIMEOUT_MS,
  );

  it(
    "bootstraps the local database on a fresh clone that was never initialized locally",
    async () => {
      // Simulate a teammate's `git clone`: the git-tracked `.iroha/` canonical
      // files are present, but the git-ignored primary `index.db` (which lives
      // under the git directory, not in `.iroha/`) was never created locally.
      repoDir = await createTempGitRepo();
      const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const decisionId = makeTypedId("dec", CLOCK, new CryptoRandomSource());
      const written = await writeCanonicalDocument(
        {
          frontmatter: {
            schema_version: 1,
            id: decisionId,
            type: "decision",
            title: "Use libSQL",
            status: "approved",
            revision: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            created_by: { provider: "git", display_name: "Example Developer" },
            approved_by: { provider: "git", display_name: "Example Reviewer" },
            approved_at: "2026-01-01T00:00:00.000Z",
            labels: [],
            scope: { repository: init.value.repositoryId, paths: [], symbols: [] },
            sources: [{ type: "url", ref: "https://example.com" }],
            relations: [],
            decision: { kind: "architecture" },
          },
          body: [
            "# Use libSQL",
            "## Context",
            "",
            "Context.",
            "## Decision",
            "",
            "Decision.",
            "## Rationale",
            "",
            "Rationale.",
            "## Consequences",
            "",
            "Consequences.",
            "## Alternatives considered",
            "",
            "None.",
          ].join("\n\n"),
        },
        init.value.irohaCanonicalDir,
        new CryptoRandomSource(),
      );
      expect(written.ok).toBe(true);

      // Remove the local database `initRepository` just created, plus its WAL
      // sidecars, so the repo looks exactly like a fresh clone. Retries on the
      // Windows native-binding handle-teardown lag documented in
      // `windows-ci-compat.md` (test setup, not a product guarantee).
      for (const suffix of ["", "-wal", "-shm"]) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await rm(`${init.value.dbPath}${suffix}`, { force: true });
            break;
          } catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if ((code !== "EBUSY" && code !== "EPERM") || attempt === 5) {
              throw cause;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          }
        }
      }
      expect(await fileExists(init.value.dbPath)).toBe(false);

      const rebuilt = await rebuildDatabase(
        repoDir,
        CLOCK,
        new CryptoRandomSource(),
        MIGRATIONS_DIR,
      );
      expect(
        rebuilt.ok,
        rebuilt.ok
          ? undefined
          : `${rebuilt.error.code}: ${rebuilt.error.message} (cause: ${String(rebuilt.error.cause)})`,
      ).toBe(true);
      if (!rebuilt.ok) return;

      // Bootstrapped: no previous database existed to back up.
      expect(rebuilt.value.backupPath).toBeNull();
      expect(rebuilt.value.sync.added).toBe(1);
      expect(await fileExists(rebuilt.value.dbPath)).toBe(true);

      // The bootstrapped database reflects the committed canonical decision.
      const opened = await openDatabase(rebuilt.value.dbPath);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        const entity = await getEntityById(opened.value, decisionId);
        expect(entity.ok).toBe(true);
        if (entity.ok) {
          expect(entity.value?.authority).toBe(100);
        }
        await closeDatabase(opened.value);
      }
    },
    REBUILD_TEST_TIMEOUT_MS,
  );
});
