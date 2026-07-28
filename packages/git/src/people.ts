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
 * How far back author names are collected. This caps the number of lines, not
 * their length — Git bounds neither, so a history of pathologically long author
 * names can still overrun `runGit`'s 10 MiB buffer and fail the read. That
 * degrades to no picker rather than to no approval, since the reviewer field
 * stays free text, which is also why anyone the scan misses can be typed in.
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
 * `actorSchema.displayName` in `@iroha/api` bounds the reviewer name at 120
 * characters. Git author names are unbounded, so offering a longer one would
 * let the picker produce a value its own approve call then rejects with a 400
 * the UI cannot explain.
 */
const MAX_REVIEWER_NAME_LENGTH = 120;

/**
 * Characters that make a name misread rather than merely odd: C0/C1 controls,
 * the bidirectional overrides and isolates, and the two zero-width characters
 * with no linguistic role. A name carrying one of these is committed verbatim
 * into `approved_by.display_name`, so U+202E reverses the rendering of every
 * later line of that canonical file, and a zero-width space produces a second
 * picker entry indistinguishable from the real one.
 *
 * Not the whole of `\p{Cf}`: ZWNJ (U+200C) and ZWJ (U+200D) are required to
 * spell names correctly in Persian and Indic scripts, and rejecting them would
 * cost real people their names to buy very little.
 *
 * This is hygiene on a suggestion list, not a boundary — the approve endpoint
 * applies no such filter, so a typed or posted name bypasses it entirely. Nor
 * does it close visual spoofing in general: homoglyphs (Cyrillic `а` for Latin
 * `a`) are ordinary letters and no character class reaches them. Do not grow
 * this into a confusables table; that problem has no end.
 */
const UNRENDERABLE_CHARACTER = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/u;

function exitCodeOf(error: IrohaError): number | null | undefined {
  return (error.details as { exitCode?: number | null } | undefined)?.exitCode;
}

/** Whether a name can actually be committed as `approved_by.display_name`. */
function isSelectableReviewer(name: string): boolean {
  return (
    name !== "" &&
    name.length <= MAX_REVIEWER_NAME_LENGTH &&
    !UNRENDERABLE_CHARACTER.test(name) &&
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
 * Two flags exist to stop configuration from rewriting the stdout this parses,
 * and both are load-bearing rather than tidiness. Under `log.showSignature`
 * Git writes signature-verification text to the same stdout as the formatted
 * output, so lines like `~/.ssh/allowed_signers:1: invalid key` would be read
 * as people and served over HTTP — and `runGit` redacts absolute paths only on
 * its failure path, so nothing else would catch it. Under
 * `i18n.logOutputEncoding` Git re-encodes the author ident, so a name arrives
 * as mojibake that passes every filter here and gets committed as someone's
 * spelling. `git config` is not re-encoded, which is how that one shows itself:
 * the same person appears twice, once correct and once corrupted.
 *
 * `--all` rather than the HEAD-only default: someone who has only committed on
 * a feature branch is still a person who can review. It costs a wider failure
 * surface — one unresolvable ref anywhere under `refs/` fails the whole walk
 * with exit 128 — so a failed `--all` retries from HEAD rather than taking the
 * endpoint down over a dangling remote branch. Only when both fail is it
 * reported, which keeps a genuinely broken repository distinguishable from one
 * that simply has no people.
 */
export async function readRepositoryPeople(
  cwd: string,
): Promise<Result<RepositoryPeople, IrohaError>> {
  const logArgs = [
    "--no-show-signature",
    "--encoding=UTF-8",
    `--max-count=${AUTHOR_SCAN_COMMITS}`,
    "--format=%aN",
  ];
  const [allRefs, configured] = await Promise.all([
    runGit(["log", "--all", ...logArgs], { cwd }),
    runGit(["config", "--get", "user.name"], { cwd }),
  ]);

  const authors = allRefs.ok ? allRefs : await runGit(["log", ...logArgs], { cwd });
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

  // UTF-16 code-unit order, not `localeCompare`: this package pins `LC_ALL=C`
  // so Git reads the same everywhere, and a list whose order depends on the
  // server's ICU build would undo that for no gain. Code-unit rather than
  // code-point is not a considered choice, only what `<` on JS strings does;
  // the two differ solely for astral characters and either is deterministic,
  // which is the property being bought.
  return ok({
    names: Array.from(names).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    self,
  });
}
