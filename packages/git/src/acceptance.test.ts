import { FixedClock, FixedRandomSource } from "@iroha/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitLocation, resolveGitPath } from "./location.js";
import { getSanitizedRemoteUrl } from "./remote.js";
import { generateRepositoryId } from "./repository-id.js";
import { runGit } from "./run-git.js";
import { ensureRepositorySalt } from "./salt.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

/**
 * Exercises the WP-02 pieces together, the way `iroha init` will: resolve
 * the repository, derive its local iroha dir, mint a shared repository_id,
 * persist an HMAC salt there, and read back a credential-free remote URL.
 */
describe("WP-02 acceptance: git identity and local paths", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
    await runGit(["remote", "add", "origin", "https://ghp_secrettoken@github.com/org/repo.git"], {
      cwd: repoDir,
    });
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("resolves location, generates identity, stores salt, and sanitizes the remote", async () => {
    const location = await resolveGitLocation(repoDir);
    expect(location.ok).toBe(true);
    if (!location.ok) {
      return;
    }

    const irohaPath = await resolveGitPath(repoDir, "iroha");
    expect(irohaPath.ok).toBe(true);
    if (!irohaPath.ok) {
      return;
    }

    const repositoryId = generateRepositoryId(
      new FixedClock(new Date("2026-07-18T00:00:00.000Z")),
      new FixedRandomSource(new Uint8Array(16).fill(9)),
    );
    expect(repositoryId.startsWith("repo_")).toBe(true);

    const salt = await ensureRepositorySalt(
      irohaPath.value,
      new FixedRandomSource(new Uint8Array(32).fill(3)),
    );
    expect(salt.ok).toBe(true);
    if (!salt.ok) {
      return;
    }
    expect(salt.value.length).toBe(32);

    const remote = await getSanitizedRemoteUrl(repoDir, "origin");
    expect(remote).toEqual({ ok: true, value: "https://github.com/org/repo.git" });
    if (remote.ok && remote.value) {
      expect(remote.value.includes("ghp_secrettoken")).toBe(false);
    }
  });
});
