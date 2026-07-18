import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { redactUrlLikeCredentialsInText } from "./credential-redaction.js";

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
}

// `git rev-parse --local-env-vars` (confirmed by manual reproduction): the
// authoritative list of environment variables that redirect Git away from
// cwd-based repository discovery. An inherited `GIT_DIR`, in particular,
// makes `--git-dir`/`--git-common-dir` silently resolve a completely
// different repository than `--show-toplevel` reports for the same `cwd` —
// corrupting `resolveGitLocation`'s result. `runGit` is the single place
// every other function in this package goes through, so clearing them here
// covers the whole package.
const LOCAL_GIT_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  // Not part of `--local-env-vars`, but has the same cwd-discovery-breaking
  // effect: confirmed by manual reproduction that an inherited
  // `GIT_CEILING_DIRECTORIES` naming the repo root makes `git rev-parse
  // --show-toplevel` fail with "not a git repository" when run from a
  // subdirectory, breaking the WP-02 subdirectory-launch acceptance path.
  // https://git-scm.com/docs/git#Documentation/git.txt-codeGITCEILINGDIRECTORIEScode
  "GIT_CEILING_DIRECTORIES",
  // Confirmed via Git's own documentation (`git help git`): Windows-only,
  // redirects Git's stdin/stdout/stderr handles to the named paths before
  // execFile's pipes can capture them — bypassing our redaction entirely
  // and breaking our own stdout-based parsing (e.g. `--show-toplevel`).
  // windows-2025 is in this package's Tier 1 CI matrix, so this is real.
  "GIT_REDIRECT_STDIN",
  "GIT_REDIRECT_STDOUT",
  "GIT_REDIRECT_STDERR",
];

// Confirmed by manual reproduction: `GIT_TRACE=/path git ...` appends the
// raw, unredacted command line (including any credentialed argument) to
// that file — entirely bypassing the redaction this module applies to
// stdout/stderr/args/cause. These must be cleared too, or an ambient trace
// variable in the parent environment silently defeats every other
// protection in this file.
const GIT_TRACE_ENV_VARS = [
  "GIT_TRACE",
  "GIT_TRACE_PACK_ACCESS",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_REFS",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_CURL",
  "GIT_TRACE_CURL_NO_DATA",
  "GIT_TRACE_FSMONITOR",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE2_CONFIG_PARAMS",
];

// `location.ts`/`remote.ts` pattern-match specific English stderr prefixes
// ("fatal: not a git repository", "No such remote") to distinguish known
// conditions from other failures. Git's UI strings are gettext-wrapped and
// translated under a non-English locale, which would make those matches
// silently stop working. `LANGUAGE` takes priority over `LC_ALL`/`LANG` for
// GNU gettext lookup, so it must be stripped too, not just overridden.
const ALWAYS_STRIPPED_ENV_VARS = [...LOCAL_GIT_ENV_VARS, ...GIT_TRACE_ENV_VARS, "LANGUAGE"];

/**
 * Case-insensitively removes every known-dangerous key from `source`.
 * Windows environment variable names are case-insensitive, but a plain
 * `delete env["GIT_DIR"]` only removes that exact spelling — confirmed via
 * Node.js docs that Windows resolves case-variant duplicates within a
 * single `env` object, which is a different guarantee from "the parent
 * process's lowercase `git_dir` gets removed". A denylist that isn't
 * case-insensitive can silently miss a variant the parent process exported.
 */
export function stripKnownDangerousEnvVars(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dangerous = new Set(ALWAYS_STRIPPED_ENV_VARS.map((key) => key.toLowerCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!dangerous.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = stripKnownDangerousEnvVars(process.env);
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

/**
 * `execFile`'s error carries the raw, unredacted command line in both
 * `.message` and `.cmd` (confirmed by manual reproduction). Rather than
 * redact that text (a denylist that keeps needing new patterns — see
 * `.claude/rules/secure-subprocess-and-credentials.md`), this builds a
 * synthetic `Error` from only non-sensitive fields: the process-level exit
 * code/signal. No argument text of any shape can reach `cause` this way.
 */
function buildDiagnosticCause(error: ExecFileException): Error {
  const parts: string[] = [];
  if (error.code !== undefined) {
    parts.push(`code=${error.code}`);
  }
  if (error.signal) {
    parts.push(`signal=${error.signal}`);
  }
  const sanitized = new Error(
    parts.length > 0 ? `git process failed (${parts.join(", ")})` : "git process failed",
  );
  sanitized.name = error.name;
  return sanitized;
}

/**
 * Runs `git` with an argument array (never a shell string), so caller input
 * can never be interpreted as shell syntax.
 */
export function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<Result<string, IrohaError>> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: buildCleanEnv(),
        timeout: options.timeoutMs ?? 10_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // No argument VALUE of any shape reaches message/details/cause —
          // redacting known-dangerous shapes (URLs, -c key=value, ...) is a
          // denylist that this package spent six review rounds discovering
          // gaps in. `args[0]` (the subcommand/flag, e.g. "checkout", "-c")
          // is never a value a caller would pass a secret as, so it's safe
          // to keep for diagnostics; still run it through the redactor as
          // defense in depth since it costs nothing. `stderr` still needs
          // redaction: it's Git's own output, required by location.ts and
          // remote.ts to distinguish known failure conditions, so it can't
          // simply be omitted the way our own args construction can.
          const firstArg = args[0];
          const subcommand =
            firstArg !== undefined ? redactUrlLikeCredentialsInText(firstArg) : "(no subcommand)";
          resolve(
            err(
              new IrohaError("INTERNAL_ERROR", `git ${subcommand} failed`, {
                cause: buildDiagnosticCause(error),
                details: {
                  subcommand,
                  argCount: args.length,
                  exitCode: error.code ?? null,
                  signal: error.signal ?? null,
                  stderr: redactUrlLikeCredentialsInText(stderr.trim()),
                },
              }),
            ),
          );
          return;
        }
        resolve(ok(stdout.replace(/\r?\n$/, "")));
      },
    );
  });
}
