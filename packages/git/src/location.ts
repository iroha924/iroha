import { isAbsolute, resolve } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { safeRealpath } from "./paths.js";
import { runGit } from "./run-git.js";

export interface GitLocation {
  /** Working tree root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Git dir shared across all worktrees (`git rev-parse --git-common-dir`). */
  commonDir: string;
  /** This worktree's own git dir (`git rev-parse --git-dir`). */
  gitDir: string;
}

/**
 * `git rev-parse` prints paths relative to `cwd` for the common (non-worktree)
 * case, but absolute paths once a linked worktree is involved. Resolving
 * against `cwd` handles both without guessing which case applies. The result
 * is then symlink-resolved so it agrees with `--show-toplevel`, which Git
 * itself always returns as a real path (e.g. macOS `/var` -> `/private/var`).
 */
async function resolveGitRevParsePath(
  cwd: string,
  args: readonly string[],
): Promise<Result<string, IrohaError>> {
  const result = await runGit(args, { cwd });
  if (!result.ok) {
    return err(
      new IrohaError("REPOSITORY_NOT_FOUND", `Not a Git repository (or any parent): ${cwd}`, {
        cause: result.error,
        details: { cwd },
      }),
    );
  }
  const absolute = isAbsolute(result.value) ? result.value : resolve(cwd, result.value);
  return ok(await safeRealpath(absolute));
}

export async function resolveGitLocation(cwd: string): Promise<Result<GitLocation, IrohaError>> {
  const root = await resolveGitRevParsePath(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return root;
  }

  const commonDir = await resolveGitRevParsePath(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok) {
    return commonDir;
  }

  const gitDir = await resolveGitRevParsePath(cwd, ["rev-parse", "--git-dir"]);
  if (!gitDir.ok) {
    return gitDir;
  }

  return ok({ root: root.value, commonDir: commonDir.value, gitDir: gitDir.value });
}

/** Resolves a namespaced path inside the git dir, e.g. `resolveGitPath(cwd, "iroha")`. */
export function resolveGitPath(cwd: string, name: string): Promise<Result<string, IrohaError>> {
  return resolveGitRevParsePath(cwd, ["rev-parse", "--git-path", name]);
}
