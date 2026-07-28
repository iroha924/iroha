import { describe, expect, it } from "vitest";
import { readRepositoryPeople } from "./people.js";
import { runGit } from "./run-git.js";
import { commitFile, createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

async function commitAs(dir: string, name: string, email: string, file: string): Promise<void> {
  await runGit(["config", "user.name", name], { cwd: dir });
  await runGit(["config", "user.email", email], { cwd: dir });
  await commitFile(dir, file, name);
}

describe("readRepositoryPeople", () => {
  it("returns distinct commit authors alphabetically, with the configured identity as self", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "zoe", "zoe@example.com", "a.txt");
      await commitAs(dir, "alice", "alice@example.com", "b.txt");
      await commitAs(dir, "zoe", "zoe@example.com", "c.txt");
      await runGit(["config", "user.name", "alice"], { cwd: dir });

      const result = await readRepositoryPeople(dir);

      expect(result.names).toEqual(["alice", "zoe"]);
      expect(result.self).toBe("alice");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("excludes forge bot authors", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "dependabot[bot]", "dependabot[bot]@example.com", "a.txt");
      await commitAs(dir, "iroha924", "iroha924@example.com", "b.txt");

      const result = await readRepositoryPeople(dir);

      expect(result.names).toEqual(["iroha924"]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("includes the configured identity even when it has never committed", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await runGit(["config", "user.name", "newcomer"], { cwd: dir });

      const result = await readRepositoryPeople(dir);

      expect(result.names).toEqual(["alice", "newcomer"]);
      expect(result.self).toBe("newcomer");
    } finally {
      await removeTempDir(dir);
    }
  });

  // `git log` exits 128 on an unborn HEAD. The identity is not asserted away
  // here: `runGit` keeps HOME, so `git config --get user.name` still resolves
  // the developer's global identity, which is the value this is meant to read.
  it("contributes no author names on a repository with no commits", async () => {
    const dir = await createTempGitRepo();
    try {
      const result = await readRepositoryPeople(dir);

      const authorsBeyondSelf = result.names.filter((n) => n !== result.self);
      expect(authorsBeyondSelf).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });
});
