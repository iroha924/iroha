import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  getEntityById,
  getLocalSetting,
  getSearchDocumentByEntityId,
  listKnowledgeEntities,
  openDatabase,
  upsertLocalSetting,
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
    "carries local settings onto the rebuilt database",
    async () => {
      repoDir = await createTempGitRepo();
      const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      const before = await openDatabase(init.value.dbPath);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const stored = await upsertLocalSetting(before.value, {
        repositoryId: init.value.repositoryId,
        key: "retention.local_events",
        valueJson: JSON.stringify({ days: 30 }),
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(stored.ok).toBe(true);
      await closeDatabase(before.value);

      const rebuilt = await rebuildDatabase(
        repoDir,
        CLOCK,
        new CryptoRandomSource(),
        MIGRATIONS_DIR,
      );
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      // A retention window is a deliberate privacy choice and is not
      // reconstructible from `.iroha/`. Losing it here would silently reset
      // pruning to "keep forever" after a routine repair.
      const after = await openDatabase(rebuilt.value.dbPath);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      try {
        const setting = await getLocalSetting(
          after.value,
          rebuilt.value.repositoryId,
          "retention.local_events",
        );
        expect(setting.ok).toBe(true);
        if (!setting.ok) return;
        expect(setting.value?.valueJson).toBe(JSON.stringify({ days: 30 }));
      } finally {
        await closeDatabase(after.value);
      }
    },
    REBUILD_TEST_TIMEOUT_MS,
  );

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

  it(
    "re-derives imported repository docs from the source files (contracts/canonical.md §14)",
    async () => {
      // Imported entities live only in the index, so nothing carries them over
      // from the old database — a rebuild that did not re-read the source files
      // would silently drop every repository rule.
      repoDir = await createTempGitRepo();
      await writeFile(join(repoDir, "CLAUDE.md"), "# Project\n\nRun the tests.\n", "utf8");
      const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.value.entitiesWritten).toBe(1);

      const rebuilt = await rebuildDatabase(
        repoDir,
        CLOCK,
        new CryptoRandomSource(),
        MIGRATIONS_DIR,
      );
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      const opened = await openDatabase(rebuilt.value.dbPath);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        const imported = await listKnowledgeEntities(opened.value, rebuilt.value.repositoryId, {
          statuses: ["imported"],
          limit: 10,
        });
        expect(imported.ok).toBe(true);
        if (imported.ok) {
          expect(imported.value.map((e) => e.sourceRef)).toEqual(["CLAUDE.md"]);
        }
        await closeDatabase(opened.value);
      }
    },
    REBUILD_TEST_TIMEOUT_MS,
  );
});
