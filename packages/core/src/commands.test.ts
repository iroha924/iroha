import { fileURLToPath } from "node:url";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { runInit, runSearch, runSync } from "./commands.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

describe("run* command wrappers", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("runInit initializes and immediately reflects existing canonical documents", async () => {
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
      expect(searchResult.value.map((hit) => hit.entityId)).toEqual([id]);
    }

    const syncResult = await runSync(repoDir, MIGRATIONS_DIR);
    expect(syncResult.ok).toBe(true);
    if (syncResult.ok) {
      expect(syncResult.value.rebuilt).toBe(false);
    }

    const rebuildResult = await runSync(repoDir, MIGRATIONS_DIR, { rebuild: true });
    expect(rebuildResult.ok).toBe(true);
    if (rebuildResult.ok) {
      expect(rebuildResult.value.rebuilt).toBe(true);
    }
  });

  it("runSearch reports NOT_INITIALIZED before iroha init has run", async () => {
    repoDir = await createTempGitRepo();

    const result = await runSearch(repoDir, "anything");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_INITIALIZED");
    }
  });
});
