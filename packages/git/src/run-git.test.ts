import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, stripKnownDangerousEnvVars } from "./run-git.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

describe("stripKnownDangerousEnvVars", () => {
  it("removes a known-dangerous key regardless of case", () => {
    // Windows env var names are case-insensitive; git.exe would honor a
    // lowercase `git_dir` exported by the parent process exactly like
    // `GIT_DIR`. A denylist that only deletes the canonical-case spelling
    // would miss it.
    const result = stripKnownDangerousEnvVars({
      git_dir: "/some/other/repo/.git",
      GIT_DIR: "/another/repo/.git",
      Git_Trace: "/tmp/trace.log",
      gIt_cEiLiNg_DiReCtOrIeS: "/some/repo",
      GIT_CONFIG_GLOBAL: "/some/other/gitconfig",
      git_config_system: "/etc/other/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      language: "ja_JP.UTF-8",
      PATH: "/usr/bin",
    });

    expect(result).toEqual({ PATH: "/usr/bin" });
  });
});

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

  it("never includes argument values in a failing command's error message or details", async () => {
    const credentialedUrl = "https://ghp_secrettoken@example.invalid/org/repo.git";
    // An unknown subcommand fails before Git ever touches the network, so
    // this stays fast and offline — only our own error formatting is under
    // test here, not Git's own (already-redacting) stderr.
    const result = await runGit(["not-a-real-subcommand", credentialedUrl], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.includes("ghp_secrettoken")).toBe(false);
      expect(JSON.stringify(result.error.details).includes("ghp_secrettoken")).toBe(false);
      // Only the subcommand and a count survive — never the credentialed arg.
      expect(result.error.details).toMatchObject({
        subcommand: "not-a-real-subcommand",
        argCount: 2,
      });
    }
  });

  it("never includes a -c key=value argument's value, not just whole-string URLs", async () => {
    // A `-c key=value`-shaped argument (Git's config-override form) can
    // embed a credentialed URL anywhere after the `=`; regex-based
    // redaction anchored to the start of the string would miss it, but
    // since no argument VALUE is included at all here, this is moot by
    // construction.
    const configArg =
      "http.extraHeader=Authorization: Bearer https://ghp_secrettoken@example.invalid/";
    const result = await runGit(["not-a-real-subcommand", "-c", configArg], { cwd: repoDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.includes("ghp_secrettoken")).toBe(false);
      expect(JSON.stringify(result.error.details).includes("ghp_secrettoken")).toBe(false);
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

  it("redacts an absolute path Git itself embeds in stderr, not just credentialed URLs", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "iroha-git-badconfig-test-"));
    const badConfigFile = join(configDir, "gitconfig");
    try {
      // Confirmed by manual reproduction: pointing Git at a malformed config
      // file makes it print that file's absolute path in stderr (e.g. "fatal:
      // bad config line 1 in file /tmp/xxx/gitconfig") — a path Git generated
      // itself, with no credential-URL shape for redactUrlLikeCredentialsInText
      // alone to catch. The file is supplied via `--file` (an argument runGit
      // drops from the error entirely, so it can only reach the error through
      // stderr) rather than GIT_CONFIG_GLOBAL, because runGit now strips that
      // env var before Git runs — an inherited GIT_CONFIG_GLOBAL can no longer
      // trigger this (see the "ignores an inherited GIT_CONFIG_GLOBAL" test).
      await writeFile(badConfigFile, "[bad\n", "utf8");

      const result = await runGit(["config", "--file", badConfigFile, "--list"], { cwd: repoDir });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const details = result.error.details as { stderr?: string } | undefined;
        expect(details?.stderr?.includes(badConfigFile)).toBe(false);
        expect(details?.stderr?.includes(configDir)).toBe(false);
      }
    } finally {
      await removeTempDir(configDir);
    }
  });

  it("ignores an inherited GIT_CONFIG_GLOBAL pointing at a malformed config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "iroha-git-globalconfig-test-"));
    const badConfigFile = join(configDir, "gitconfig");
    const previousConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
      // Confirmed by manual reproduction: with GIT_CONFIG_GLOBAL exported to a
      // malformed file, `git rev-parse --show-toplevel` reads it and fails
      // ("fatal: bad config line 1 ..."), whereas with it cleared the same
      // command succeeds. An ambient GIT_CONFIG_GLOBAL in the parent process
      // would therefore let a config chosen by something other than the user
      // redirect Git's behavior; runGit must strip it. This goes red on the
      // pre-strip code (rev-parse fails instead of succeeding).
      await writeFile(badConfigFile, "[bad\n", "utf8");
      process.env.GIT_CONFIG_GLOBAL = badConfigFile;

      const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: repoDir });

      expect(result.ok).toBe(true);
    } finally {
      if (previousConfigGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousConfigGlobal;
      }
      await removeTempDir(configDir);
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

  it("ignores inherited GIT_REDIRECT_STDOUT/STDERR", async () => {
    // Per Git's own docs (`git help git`), GIT_REDIRECT_STDIN/STDOUT/STDERR
    // are Windows-only: on other platforms this assertion holds regardless
    // of whether runGit clears them, but on the windows-2025 CI leg an
    // uncleared GIT_REDIRECT_STDOUT would redirect Git's real stdout away
    // from the pipe execFile reads, making this fail for real.
    const redirectDir = await mkdtemp(join(tmpdir(), "iroha-git-redirect-test-"));
    const redirectFile = join(redirectDir, "stdout.log");
    const previousStdout = process.env.GIT_REDIRECT_STDOUT;
    const previousStderr = process.env.GIT_REDIRECT_STDERR;
    try {
      process.env.GIT_REDIRECT_STDOUT = redirectFile;
      process.env.GIT_REDIRECT_STDERR = redirectFile;

      const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repoDir });

      expect(result).toEqual({ ok: true, value: "true" });
    } finally {
      if (previousStdout === undefined) {
        delete process.env.GIT_REDIRECT_STDOUT;
      } else {
        process.env.GIT_REDIRECT_STDOUT = previousStdout;
      }
      if (previousStderr === undefined) {
        delete process.env.GIT_REDIRECT_STDERR;
      } else {
        process.env.GIT_REDIRECT_STDERR = previousStderr;
      }
      await removeTempDir(redirectDir);
    }
  });

  it("forces a C locale regardless of the parent process's LANG/LC_ALL/LANGUAGE", async () => {
    // location.ts/remote.ts pattern-match specific English stderr text
    // ("fatal: not a git repository", "No such remote"), which breaks under
    // a translated Git build. This machine's Git has no gettext/NLS support
    // (confirmed via `git --version --build-options`), so this can't
    // reproduce an actual translated message locally — it only proves the
    // locale variables set here don't leak through from the parent process.
    const previousLang = process.env.LANG;
    const previousLcAll = process.env.LC_ALL;
    const previousLanguage = process.env.LANGUAGE;
    try {
      process.env.LANG = "ja_JP.UTF-8";
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.LANGUAGE = "ja_JP.UTF-8";

      const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repoDir });

      expect(result).toEqual({ ok: true, value: "true" });
    } finally {
      for (const [key, previous] of [
        ["LANG", previousLang],
        ["LC_ALL", previousLcAll],
        ["LANGUAGE", previousLanguage],
      ] as const) {
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    }
  });
});
