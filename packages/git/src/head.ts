import type { Result } from "@iroha/domain";
import { err, IrohaError, ok } from "@iroha/domain";
import { runGit } from "./run-git.js";

export interface HeadState {
  /** Current branch name, or `null` when HEAD is detached. */
  branch: string | null;
  /** Full HEAD commit SHA. */
  sha: string;
}

/**
 * Well under every hooks-contract.md §7 hook budget (SessionEnd's is the
 * tightest at 1.5s). The callers annotate a record with HEAD and degrade to
 * recording nothing, so a `rev-parse` slow enough to matter — a stale network
 * mount, a cold huge `.git` — must lose to the budget rather than spend it:
 * `runGit`'s own 10s default is longer than the hook is allowed to live, which
 * would turn "fail-open" into "hook killed".
 */
const HEAD_READ_TIMEOUT_MS = 1_000;

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Branch and commit HEAD currently points at, for recording the code state a
 * Session Run acted on (`session_runs.git_branch`/`head_sha_*`).
 *
 * One `rev-parse` resolves both: with the symbolic flag placed after the first
 * revision, Git prints the SHA on line 1 and HEAD's symbolic name on line 2
 * (confirmed by reproduction). `--symbolic-full-name` rather than
 * `--abbrev-ref`, because abbreviation is ambiguity-sensitive: with a tag and a
 * branch of the same name, `--abbrev-ref HEAD` disambiguates to `heads/main`
 * instead of `main` (reproduced), which would be recorded as the branch name.
 * The full name has no such collision, so anything that is not a
 * `refs/heads/...` — a detached HEAD prints the literal `HEAD` — is reported as
 * `branch: null` rather than guessed at.
 *
 * An unborn HEAD (a repository with no commits yet) fails the whole command
 * with exit 128 and is returned as an error, since there is no SHA to record;
 * callers that only want to annotate a record with HEAD treat that the same as
 * any other Git failure and store nothing.
 */
export async function readHeadState(cwd: string): Promise<Result<HeadState, IrohaError>> {
  const result = await runGit(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"], {
    cwd,
    timeoutMs: HEAD_READ_TIMEOUT_MS,
  });
  if (!result.ok) {
    return result;
  }
  // `runGit` strips only the trailing newline, so split tolerates a CRLF
  // separator the same way it does. A success that is not two lines is
  // rejected rather than defaulted: an empty string would be persisted as an
  // empty `head_sha_start`, which is worse than recording nothing.
  const [sha, symbolic] = result.value.split(/\r?\n/);
  if (!sha || !symbolic) {
    return err(new IrohaError("INTERNAL_ERROR", "git rev-parse did not report HEAD and its name"));
  }
  return ok({
    branch: symbolic.startsWith(BRANCH_REF_PREFIX)
      ? symbolic.slice(BRANCH_REF_PREFIX.length)
      : null,
    sha,
  });
}
