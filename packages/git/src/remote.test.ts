import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSanitizedRemoteUrl, sanitizeRemoteUrl } from "./remote.js";
import { runGit } from "./run-git.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

describe("sanitizeRemoteUrl", () => {
  it("strips a token used as the https username", () => {
    expect(sanitizeRemoteUrl("https://ghp_abc123token@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("strips a user:password pair from an https URL", () => {
    expect(sanitizeRemoteUrl("https://alice:hunter2@example.com/org/repo.git")).toBe(
      "https://example.com/org/repo.git",
    );
  });

  it("leaves a credential-free https URL unchanged", () => {
    expect(sanitizeRemoteUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("leaves an SCP-like SSH remote unchanged", () => {
    expect(sanitizeRemoteUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });

  it("strips userinfo from an ssh:// scheme URL", () => {
    expect(sanitizeRemoteUrl("ssh://git@github.com/org/repo.git")).toBe(
      "ssh://github.com/org/repo.git",
    );
  });

  it("leaves a Windows drive-letter local path unchanged (backslash form)", () => {
    expect(sanitizeRemoteUrl("C:\\Users\\dev\\repo.git")).toBe("C:\\Users\\dev\\repo.git");
  });

  it("leaves a Windows drive-letter local path unchanged (forward-slash form)", () => {
    expect(sanitizeRemoteUrl("C:/Users/dev/repo.git")).toBe("C:/Users/dev/repo.git");
  });

  it("leaves a bare Unix local path unchanged", () => {
    expect(sanitizeRemoteUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("strips a credential-bearing query string", () => {
    expect(sanitizeRemoteUrl("https://github.com/org/repo.git?access_token=SECRET")).toBe(
      "https://github.com/org/repo.git",
    );
  });
});

describe("getSanitizedRemoteUrl", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("returns null when no remote is configured", async () => {
    const result = await getSanitizedRemoteUrl(repoDir);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("returns the sanitized URL for a configured remote", async () => {
    await runGit(["remote", "add", "origin", "https://token123@github.com/org/repo.git"], {
      cwd: repoDir,
    });

    const result = await getSanitizedRemoteUrl(repoDir, "origin");

    expect(result).toEqual({ ok: true, value: "https://github.com/org/repo.git" });
  });

  it("strips a query-string token from a configured remote", async () => {
    await runGit(
      ["remote", "add", "origin", "https://github.com/org/repo.git?access_token=SECRET"],
      { cwd: repoDir },
    );

    const result = await getSanitizedRemoteUrl(repoDir, "origin");

    expect(result).toEqual({ ok: true, value: "https://github.com/org/repo.git" });
  });

  it("propagates a REPOSITORY_NOT_FOUND-style error instead of returning null when cwd is not a repository", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "iroha-remote-outside-test-"));
    try {
      const result = await getSanitizedRemoteUrl(outsideDir, "origin");

      expect(result.ok).toBe(false);
    } finally {
      await removeTempDir(outsideDir);
    }
  });
});
