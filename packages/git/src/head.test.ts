import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHeadState } from "./head.js";
import { runGit } from "./run-git.js";
import { commitFile, createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

describe("readHeadState", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo("iroha-head-test-");
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("reports the checked-out branch and the full HEAD sha", async () => {
    await commitFile(repoDir, "a.txt", "a");

    const result = await readHeadState(repoDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.branch).toBe("main");
    expect(result.value.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a detached HEAD as no branch, keeping the sha", async () => {
    await commitFile(repoDir, "a.txt", "a");
    const detach = await runGit(["checkout", "--detach"], { cwd: repoDir });
    expect(detach.ok).toBe(true);

    const result = await readHeadState(repoDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.branch).toBe(null);
    expect(result.value.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a non-default branch name", async () => {
    await commitFile(repoDir, "a.txt", "a");
    const branch = await runGit(["checkout", "-b", "feat/x"], { cwd: repoDir });
    expect(branch.ok).toBe(true);

    const result = await readHeadState(repoDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.branch).toBe("feat/x");
  });

  it("reports the branch name unshadowed by a tag of the same name", async () => {
    // `--abbrev-ref HEAD` disambiguates this to `heads/main`; the full symbolic
    // name does not collide.
    await commitFile(repoDir, "a.txt", "a");
    const tag = await runGit(["tag", "main"], { cwd: repoDir });
    expect(tag.ok).toBe(true);

    const result = await readHeadState(repoDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.branch).toBe("main");
  });

  it("fails on an unborn HEAD, since there is no commit to record", async () => {
    const result = await readHeadState(repoDir);

    expect(result.ok).toBe(false);
  });

  it("fails outside a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iroha-head-outside-"));
    try {
      const result = await readHeadState(outside);

      expect(result.ok).toBe(false);
    } finally {
      await removeTempDir(outside);
    }
  });
});
