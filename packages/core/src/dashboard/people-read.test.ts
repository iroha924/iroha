import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource } from "@iroha/domain";
import { runGit } from "@iroha/git";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { listRepositoryPeople } from "./people-read.js";

const random = new CryptoRandomSource();

describe("listRepositoryPeople", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("returns the repository's people and the local identity", async () => {
    repo = await setupMcpRepo(random);

    const result = await listRepositoryPeople({ cwd: repo.repoDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.self).not.toBeNull();
    expect(result.value.names).toContain(result.value.self);
  });

  it("fails rather than reporting people outside a Git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iroha-people-nonrepo-"));
    try {
      const result = await listRepositoryPeople({ cwd: dir });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports NOT_INITIALIZED in a Git repository without .iroha/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iroha-people-uninit-"));
    try {
      await runGit(["init", "--initial-branch=main"], { cwd: dir });

      const result = await listRepositoryPeople({ cwd: dir });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_INITIALIZED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
