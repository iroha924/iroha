import { access, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
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

// `replaceDatabaseAtomically`'s own rename retries (packages/storage/src/rebuild.ts)
// can take up to ~9s worst case on Windows CI, and this file's own rm() retry
// below has a similar worst case; give these tests headroom above vitest's
// 5000ms default so a legitimate retry sequence isn't mistaken for a hang.
const REBUILD_TEST_TIMEOUT_MS = 30000;

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
      expect(await fileExists(rebuilt.value.backupPath)).toBe(true);

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
        closeDatabase(opened.value);
      }
    },
    REBUILD_TEST_TIMEOUT_MS,
  );

  it(
    "cleans up the sibling database file when the final atomic swap fails",
    async () => {
      repoDir = await createTempGitRepo();
      const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
      expect(init.ok).toBe(true);
      if (!init.ok) return;

      // Deleting the primary DB file makes `replaceDatabaseAtomically`'s first
      // rename (`primaryDbPath -> backupPath`) fail with ENOENT — a clean,
      // cross-platform way to force this specific failure path without
      // relying on OS-specific file-locking/permission behavior. Retries on
      // EBUSY/EPERM: confirmed by CI reproduction that deleting a database
      // file immediately after `initRepository` closed its connection can
      // stay busy on Windows for longer than the 1.5s budget that is enough
      // for `test-helpers/tmp-repo.ts`'s `removeTempDir` (which runs later,
      // in `afterEach`, giving the native binding's teardown more time to
      // finish first) — see `windows-ci-compat.md` and
      // `packages/storage/src/rebuild.ts`'s `renameWithRetry`, which needed
      // the same widening.
      for (let attempt = 1; attempt <= 20; attempt++) {
        try {
          await rm(init.value.dbPath, { force: true });
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if ((code !== "EBUSY" && code !== "EPERM") || attempt === 20) {
            throw cause;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 100, 500)));
        }
      }

      const result = await rebuildDatabase(
        repoDir,
        CLOCK,
        new CryptoRandomSource(),
        MIGRATIONS_DIR,
      );
      expect(result.ok).toBe(false);

      const dbDir = dirname(init.value.dbPath);
      const remaining = await readdir(dbDir);
      const siblingFiles = remaining.filter((name) => name.includes("index.rebuild-"));
      expect(siblingFiles).toEqual([]);
    },
    REBUILD_TEST_TIMEOUT_MS,
  );
});
