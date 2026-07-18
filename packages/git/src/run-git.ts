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
];

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of LOCAL_GIT_ENV_VARS) {
    delete env[key];
  }
  return env;
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
                cause: error,
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
