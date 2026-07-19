import { err, type IrohaError, ok, type Result } from "@iroha/domain";
import { redactUrlLikeCredentialsInText } from "./credential-redaction.js";
import { runGit } from "./run-git.js";

// A `file://` URL's "path" component is itself a filesystem path, and a
// bare/POSIX/UNC/Windows-drive-letter path has no scheme at all — none of
// these can be redacted down to something safe the way a credential-bearing
// `scheme://` URL can, since the ENTIRE value is the sensitive part (an
// absolute local filesystem path), not just a userinfo/query slot within it.
// mcp-contract.md §8 forbids returning filesystem absolute paths in any
// DB/API/MCP-reachable text, and `repositories.remote_url_normalized`
// (database-schema.md) is nullable, so suppressing it entirely for a
// local-path remote applies that existing invariant rather than adding a
// new one.
// A local-path marker (`file:` scheme, bare POSIX absolute path, Windows
// drive letter, or UNC path) found anywhere in the value, not just at the
// very start — Git stores two values joined by an arbitrary character
// (newline, space, comma, semicolon, `(`, `<`, `|`, `@`, ...) verbatim as a
// single config value, confirmed by reproduction across many such
// characters, so no fixed allowlist of "boundary punctuation" is complete.
//
// Two different boundary rules apply, deliberately not the same one:
//
// - `file:` uses a denylist: the marker must not be immediately preceded
//   by a letter, digit, `:`, `/`, or `\`. That's exactly what's needed to
//   stop `[a-zA-Z]:` from matching the "s:" right before "://" in
//   "https://"/"ssh://" (always preceded by another letter) while still
//   accepting every joiner character above as a valid boundary — "file:" is
//   a distinctive enough prefix that this is safe. It needs two sub-forms,
//   not just `\/+`: Git also accepts `file:C:/Users/...` and
//   `file:C:\Users\...` (a drive-letter path directly after the single
//   colon, no slash at all between "file:" and "C:", confirmed by
//   reproduction) — the standalone `[a-zA-Z]:[\\/]` alternative below can't
//   reach that shape, since its own boundary check sees the `:` at the end
//   of "file:" immediately before "C" and refuses to treat it as a marker
//   start.
//
// - The bare-path/standalone-drive-letter/UNC alternatives use their own,
//   narrower denylist: not preceded by anything that could be legitimate
//   raw URL path content per RFC 3986 — unreserved (letters, digits, `-`
//   `.` `_` `~`) plus the sub-delims Git plausibly stores unencoded (`!` `$`
//   `&` `(` `)` `*` `+` `,` `;` `=`) plus `:`/`/`/`\`/`@`. A first attempt at
//   this alternative used a plain allowlist (only the start of the value or
//   whitespace); that missed `https://x/repo.git|/Users/alice/y` (Git
//   accepts and stores this verbatim, confirmed by reproduction) since `|`
//   isn't whitespace, and its own predecessor (the same denylist as `file:`
//   above) wrongly treated `_`/`-`/`.` as valid boundaries even though
//   they're common, legitimate URL path characters — misclassifying
//   `https://example.com/foo_/repo.git` (an ordinary, safe URL) as local.
//   `'`/`"` are deliberately excluded from the protected set (i.e. they
//   remain valid boundaries) despite being RFC 3986 sub-delims too: kept
//   consistent with `redactAbsolutePathsInText` in credential-redaction.ts,
//   which needs them as boundaries to redact a path Git's own diagnostic
//   text quotes with them — a concrete, common case that outweighs the
//   theoretical, rare one of a URL path segment ending in a literal
//   apostrophe. This is the most complete boundary this module tracks, but
//   still not a perfect one: any pchar not
//   in the excluded set above (RFC 3986 leaves very little out) could in
//   principle still be exploited as an undetected joiner — accepted as a
//   residual gap rather than encoding the *entire* pchar grammar here.
//
// `~/` (current user's home) and `~user/` (another user's home) are also
// local-path markers — confirmed by reproduction that Git accepts and
// stores `~/private.git`/`~someuser/private.git` verbatim as a remote and
// expands them under the relevant home directory on fetch. An earlier
// version of this module's bare-path alternatives omitted both forms
// entirely, so a home-relative remote reached `remote_url_normalized`
// unchanged. `~user/` (unlike a bare `/`) is safe to recognize with the
// same narrow boundary as the other bare-path forms: a URL path segment
// legitimately starting with "~user/" (e.g.
// "https://example.com/~user/repo.git") is always preceded by a "/" (already
// excluded), never by the value's own start or whitespace.
const LOCAL_PATH_MARKER =
  /(?:(?<![a-zA-Z0-9:/\\])file:(?:\/+|[a-zA-Z]:[\\/])|(?:^|(?<![a-zA-Z0-9:/\\@_.~!$&()*+,;=-]))(?:~[a-zA-Z0-9_-]*\/|\/|[a-zA-Z]:[\\/]|\\\\))/i;

function isLocalAbsolutePath(value: string): boolean {
  return LOCAL_PATH_MARKER.test(value);
}

/**
 * Strips embedded credentials from a Git remote URL so it is safe to store,
 * and returns `null` in place of a local absolute path (see
 * `isLocalAbsolutePath`) since no partial redaction can make one safe.
 *
 * Only `scheme://[user[:token]@]host/...` URLs carry a slot that can hold a
 * secret — the userinfo (e.g. a GitHub PAT as the "username") and, less
 * conventionally, the query string or fragment (e.g. a presigned URL's
 * `?access_token=...`) — so only that form is rewritten, dropping both.
 * SCP-like remotes (`git@host:path`) are returned unchanged — SCP syntax has
 * no field for a password, the leading `user@` there is a fixed transport
 * user rather than a secret, and (unlike a local path) the value doesn't
 * reveal anything about the local filesystem.
 *
 * Uses the text-scanning redactor, not the single-URL one: Git accepts (and
 * `remote get-url` prints back) a value containing an embedded newline, and
 * a single-URL-shaped match would only strip the first of two such URLs,
 * leaving a second one's credentials untouched.
 */
