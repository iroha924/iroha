import { mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitLocation, resolveGitPath } from "./location.js";
import { runGit } from "./run-git.js";
import { commitFile, createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

describe("resolveGitLocation", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("resolves root/commonDir/gitDir for a normal repository", async () => {
    const realRoot = await realpath(repoDir);

    const result = await resolveGitLocation(repoDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.root).toBe(realRoot);
      expect(result.value.commonDir).toBe(join(realRoot, ".git"));
      expect(result.value.gitDir).toBe(join(realRoot, ".git"));
    }
  });

  it("resolves the same root when launched from a subdirectory", async () => {
    const realRoot = await realpath(repoDir);
    const subdir = join(repoDir, "nested", "deeper");
    await mkdir(subdir, { recursive: true });

    const result = await resolveGitLocation(subdir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.root).toBe(realRoot);
    }
  });

  it("resolves a repository root containing spaces and Japanese characters", async () => {
    const nested = join(repoDir, "空 の フォルダ with spaces");
    await mkdir(nested, { recursive: true });
    const realRoot = await realpath(repoDir);

    const result = await resolveGitLocation(nested);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.root).toBe(realRoot);
    }
  });

  it("resolves commonDir to the main worktree and a distinct gitDir for a linked worktree", async () => {
    await commitFile(repoDir, "README.md", "# test\n");
    const worktreeDir = `${repoDir}-linked`;
    const addWorktree = await runGit(["worktree", "add", worktreeDir, "-b", "feature"], {
      cwd: repoDir,
    });
    expect(addWorktree.ok).toBe(true);

    try {
      const realRoot = await realpath(repoDir);
      const realWorktreeRoot = await realpath(worktreeDir);

      const result = await resolveGitLocation(worktreeDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.root).toBe(realWorktreeRoot);
        expect(result.value.commonDir).toBe(join(realRoot, ".git"));
        expect(result.value.gitDir).not.toBe(result.value.commonDir);
        expect(result.value.gitDir.startsWith(join(realRoot, ".git", "worktrees"))).toBe(true);
      }
    } finally {
      await removeTempDir(worktreeDir);
    }
  });

  it("fails with REPOSITORY_NOT_FOUND outside any Git repository", async () => {
    const outside = await realpath(tmpdir());

    const result = await resolveGitLocation(outside);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
    }
  });
});

describe("resolveGitPath", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("resolves a namespaced path inside the git dir", async () => {
    const realRoot = await realpath(repoDir);

    const result = await resolveGitPath(repoDir, "iroha");

    expect(result).toEqual({ ok: true, value: join(realRoot, ".git", "iroha") });
  });

  it("returns an error Result instead of throwing when the target is a symlink cycle", async () => {
    const gitDir = join(repoDir, ".git");
    await symlink(join(gitDir, "cycle-b"), join(gitDir, "cycle-a"));
    await symlink(join(gitDir, "cycle-a"), join(gitDir, "cycle-b"));

    const result = await resolveGitPath(repoDir, "cycle-a");

    expect(result.ok).toBe(false);
  });
});
