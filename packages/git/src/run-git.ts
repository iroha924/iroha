import { execFile } from "node:child_process";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { redactUrlLikeCredentials } from "./credential-redaction.js";

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
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
        timeout: options.timeoutMs ?? 10_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // A caller-supplied arg (e.g. a credentialed remote URL) must not
          // survive into the error message or details verbatim — both can
          // reach logs, `--json` CLI output, or doctor diagnostics.
          const redactedArgs = args.map(redactUrlLikeCredentials);
          resolve(
            err(
              new IrohaError("INTERNAL_ERROR", `git ${redactedArgs.join(" ")} failed`, {
                cause: error,
                details: { args: redactedArgs, stderr: stderr.trim() },
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
