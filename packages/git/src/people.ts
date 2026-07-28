import { runGit } from "./run-git.js";

export interface RepositoryPeople {
  /** Distinct commit author names, alphabetical, bots excluded. */
  names: string[];
  /** `git config user.name`, or `null` when it is not configured. */
  self: string | null;
}

/**
 * How far back author names are collected. The whole history would be
 * unbounded output through `runGit`'s 10 MiB buffer, and the people who can
 * plausibly review today are the recent ones; a repository whose last two
 * thousand commits do not include someone can still have them typed in by
 * hand, since the reviewer field stays free text.
 */
const AUTHOR_SCAN_COMMITS = 2000;

/**
 * Forge account names Git records as an author but no human answers for.
 * Left in, they outnumber the real reviewers in any repository with an
 * automated dependency updater.
 */
const BOT_NAME = /\[bot\]$/;

/**
 * The people this repository can attribute an approval to, for the Review
 * detail page's reviewer field (contracts/dashboard-api.md §5).
 *
 * Author names come from Git rather than the `actors` table because that
 * table's only writer is the Forge sync, so it is empty on a repository that
 * never synced a GitHub forge, and it carries no `repository_id` to scope a
 * read by. Git history needs no network and is present wherever `.iroha/` is.
 *
 * Neither half is required: a repository with no commits yields no names, and
 * `user.name` may be unset. Both degrade to an empty list plus `null` rather
 * than an error, because the field they feed accepts a typed name anyway — so
 * there is no failure for a caller to handle, and this returns a plain value
 * rather than a `Result` that could only ever be `ok`.
 */
export async function readRepositoryPeople(cwd: string): Promise<RepositoryPeople> {
  const [authors, configured] = await Promise.all([
    runGit(["log", `--max-count=${AUTHOR_SCAN_COMMITS}`, "--format=%aN"], { cwd }),
    runGit(["config", "--get", "user.name"], { cwd }),
  ]);

  // `git config --get` exits 1 for an unset key and `git log` exits 128 on an
  // unborn HEAD; both are ordinary states here, not failures to report.
  const self = configured.ok && configured.value.trim() !== "" ? configured.value.trim() : null;

  const names = new Set<string>();
  if (authors.ok) {
    for (const line of authors.value.split(/\r?\n/)) {
      const name = line.trim();
      if (name !== "" && !BOT_NAME.test(name)) {
        names.add(name);
      }
    }
  }
  if (self !== null) {
    names.add(self);
  }

  // Alphabetical, never by commit count: ordering people by how much they
  // committed is the individual ranking CLAUDE.md forbids, and it would be
  // visible in the picker even without a number next to each name.
  return { names: Array.from(names).sort((a, b) => a.localeCompare(b)), self };
}
