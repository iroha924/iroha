import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { runGit } from "@iroha/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-cli-test-"));
  await runGit(["init", "--initial-branch=main"], { cwd: dir });
  await runGit(["config", "user.email", "iroha-test@example.com"], { cwd: dir });
  await runGit(["config", "user.name", "iroha test"], { cwd: dir });
  return dir;
}

/**
 * Windows file-handle teardown lag — see `@iroha/storage`'s
 * `test-helpers/tmp-db.ts` for the reproduction. `runCli` opens and closes
 * real libSQL connections inside `dir`, so removing it needs the same
 * bounded retry.
 */
async function removeTempDir(dir: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") {
        throw cause;
      }
      if (attempt === maxAttempts) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

function captureStdout(): { text: () => string; restore: () => void } {
  let buffer = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    buffer += chunk.toString();
    return true;
  });
  return {
    text: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

async function writeCanonicalFixture(irohaCanonicalDir: string): Promise<void> {
  const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const repositoryId = makeTypedId("repo", clock, new CryptoRandomSource());
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
        scope: { repository: repositoryId, paths: [], symbols: [] },
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
    irohaCanonicalDir,
    new CryptoRandomSource(),
  );
  if (!written.ok) {
    throw new Error(`failed to write canonical fixture: ${written.error.message}`);
  }
}

describe("runCli", () => {
  let repoDir: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("initializes a fresh repository via `iroha init`", async () => {
    repoDir = await createTempGitRepo();
    process.chdir(repoDir);
    const stdout = captureStdout();

    await runCli(["init", "--json"]);
    stdout.restore();

    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(true);
    expect(parsed.init.freshInit).toBe(true);
  });

  it("reports ok checks via `iroha doctor` after init", async () => {
    repoDir = await createTempGitRepo();
    process.chdir(repoDir);
    await runCli(["init", "--json"]);

    const stdout = captureStdout();
    await runCli(["doctor", "--json"]);
    stdout.restore();

    const parsed = JSON.parse(stdout.text());
    const byName = new Map(
      (parsed.doctor.checks as Array<{ name: string; status: string }>).map((c) => [c.name, c]),
    );
    expect(byName.get("iroha-init")?.status).toBe("ok");
  });

  it("finds a synced canonical document via `iroha search`", async () => {
    repoDir = await createTempGitRepo();
    process.chdir(repoDir);
    await runCli(["init", "--json"]);
    await writeCanonicalFixture(join(repoDir, ".iroha"));

    const syncStdout = captureStdout();
    await runCli(["sync", "--json"]);
    syncStdout.restore();
    const syncParsed = JSON.parse(syncStdout.text());
    expect(syncParsed.sync.added).toBe(1);

    const searchStdout = captureStdout();
    await runCli(["search", "--json", "libSQL"]);
    searchStdout.restore();
    const searchParsed = JSON.parse(searchStdout.text());
    expect(searchParsed.hits.length).toBe(1);

    // --mode forces the retrieval arm and the effective mode is surfaced.
    const lexStdout = captureStdout();
    await runCli(["search", "--json", "--mode", "lexical", "libSQL"]);
    lexStdout.restore();
    const lexParsed = JSON.parse(lexStdout.text());
    expect(lexParsed.effectiveMode).toBe("lexical");
    expect(lexParsed.hits.length).toBe(1);

    // --type filters by entity type: the fixture is a decision, not a rule.
    const decStdout = captureStdout();
    await runCli(["search", "--json", "--type", "decision", "libSQL"]);
    decStdout.restore();
    expect(JSON.parse(decStdout.text()).hits.length).toBe(1);

    const ruleStdout = captureStdout();
    await runCli(["search", "--json", "--type", "rule", "libSQL"]);
    ruleStdout.restore();
    expect(JSON.parse(ruleStdout.text()).hits.length).toBe(0);
  });

  it("exits non-zero when launching the dashboard in an uninitialized repository", async () => {
    repoDir = await createTempGitRepo();
    process.chdir(repoDir);

    await runCli(["dashboard"]);
    expect(process.exitCode).toBe(1);
  });
});
