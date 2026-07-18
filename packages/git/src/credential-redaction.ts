// The userinfo group is `[^/?#]*@` (greedy, `@` allowed inside), not
// `[^@/]*@` (`@` excluded) — a password containing a literal unescaped `@`
// (e.g. `alice:p@ss@host`) has more than one `@` before the host, and only
// the greedy form backtracks to match through the *last* one, the actual
// userinfo/host boundary. The excluded-`@` form would stop at the first `@`
// and leave the password's tail sitting in the "host" position, unredacted.
//
// `?`/`#` are excluded too (not just `/`): without that, a URL with no path
// segment before its query/fragment (e.g.
// "https://example.com?access_token=a@b") lets the greedy match cross the
// "?" and backtrack onto the "@" inside the query value, mis-parsing
// "example.com?access_token=a" as userinfo and "b" as the host — corrupting
// the redacted URL and leaving part of the credential in the output.
// Confirmed by reproduction.
const SCHEME_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^/?#]*@)?([^?#]*)/;

/**
 * Strips everything a `scheme://` URL can use to carry a secret: the
 * userinfo slot (`user[:token]@`, e.g. a GitHub PAT used as the "username")
 * and any query string or fragment (e.g. `?access_token=...`, a presigned-
 * URL signature). Non-`scheme://` values (SCP-like `git@host:path` remotes,
 * bare local paths, arbitrary CLI arguments) are returned unchanged.
 */
export function redactUrlLikeCredentials(value: string): string {
  const match = SCHEME_URL.exec(value);
  if (!match) {
    return value;
  }
  const [, scheme, rest] = match;
  return `${scheme}://${rest}`;
}

// Enclosing/quoting punctuation Git's own diagnostic text commonly wraps a
// URL in (e.g. the single quotes around an unmatched pathspec), plus
// whitespace. `,` and `;` are deliberately NOT included — both are valid
// unencoded userinfo/query characters per RFC 3986 sub-delims, and a
// password containing one (e.g. "p,ss") must not truncate the match before
// its "@" is seen. `'`, `(`, `)` ARE sub-delims too, so they have the same
// problem in principle — handled not by excluding them here (that would
// also stop Git's own quoted-pathspec text from being trimmed correctly)
// but by never applying this delimiter search until *after* the userinfo
// has already been consumed — see `redactUrlLikeCredentialsInText`.
const HARD_DELIMITER = /[\s'"<>()[\]{}]/;

// Marks where each candidate URL starts. Boundaries between adjacent
// candidates are resolved by whichever comes first: the next scheme start,
// or a HARD_DELIMITER — so two URLs joined with no whitespace between them
// (confirmed by reproduction: "https://a/x,https://tok@b/y") still get a
// boundary at the second `https://`, even though `,` is no longer a hard
// delimiter.
const SCHEME_START = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//g;

// Matches only "scheme://[userinfo@]" — the same backtracking userinfo
// logic as SCHEME_URL, but stops right after the userinfo instead of also
// consuming host+path. Used to find where HARD_DELIMITER search is safe to
// start: applying it any earlier (an earlier version of this function did)
// lets a delimiter character that's actually part of the password — `)` or
// `'`, both valid unencoded RFC 3986 userinfo characters, same as `,`/`;`
// before them — truncate the match before the real host "@" is ever
// reached. Confirmed by reproduction: "https://user:p)ss@host/path" cut down
// to "https://user:p" (no "@" left in it), passing the whole credential
// through unredacted, the same failure shape as the earlier `,` bug.
const SCHEME_AND_USERINFO = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/?#]*@)?/;

/**
 * Redacts every `scheme://`-shaped substring found anywhere inside free-form
 * text (e.g. Git's own stderr, which can echo a caller-supplied argument
 * back verbatim — confirmed for `checkout <unmatched-pathspec>` — rather
 * than treating the whole string as a single URL like
 * `redactUrlLikeCredentials` does).
 */
export function redactUrlLikeCredentialsInText(text: string): string {
  const starts = [...text.matchAll(SCHEME_START)].map((match) => match.index ?? 0);
  if (starts.length === 0) {
    return text;
  }

  let result = "";
  let cursor = 0;
  for (const [i, start] of starts.entries()) {
    result += text.slice(cursor, start);

    const nextStart = starts[i + 1] ?? text.length;
    const span = text.slice(start, nextStart);
    const prefixMatch = SCHEME_AND_USERINFO.exec(span);
    const prefixLength = prefixMatch ? prefixMatch[0].length : 0;
    const delimiter = HARD_DELIMITER.exec(span.slice(prefixLength));
    const end = start + (delimiter ? prefixLength + delimiter.index : span.length);

    result += redactUrlLikeCredentials(text.slice(start, end));
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

// A filesystem path marker (POSIX absolute, home-relative, Windows
// drive-letter, or UNC) immediately preceded by the start of the text,
// whitespace, or a quote — never by `:` or `/`, so this never fires inside
// an already-processed "scheme://host/path" URL's own interior (its `/`s
// are always preceded by `:` or another `/`, neither of which is a
// boundary here). Confirmed by reproduction: a malformed `GIT_CONFIG_GLOBAL`
// file makes Git itself print e.g. "fatal: bad config line 1 in file
// /tmp/xxx/.gitconfig" — an absolute path Git generated, not something a
// caller's argument echoed back, so no scheme marker exists to scan for.
const ABSOLUTE_PATH_IN_TEXT = /(^|[\s'"])(?:\/|~\/|[a-zA-Z]:[\\/]|\\\\)[^\s'"]*/g;

/**
 * Replaces every filesystem-path-shaped substring in free-form text (e.g.
 * Git's own stderr) with a placeholder — mcp-contract.md §8 forbids
 * returning filesystem absolute paths in any DB/API/MCP-reachable text, and
 * Git's diagnostic messages can embed one with no credential-URL shape for
 * `redactUrlLikeCredentialsInText` to catch. Apply this *after* credential
 * redaction, not before: this leaves an already-redacted URL's own `/`s
 * alone (see `ABSOLUTE_PATH_IN_TEXT`), but running it first would let a
 * still-credentialed URL's leading `/` (if boundary-preceded) get replaced
 * wholesale instead of just having its userinfo stripped.
 */
export function redactAbsolutePathsInText(text: string): string {
  return text.replace(ABSOLUTE_PATH_IN_TEXT, (_match, boundary: string) => `${boundary}<path>`);
}
