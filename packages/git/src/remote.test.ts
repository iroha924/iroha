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

  it("suppresses a Windows drive-letter local path instead of exposing it (backslash form)", () => {
    // mcp-contract.md §8: absolute filesystem paths never reach the model
    // or persistence; unlike a credential-bearing scheme:// URL, there is
    // no sub-slot to redact here — the whole value is the sensitive part.
    expect(sanitizeRemoteUrl("C:\\Users\\dev\\repo.git")).toBe(null);
  });

  it("suppresses a Windows drive-letter local path instead of exposing it (forward-slash form)", () => {
    expect(sanitizeRemoteUrl("C:/Users/dev/repo.git")).toBe(null);
  });

  it("suppresses a bare Unix absolute local path instead of exposing it", () => {
    expect(sanitizeRemoteUrl("/srv/git/repo.git")).toBe(null);
  });

  it("suppresses a file:// remote instead of exposing its filesystem path", () => {
    expect(sanitizeRemoteUrl("file:///srv/git/repo.git")).toBe(null);
  });

  it("suppresses a single-slash file: remote instead of exposing its filesystem path", () => {
    // Confirmed by reproduction: Git accepts and stores "file:/path" (one
    // slash) as a remote URL identically to "file://"/"file:///".
    expect(sanitizeRemoteUrl("file:/Users/alice/private.git")).toBe(null);
  });

  it("leaves a relative file: remote unchanged, unlike an absolute one", () => {
    // No leading slash after "file:" means no absolute filesystem path is
    // being exposed — consistent with this module's existing scope of only
    // suppressing absolute local paths (relative bare paths are left alone
    // too; see "leaves an SCP-like SSH remote unchanged" etc. above).
    expect(sanitizeRemoteUrl("file:relative/path.git")).toBe("file:relative/path.git");
  });

  it("suppresses a UNC path instead of exposing it", () => {
    expect(sanitizeRemoteUrl("\\\\fileserver\\share\\repo.git")).toBe(null);
  });

  it("suppresses the whole value when a local path appears on a later line", () => {
    const multiline = "https://github.com/org/repo.git\nfile:///Users/alice/private.git";

    expect(sanitizeRemoteUrl(multiline)).toBe(null);
  });

  it("suppresses a local path that follows other content on the same line", () => {
    // Git stores this verbatim as a single config value (confirmed by
    // reproduction): a naive line-start-only check would miss the local
    // path entirely since the line starts with a safe-looking https:// URL.
    const spaceJoined = "https://github.com/org/repo.git /Users/alice/private.git";

    expect(sanitizeRemoteUrl(spaceJoined)).toBe(null);
  });

  it("suppresses a file: URL joined to other content by a comma with no whitespace", () => {
    // Confirmed by reproduction: Git stores this verbatim as one value. A
    // whitespace-only token split (an earlier version of this check) never
    // sees a boundary here at all, since there is no whitespace anywhere in
    // the string.
    const commaJoined = "https://github.com/org/repo.git,file:///Users/alice/private.git";

    expect(sanitizeRemoteUrl(commaJoined)).toBe(null);
  });

  it("suppresses a file: URL joined to other content by a semicolon with no whitespace", () => {
    const semicolonJoined = "https://github.com/org/repo.git;file:///Users/alice/private.git";

    expect(sanitizeRemoteUrl(semicolonJoined)).toBe(null);
  });

  it("strips a credential-bearing query string", () => {
    expect(sanitizeRemoteUrl("https://github.com/org/repo.git?access_token=SECRET")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("redacts every embedded URL in a multiline value", () => {
    // Git accepts (and `remote get-url` prints back) a value containing an
    // embedded newline; a naive single-URL-shaped regex only strips the
    // first URL's credentials and leaves a second one after the newline.
    const multiline = "https://user1@one.example/repo.git\nhttps://user2@two.example/other.git";

    expect(sanitizeRemoteUrl(multiline)).toBe(
      "https://one.example/repo.git\nhttps://two.example/other.git",
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

  it("returns null for a configured local absolute path remote instead of exposing it", async () => {
    const otherRepoDir = await createTempGitRepo();
    try {
      await runGit(["remote", "add", "origin", otherRepoDir], { cwd: repoDir });

      const result = await getSanitizedRemoteUrl(repoDir, "origin");

      expect(result).toEqual({ ok: true, value: null });
    } finally {
      await removeTempDir(otherRepoDir);
    }
  });

  it("uses the first configured URL, not the last, when a remote has multiple", async () => {
    await runGit(["remote", "add", "origin", "https://first.example/repo.git"], {
      cwd: repoDir,
    });
    // Git supports configuring more than one URL per remote (push fans out
    // to all of them, but fetch always uses only the first). Confirmed by
    // reproduction that `git config --get` (a single value) returns the
    // *last* configured one in that case, while Git itself uses the first —
    // this must match Git's actual fetch behavior, not `--get`'s pick.
    await runGit(["remote", "set-url", "--add", "origin", "https://second.example/repo.git"], {
      cwd: repoDir,
    });

    const result = await getSanitizedRemoteUrl(repoDir, "origin");

    expect(result).toEqual({ ok: true, value: "https://first.example/repo.git" });
  });

  it("reads the configured remote URL, not a locally rewritten insteadOf mirror", async () => {
    await runGit(["remote", "add", "origin", "https://github.com/org/repo.git"], {
      cwd: repoDir,
    });
    // A per-machine rewrite (e.g. a corporate mirror or SSH-over-HTTPS
    // preference) must not leak into `remote_url_normalized`: two teammates
    // with different local rewrites would otherwise compute a different
    // value for the identical repository. `git remote get-url` applies this
    // rewrite; `git config --get remote.<name>.url` (what this package uses)
    // must not.
    await runGit(
      ["config", "--local", "url.https://mirror.internal/.insteadOf", "https://github.com/"],
      { cwd: repoDir },
    );

    const result = await getSanitizedRemoteUrl(repoDir, "origin");

    expect(result).toEqual({ ok: true, value: "https://github.com/org/repo.git" });
  });
});
