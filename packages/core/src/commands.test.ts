import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { runInit, runSearch, runSync } from "./commands.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

// `runSync({ rebuild: true })` exercises `replaceDatabaseAtomically`'s rename
// retries (packages/storage/src/rebuild.ts, up to ~3s worst case), which can
// push this test past vitest's 5000ms default.
const RUN_INIT_TEST_TIMEOUT_MS = 15000;

describe("run* command wrappers", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it(
    "runInit initializes and immediately reflects existing canonical documents",
    async () => {
      repoDir = await createTempGitRepo();

      const bootstrap = await runInit(repoDir, MIGRATIONS_DIR);
      expect(bootstrap.ok).toBe(true);
      if (!bootstrap.ok) return;
      expect(bootstrap.value.init.freshInit).toBe(true);

      const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
      const id = makeTypedId("dec", clock, new CryptoRandomSource());
      const written = await writeCanonicalDocument(
        {
          frontmatter: {
            schema_version: 1,
            id,
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
            scope: { repository: bootstrap.value.init.repositoryId, paths: [], symbols: [] },
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
        bootstrap.value.init.irohaCanonicalDir,
        new CryptoRandomSource(),
      );
      expect(written.ok).toBe(true);

      const second = await runInit(repoDir, MIGRATIONS_DIR);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.sync.added).toBe(1);
      }

      const searchResult = await runSearch(repoDir, "libSQL");
      expect(searchResult.ok).toBe(true);
      if (searchResult.ok) {
        expect(searchResult.value.results.map((hit) => hit.id)).toEqual([id]);
      }

      // A non-positive limit is clamped to 1, not forwarded as `slice(0, -1)`
      // (which would drop the single matching row and return nothing).
      const clamped = await runSearch(repoDir, "libSQL", { limit: -1 });
      expect(clamped.ok).toBe(true);
      if (clamped.ok) {
        expect(clamped.value.results.length).toBe(1);
      }

      const syncResult = await runSync(repoDir, MIGRATIONS_DIR);
      expect(syncResult.ok).toBe(true);
      if (syncResult.ok && !syncResult.value.rebuilt) {
        expect(syncResult.value.rebuilt).toBe(false);
        // `iroha sync` is retention's only scheduled moment (there is no daemon),
        // so it must reach the retention step — reporting "disabled" until a
        // window is set, never being absent.
        expect(syncResult.value.retention).toEqual({ status: "disabled", days: null });
      }

      const rebuildResult = await runSync(repoDir, MIGRATIONS_DIR, { rebuild: true });
      expect(
        rebuildResult.ok,
        rebuildResult.ok
          ? undefined
          : `${rebuildResult.error.code}: ${rebuildResult.error.message} (cause: ${String(rebuildResult.error.cause)})`,
      ).toBe(true);
      if (rebuildResult.ok) {
        expect(rebuildResult.value.rebuilt).toBe(true);
      }
    },
    RUN_INIT_TEST_TIMEOUT_MS,
  );

  it("runSearch reports NOT_INITIALIZED before iroha init has run", async () => {
    repoDir = await createTempGitRepo();

    const result = await runSearch(repoDir, "anything");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_INITIALIZED");
    }
  });

  it("runSync re-reads repository docs edited after init (contracts/canonical.md §14)", async () => {
    repoDir = await createTempGitRepo();
    const claudeMd = join(repoDir, "CLAUDE.md");
    await writeFile(claudeMd, "# Project\n\nThe original rule.\n", "utf8");

    const init = await runInit(repoDir, MIGRATIONS_DIR);
    expect(init.ok).toBe(true);
    if (init.ok) {
      expect(init.value.init.entitiesWritten).toBe(1);
    }

    // Init alone would leave the index quoting a rule the repository has since
    // replaced; nothing else re-reads these files.
    await writeFile(claudeMd, "# Project\n\nThe replacement rule.\n", "utf8");
    const synced = await runSync(repoDir, MIGRATIONS_DIR);
    expect(synced.ok).toBe(true);
    if (synced.ok && !synced.value.rebuilt) {
      expect(synced.value.imported.entitiesWritten).toBe(1);
      expect(synced.value.imported.entitiesTombstoned).toBe(0);
    }

    const found = await runSearch(repoDir, "replacement", { mode: "lexical" });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.results.map((r) => r.title)).toContain(
        "Project instructions from CLAUDE.md",
      );
    }

    // Deleting the file retires the entity rather than leaving it searchable.
    await rm(claudeMd);
    const afterDelete = await runSync(repoDir, MIGRATIONS_DIR);
    expect(afterDelete.ok).toBe(true);
    if (afterDelete.ok && !afterDelete.value.rebuilt) {
      expect(afterDelete.value.imported.entitiesTombstoned).toBe(1);
    }
    const gone = await runSearch(repoDir, "replacement", { mode: "lexical" });
    expect(gone.ok).toBe(true);
    if (gone.ok) {
      expect(gone.value.results).toEqual([]);
    }
  });
});
