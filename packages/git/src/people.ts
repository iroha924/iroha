import type { IrohaError, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { runGit } from "./run-git.js";

export interface RepositoryPeople {
  /** Names an approval may be credited to, sorted deterministically. */
  names: string[];
  /** The local Git identity, or `null` when it is unset or unusable as a reviewer. */
  self: string | null;
}

/**
 * How far back author names are collected. The whole history would be
 * unbounded output through `runGit`'s 10 MiB buffer, and the people who can
 * plausibly review today are the recent ones; anyone the scan misses can still
 * be typed in, since the reviewer field stays free text.
 */
const AUTHOR_SCAN_COMMITS = 2000;

/**
 * GitHub names every App account this way (`dependabot[bot]`,
 * `renovate[bot]`). Deliberately only this suffix: an open-ended list of bot
 * spellings never converges, and the field accepts a typed name anyway, so a
 * bot that slips through costs a reader one wrong-looking row rather than a
 * defect. `docs/contracts/dashboard-api.md` states the same narrow rule.
 */
const FORGE_APP_NAME = /\[bot\]$/;

/**
 * `approveRequestSchema.actor.displayName` in `@iroha/api` bounds the reviewer
 * name at 120 characters. Git author names are unbounded, so offering a longer
 * one would let the picker produce a value its own approve call then rejects
 * with a 400 the UI cannot explain.
 */
const MAX_REVIEWER_NAME_LENGTH = 120;

/** C0/C1 controls. A real author name has none; an escape sequence garbles every reader of the canonical file. */
const CONTROL_CHARACTER = /\p{Cc}/u;

function exitCodeOf(error: IrohaError): number | null | undefined {
  return (error.details as { exitCode?: number | null } | undefined)?.exitCode;
}

/** Whether a name can actually be committed as `approved_by.display_name`. */
function isSelectableReviewer(name: string): boolean {
  return (
    name !== "" &&
    name.length <= MAX_REVIEWER_NAME_LENGTH &&
    !CONTROL_CHARACTER.test(name) &&
    !FORGE_APP_NAME.test(name)
  );
}

/**
 * The people this repository can attribute an approval to, for the Review
 * detail page's reviewer field (contracts/dashboard-api.md §5).
 *
 * Author names come from Git rather than the `actors` table because that
 * table's only writer is the Forge sync, so it is empty on a repository that
 * never synced a GitHub forge, and it carries no `repository_id` to scope a
 * read by. Git history needs no network and is present wherever `.iroha/` is.
 *
 * `--no-show-signature` is load-bearing, not tidiness: under
 * `log.showSignature = true` Git writes signature-verification text to the
 * same **stdout** as the formatted output, so lines like
 * `~/.ssh/allowed_signers:1: invalid key` would be read as people and served
 * over HTTP. `runGit` redacts absolute paths only on its failure path, and
 * this is the first caller to hand raw success stdout to an API response.
 *
 * `--all` rather than the HEAD-only default: someone who has only committed on
 * a feature branch is still a person who can review. It also makes an unborn
 * HEAD exit 0 with no output instead of 128, so there is no "no commits yet"
 * failure to special-case.
 */
export async function readRepositoryPeople(
  cwd: string,
): Promise<Result<RepositoryPeople, IrohaError>> {
  const [authors, configured] = await Promise.all([
    runGit(
      ["log", "--all", "--no-show-signature", `--max-count=${AUTHOR_SCAN_COMMITS}`, "--format=%aN"],
      { cwd },
    ),
    runGit(["config", "--get", "user.name"], { cwd }),
  ]);

  if (!authors.ok) {
    return err(authors.error);
  }
  // Exit 1 is `git config`'s "this key is unset", the one expected non-answer.
  // Every other failure — no git binary, dubious ownership, a timeout — is
  // reported rather than folded into an empty list, which would be
  // indistinguishable from a repository that simply has no people.
  if (!configured.ok && exitCodeOf(configured.error) !== 1) {
    return err(configured.error);
  }

  const configuredName = configured.ok ? configured.value.trim() : "";
  const self = isSelectableReviewer(configuredName) ? configuredName : null;

  const names = new Set<string>();
  for (const line of authors.value.split(/\r?\n/)) {
    const name = line.trim();
    if (isSelectableReviewer(name)) {
      names.add(name);
    }
  }
  // Added after the loop but through the same predicate: a `ci-runner[bot]`
  // identity must not reach the list by way of being the local one.
  if (self !== null) {
    names.add(self);
  }

  // Code-point order, not `localeCompare`: this package pins `LC_ALL=C` so Git
  // reads the same everywhere, and a list whose order depends on the server's
  // ICU build would undo that for no gain.
  return ok({
    names: Array.from(names).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    self,
  });
}
