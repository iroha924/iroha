import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./run-git.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

describe("runGit", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await removeTempDir(repoDir);
  });

  it("returns trimmed stdout for a successful command", async () => {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repoDir });

    expect(result).toEqual({ ok: true, value: "true" });
  });

  it("passes arguments as an array, never through a shell", async () => {
    const injectionAttempt = "; touch should-not-exist";
    const result = await runGit(["log", "-1", `--format=${injectionAttempt}`], {
      cwd: repoDir,
    });

    // The empty repo has no commits, so this fails on "unknown revision" —
    // proof the string was treated as a single literal argument, not shell syntax.
    expect(result.ok).toBe(false);
  });

  it("returns an IrohaError for a failing command", async () => {
    const result = await runGit(["not-a-real-subcommand"], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("redacts a credentialed argument from a failing command's error message and details", async () => {
    const credentialedUrl = "https://ghp_secrettoken@example.invalid/org/repo.git";
    // An unknown subcommand fails before Git ever touches the network, so
    // this stays fast and offline — only our own error formatting is under
    // test here, not Git's own (already-redacting) stderr.
    const result = await runGit(["not-a-real-subcommand", credentialedUrl], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.includes("ghp_secrettoken")).toBe(false);
      expect(JSON.stringify(result.error.details).includes("ghp_secrettoken")).toBe(false);
      expect(result.error.details?.args).toEqual([
        "not-a-real-subcommand",
        "https://example.invalid/org/repo.git",
      ]);
    }
  });

  it("does not leak a credentialed argument through error.cause", async () => {
    const credentialedUrl = "https://ghp_secrettoken@example.invalid/org/repo.git";
    const result = await runGit(["not-a-real-subcommand", credentialedUrl], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cause = result.error.cause;
      const causeText = cause instanceof Error ? `${cause.message} ${JSON.stringify(cause)}` : "";
      expect(causeText.includes("ghp_secrettoken")).toBe(false);
    }
  });

  it("redacts a credentialed URL Git echoes back verbatim in stderr", async () => {
    const credentialedUrl = "https://ghp_secrettoken@example.invalid/org/repo.git";
    // Git treats an unmatched pathspec-looking argument to `checkout` as a
    // literal string and echoes it back in stderr verbatim — confirmed by
    // manual reproduction; unlike the "unable to access" network-failure
    // case, Git does not redact credentials here itself.
    const result = await runGit(["checkout", credentialedUrl], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.error.details as { stderr?: string } | undefined;
      expect(details?.stderr?.includes("ghp_secrettoken")).toBe(false);
    }
  });

  it("ignores an inherited GIT_DIR pointing at a different repository", async () => {
    const otherRepoDir = await createTempGitRepo();
    const previousGitDir = process.env.GIT_DIR;
    try {
      // Confirmed by manual reproduction: with GIT_DIR exported to another
      // repo's .git, `git rev-parse --git-dir` silently reports that other
      // repo instead of the one under `cwd` — corrupting cwd-based identity
      // resolution unless runGit clears it before invoking Git.
      process.env.GIT_DIR = join(otherRepoDir, ".git");

      const result = await runGit(["rev-parse", "--git-dir"], { cwd: repoDir });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBe(join(otherRepoDir, ".git"));
      }
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      await removeTempDir(otherRepoDir);
    }
  });

  it("does not leak a credentialed argument via an inherited GIT_TRACE", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "iroha-git-trace-test-"));
    const traceFile = join(traceDir, "trace.log");
    const previousTrace = process.env.GIT_TRACE;
    try {
      // Confirmed by manual reproduction: GIT_TRACE=<file> makes Git append
      // the raw command line, credentials included, to that file — entirely
      // outside our own stdout/stderr/args/cause redaction.
      process.env.GIT_TRACE = traceFile;
      const credentialedUrl = "https://ghp_secrettoken@example.invalid/org/repo.git";

      await runGit(["not-a-real-subcommand", credentialedUrl], { cwd: repoDir });

      const traceContent = await readFile(traceFile, "utf8").catch(() => "");
      expect(traceContent.includes("ghp_secrettoken")).toBe(false);
    } finally {
      if (previousTrace === undefined) {
        delete process.env.GIT_TRACE;
      } else {
        process.env.GIT_TRACE = previousTrace;
      }
      await removeTempDir(traceDir);
    }
  });

  it("ignores an inherited GIT_CEILING_DIRECTORIES that would block subdirectory discovery", async () => {
    const subdir = join(repoDir, "nested");
    await mkdir(subdir);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    try {
      // Confirmed by manual reproduction: GIT_CEILING_DIRECTORIES naming the
      // repo root makes `git rev-parse --show-toplevel` fail with "not a
      // git repository" when run from a subdirectory of that same repo.
      process.env.GIT_CEILING_DIRECTORIES = repoDir;

      const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: subdir });

      expect(result.ok).toBe(true);
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });
});
