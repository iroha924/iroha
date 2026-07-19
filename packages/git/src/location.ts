import { isAbsolute, resolve, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { safeRealpath } from "./paths.js";
import { runGit } from "./run-git.js";

// Confirmed by manual reproduction: `git rev-parse` prints exactly this
// message (across --show-toplevel/--git-common-dir/--git-dir/--git-path)
// when cwd is outside any repository. Only this specific condition should
// become REPOSITORY_NOT_FOUND — any other runGit failure (Git missing,
// timeout, permission denied, ...) must propagate as-is so doctor/init can
// tell an environment problem apart from "not initialized here".
const NOT_A_REPOSITORY = /^fatal: not a git repository/;

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
    const stderr = (result.error.details as { stderr?: string } | undefined)?.stderr;
    if (stderr !== undefined && NOT_A_REPOSITORY.test(stderr)) {
      // No `cwd`/resolved-path values in message or details: mcp-contract.md
      // §8 forbids returning filesystem absolute paths to the model, and
      // this error can reach an MCP response as-is.
      return err(
        new IrohaError("REPOSITORY_NOT_FOUND", "Not a Git repository (or any parent)", {
          cause: result.error,
        }),
      );
    }
    return err(result.error);
  }
  const absolute = isAbsolute(result.value) ? result.value : resolve(cwd, result.value);
  try {
    return ok(await safeRealpath(absolute));
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to resolve Git path", { cause }));
  }
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

/**
 * Resolves a namespaced path inside the git dir, e.g. `resolveGitPath(cwd, "iroha")`.
 *
 * `git rev-parse --git-path <name>` only constructs the syntactic path (e.g.
 * `.git/iroha`) — it does not check whether any component is a symlink.
 * Confirmed by reproduction: replacing `.git/iroha` with a symlink to an
 * external directory makes `--git-path iroha` still print `.git/iroha`
 * unchanged, and resolving that via `safeRealpath` (as
 * `resolveGitRevParsePath` does) follows the symlink to the external
 * target with no error — so callers like `ensureRepositorySalt` would read
 * and write `local-config.json` entirely outside Git state. design.md §6
 * requires "symlink escape" to be a covered contract-test case for this
 * exact resolution, so the result is rejected unless it stays inside the
 * resolved Git common dir — which covers both the main worktree (where
 * `--git-dir` equals `--git-common-dir`) and a linked worktree (where
 * `--git-dir` nests under `<common-dir>/worktrees/<id>`).
 */
export async function resolveGitPath(
  cwd: string,
  name: string,
): Promise<Result<string, IrohaError>> {
  const path = await resolveGitRevParsePath(cwd, ["rev-parse", "--git-path", name]);
  if (!path.ok) {
    return path;
  }
  const commonDir = await resolveGitRevParsePath(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok) {
    return commonDir;
  }
  if (path.value !== commonDir.value && !path.value.startsWith(`${commonDir.value}${sep}`)) {
    return err(new IrohaError("INVALID_INPUT", "Resolved Git path escapes Git state"));
  }
  return path;
}