export function sanitizeRemoteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (isLocalAbsolutePath(trimmed)) {
    return null;
  }
  return redactUrlLikeCredentialsInText(trimmed);
}

/**
 * Reads the given remote's URL and returns it with credentials stripped.
 * Returns `null` (not an error) both when no such remote is configured (a
 * fresh or local-only repository legitimately has none) and when the
 * configured remote is a local absolute path (see `sanitizeRemoteUrl`). Any
 * other failure (not a repository, timeout, missing Git binary, ...)
 * propagates as an error instead of being silently reinterpreted as "no
 * remote configured".
 *
 * Reads `remote.<name>.url` directly via `git config --local --get-all`
 * rather than `git remote get-url`: per Git's own docs, `remote get-url`
 * expands any local `url.<base>.insteadOf` rewrite the current machine has
 * configured, so two teammates with different rewrite config would compute
 * a different `remote_url_normalized` for the identical repository.
 *
 * Uses `--get-all` (returning every configured value), not `--get` (a
 * single value) — confirmed by reproduction: `git remote set-url --add
 * <name> <url>` can configure more than one URL for the same remote (Git
 * fans push out to all of them, but fetch always uses only the first).
 * `--get` returns the *last* configured value in that case, while Git
 * itself (and `git remote get-url`, sans its `insteadOf` problem) uses the
 * *first* as the fetch URL. Taking `--get`'s answer would record metadata
 * for a URL Git never actually fetches from.
 *
 * Uses `--null` (NUL-separated records), not plain output (newline-
 * separated) — confirmed by reproduction: a *single* configured value can
 * itself contain an embedded newline (Git accepts and stores it), which
 * plain `--get-all` output cannot be told apart from the newline separating
 * two genuinely distinct values. Splitting plain output on "\n" and taking
 * the first line — an earlier version of this function did — silently
 * truncated a multiline value to its first line, so a local-path suffix on
 * a later "line" of what was really one value never reached
 * `sanitizeRemoteUrl` at all, and the safe-looking truncated prefix was
 * returned instead of `null`. `--null` NUL-terminates each genuine record
 * (Git's own value/config-key text essentially cannot itself contain a NUL
 * byte), so splitting on "\0" and taking the first element reliably yields
 * the complete first value, embedded newlines and all.
 *
 * `--get-all --null` shares `--get`'s exit-code semantics for our purposes:
 * a missing key exits with status 1 and no stderr (git-config(1)); that
 * exit code alone (not stderr text, unlike Git's other subcommands) is what
 * distinguishes "no such remote" from other failures here. `--local` makes
 * "not inside a repository" its own distinguishable failure (exit 128,
 * `fatal: --local can only be used inside a git repository`) instead of
 * being silently indistinguishable from "no such remote" (both would
 * otherwise be exit 1 with empty stderr) — confirmed by manual reproduction.
 *
 * Falls back to `--worktree` scope only when `--local` finds nothing (exit
 * 1): confirmed by reproduction that with `extensions.worktreeConfig`
 * enabled, a linked worktree's `remote.<name>.url` set via `git config
 * --worktree` lives in a separate file `--local` never reads, so `--local`
 * alone reports "no remote" even though one is configured for that
 * worktree. `--worktree` is safe to query unconditionally as a fallback:
 * confirmed by reproduction that when the extension is *not* enabled,
 * `--worktree` transparently reads the same file as `--local` (no separate
 * file exists yet), so this fallback is a harmless no-op in the common
 * case. Not queried when `--local` already found a value: confirmed by
 * reproduction that Git's own subcommands disagree with each other about
 * which scope wins when *both* are set for `remote.*.url` (`git config
 * --get` picks `--worktree`, but `git remote get-url` picks `--local`), so
 * there is no single answer to defer to here; `--local` winning matches
 * what `remote get-url` — the thing this function exists to approximate
 * without its `insteadOf` problem — actually uses.
 */
export async function getSanitizedRemoteUrl(
  cwd: string,
  remoteName = "origin",
): Promise<Result<string | null, IrohaError>> {
  const localResult = await runGit(
    ["config", "--local", "--null", "--get-all", `remote.${remoteName}.url`],
    { cwd },
  );
  if (localResult.ok) {
    const firstFetchUrl = localResult.value.split("\0")[0] ?? "";
    return ok(sanitizeRemoteUrl(firstFetchUrl));
  }

  const localExitCode = (localResult.error.details as { exitCode?: number | null } | undefined)
    ?.exitCode;
  if (localExitCode !== 1) {
    return err(localResult.error);
  }

  const worktreeResult = await runGit(
    ["config", "--worktree", "--null", "--get-all", `remote.${remoteName}.url`],
    { cwd },
  );
  if (!worktreeResult.ok) {
    const worktreeExitCode = (
      worktreeResult.error.details as { exitCode?: number | null } | undefined
    )?.exitCode;
    if (worktreeExitCode === 1) {
      return ok(null);
    }
    return err(worktreeResult.error);
  }
  const firstWorktreeUrl = worktreeResult.value.split("\0")[0] ?? "";
  return ok(sanitizeRemoteUrl(firstWorktreeUrl));
}
