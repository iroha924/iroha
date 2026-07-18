import { execFile } from "node:child_process";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import {
  redactUrlLikeCredentials,
  redactUrlLikeCredentialsInText,
} from "./credential-redaction.js";

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

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [...LOCAL_GIT_ENV_VARS, ...GIT_TRACE_ENV_VARS]) {
    delete env[key];
  }
  return env;
}

/**
 * `execFile`'s error carries the raw, unredacted command line in both
 * `.message` and `.cmd` (confirmed by manual reproduction) — attaching it
 * as `cause` would leak credentials through any caller that logs or
 * serializes the error's cause chain, even though `message`/`details` on
 * the `IrohaError` itself are redacted. A synthetic `Error` with only a
 * redacted message preserves the general failure shape without the leak.
 */
function sanitizeExecError(error: Error): Error {
  const sanitized = new Error(redactUrlLikeCredentialsInText(error.message));
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
          // A caller-supplied arg (e.g. a credentialed remote URL) must not
          // survive into the error message or details verbatim — both can
          // reach logs, `--json` CLI output, or doctor diagnostics. Git
          // itself redacts credentials from *its own* "unable to access"
          // network errors, but echoes an unmatched pathspec argument back
          // verbatim (confirmed by reproduction), so stderr needs the same
          // treatment as args.
          const redactedArgs = args.map(redactUrlLikeCredentials);
          resolve(
            err(
              new IrohaError("INTERNAL_ERROR", `git ${redactedArgs.join(" ")} failed`, {
                cause: sanitizeExecError(error),
                details: {
                  args: redactedArgs,
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
