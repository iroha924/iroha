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
 * A fifth of the hooks-contract.md §7 budget of the tightest event that calls
 * this today — SessionEnd, 1.5s (SessionStart is 3.0s). It is **not** below
 * every §7 budget: PreToolUse's is 0.5s, so a caller on one of the tighter
 * paths must not assume this cap fits its own.
 *
 * Sized this way because the value is an annotation and the callers degrade to
 * recording nothing, while the write it precedes is mandatory: `runGit`'s own
 * 10s default is longer than any hook is allowed to live, so a `rev-parse` slow
 * enough to matter — a stale network mount, a cold huge `.git` — would spend the
 * whole budget and take the Run/Turn close down with it. A normal `rev-parse`
 * is single-digit milliseconds, so this only ever bites the pathological case
 * it exists for.
 */
const HEAD_READ_TIMEOUT_MS = 300;

const BRANCH_REF_PREFIX = "refs/heads/";

/** SHA-1 (40) or SHA-256 (64) object id — Git's two object formats. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  // separator the same way it does. The two values are identified by position,
  // so the sha is checked against the object-id format rather than trusted:
  // that is what turns a wrong assumption about the output shape into a
  // recorded `NULL` instead of a branch name persisted as `head_sha_start`.
  const [sha, symbolic] = result.value.split(/\r?\n/);
  if (!sha || !symbolic || !OBJECT_ID.test(sha)) {
    return err(new IrohaError("INTERNAL_ERROR", "git rev-parse did not report HEAD and its name"));
  }
  return ok({
    branch: symbolic.startsWith(BRANCH_REF_PREFIX)
      ? symbolic.slice(BRANCH_REF_PREFIX.length)
      : null,
    sha,
  });
}
