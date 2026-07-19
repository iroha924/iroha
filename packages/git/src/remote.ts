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
// - The bare-path/standalone-drive-letter/UNC alternatives use a narrower
//   allowlist: only the start of the value or whitespace. Unlike "file:", a
//   bare `/` can be preceded by almost any character and still be a
//   completely ordinary URL path separator — RFC 3986 path segments allow
//   `-`, `_`, `.`, `~`, and more, unencoded. Confirmed by reproduction:
//   `https://example.com/foo_/repo.git` — an ordinary, safe URL — was
//   misclassified as local and suppressed to `null`, because `_` isn't
//   excluded by the denylist above, so the `/` right after it looked like a
//   fresh marker start. No character-class boundary can perfectly separate
//   "a joined second value" from "ordinary URL path content" (both can
//   contain nearly anything), so this narrows to the one truly unambiguous
//   case — whitespace is never valid raw URL content — accepting that a
//   *bare* local path joined by some other, non-`file:`-prefixed character
//   with no whitespace goes undetected. No finding has shown that shape.
const LOCAL_PATH_MARKER =
  /(?:(?<![a-zA-Z0-9:/\\])file:(?:\/+|[a-zA-Z]:[\\/])|(?:^|\s)(?:\/|[a-zA-Z]:[\\/]|\\\\))/i;

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
 * Uses `--get-all` (returning every configured value, newline-separated),
 * not `--get` (a single value) — confirmed by reproduction: `git remote
 * set-url --add <name> <url>` can configure more than one URL for the same
 * remote (Git fans push out to all of them, but fetch always uses only the
 * first). `--get` returns the *last* configured value in that case, while
 * Git itself (and `git remote get-url`, sans its `insteadOf` problem) uses
 * the *first* as the fetch URL. Taking `--get`'s answer would record
 * metadata for a URL Git never actually fetches from.
 *
 * `--get-all` shares `--get`'s exit-code semantics for our purposes: a
 * missing key exits with status 1 and no stderr (git-config(1)); that exit
 * code alone (not stderr text, unlike Git's other subcommands) is what
 * distinguishes "no such remote" from other failures here. `--local` makes
 * "not inside a repository" its own distinguishable failure (exit 128,
 * `fatal: --local can only be used inside a git repository`) instead of
 * being silently indistinguishable from "no such remote" (both would
 * otherwise be exit 1 with empty stderr) — confirmed by manual reproduction.
 */
export async function getSanitizedRemoteUrl(
  cwd: string,
  remoteName = "origin",
): Promise<Result<string | null, IrohaError>> {
  const result = await runGit(["config", "--local", "--get-all", `remote.${remoteName}.url`], {
    cwd,
  });
  if (!result.ok) {
    const exitCode = (result.error.details as { exitCode?: number | null } | undefined)?.exitCode;
    if (exitCode === 1) {
      return ok(null);
    }
    return err(result.error);
  }
  const firstFetchUrl = result.value.split("\n")[0] ?? "";
  return ok(sanitizeRemoteUrl(firstFetchUrl));
}
