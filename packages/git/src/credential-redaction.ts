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

// Marks the start of a query or fragment — the point after which
// `redactUrlLikeCredentials`'s own `[^?#]*` "rest" group stops and
// therefore drops everything. Used to detect when a `SCHEME_START` match
// found later in the text is actually *nested inside* the current
// candidate's own query/fragment value, rather than being a second,
// independent URL — see the `hasQuery` branch below.
const QUERY_START = /[?#]/;

// Once a query/fragment is known to be present, its own content is opaque —
// Git enforces no structure or encoding on it, so it can contain literally
// anything, including a `HARD_DELIMITER` character. Confirmed by
// reproduction: "https://x/repo.git?access_token=abc'def" (Git stores and
// echoes this verbatim) — bounding the query search with `HARD_DELIMITER`
// (an earlier version of this function did) stopped at the "'" *inside* the
// secret, leaving "def" to leak back in as unprocessed trailing text, the
// same failure shape as the nested-URL bug above. Whitespace is the only
// character that can bound a query/fragment safely: unlike quotes or
// brackets, a raw (unencoded) space is not plausible content for a
// credential value, so it still correctly separates a query-bearing URL
// from a genuinely distinct URL that follows it in the same text (e.g. "...
// https://a/x?tok=1 then https://tok@b/y" — the query stops at "then", not
// at the second URL's own userinfo).
const QUERY_DELIMITER = /\s/;

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
    if (start < cursor) {
      // A `SCHEME_START` match that falls inside a query/fragment already
      // consumed by the previous candidate (see the `hasQuery` branch
      // below) — not an independent URL of its own. Confirmed by
      // reproduction: without this, a value like
      // "https://x/repo.git?token=https://evil/SECRET" redacted the outer
      // URL's query away correctly, then treated the *nested* scheme as a
      // second, unrelated candidate and appended it back into the output
      // unredacted — the secret leaked back in through the side channel
      // this loop used to detect "a second URL joined with no delimiter".
      continue;
    }
    result += text.slice(cursor, start);

    const nextStart = starts[i + 1] ?? text.length;
    const span = text.slice(start, nextStart);
    const prefixMatch = SCHEME_AND_USERINFO.exec(span);
    const prefixLength = prefixMatch ? prefixMatch[0].length : 0;
    const boundedRemainder = span.slice(prefixLength);
    const hasQuery = QUERY_START.test(boundedRemainder);

    // A query/fragment is being dropped by `redactUrlLikeCredentials`
    // regardless of what it contains, so its true extent must be found by
    // scanning past `nextStart` entirely (ignoring any scheme starts
    // nested inside it) rather than being capped there — capping at
    // `nextStart` here is what let the nested-URL bug above happen. Uses
    // `QUERY_DELIMITER` (whitespace only), not `HARD_DELIMITER` — see
    // `QUERY_DELIMITER`'s own comment for why the query case needs a
    // different, narrower delimiter than the non-query case below it.
    const searchSpace = hasQuery ? text.slice(start + prefixLength) : boundedRemainder;
    const delimiter = hasQuery
      ? QUERY_DELIMITER.exec(searchSpace)
      : HARD_DELIMITER.exec(searchSpace);
    const end = hasQuery
      ? start + prefixLength + (delimiter ? delimiter.index : searchSpace.length)
      : start + (delimiter ? prefixLength + delimiter.index : span.length);

    result += redactUrlLikeCredentials(text.slice(start, end));
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

// A filesystem path marker (POSIX absolute, home-relative, Windows
// drive-letter, UNC, or a `file:` URL wrapping any of those) found anywhere
// in the text. Same split-boundary design as `LOCAL_PATH_MARKER` in
// remote.ts (see its own comment for the full rationale and history):
// `file:` uses a denylist boundary (not preceded by a letter, digit, `:`,
// `/`, or `\`), which is exactly what keeps it from firing inside an
// already-processed "scheme://host/path" URL's own interior (its `/`s are
// always preceded by one of those four) while still catching "file:" joined
// to other text by any punctuation.
//
// The bare-path/drive-letter/UNC/`~/` alternatives use their own, narrower
// denylist instead: not preceded by anything that could be legitimate raw
// URL path content per RFC 3986 (unreserved, a subset of sub-delims,
// `:`/`/`/`\`/`@`) — a bare `/` has no distinctive prefix like "file:" does,
// so it needs stronger protection against colliding with ordinary path
// content (confirmed by reproduction:
// "https://example.invalid/org/my_repo/x.git" was having its "/x.git"
// replaced with a placeholder, since an earlier version of this boundary
// didn't exclude "_"). `'`/`"` are deliberately excluded from that
// protected set (i.e. they remain valid boundaries) despite being sub-delims
// too: Git's own diagnostic text routinely quotes a path with them (e.g.
// `git checkout /tmp/secret` produces `pathspec '/tmp/secret' did not
// match`, confirmed by reproduction), and redacting that quoted path is
// this function's whole job — outweighing the theoretical, rare case of a
// URL path segment ending in a literal apostrophe.
//
// Confirmed by reproduction: a malformed `GIT_CONFIG_GLOBAL` file makes Git
// itself print e.g. "fatal: bad config line 1 in file /tmp/xxx/.gitconfig"
// — a path Git generated itself, with no credential-URL shape for
// `redactUrlLikeCredentialsInText` to find; and Git can also echo back a
// caller's `file://...` argument verbatim (`redactUrlLikeCredentialsInText`
// leaves it alone, since a `file:` URL with no userinfo has no *credential*
// to strip — its host+path itself is the local path, which is this
// function's job, not that one's).
const ABSOLUTE_PATH_IN_TEXT =
  /(?:(?<![a-zA-Z0-9:/\\])file:(?:\/+|[a-zA-Z]:[\\/])|(?:^|(?<![a-zA-Z0-9:/\\@_.~!$&()*+,;=-]))(?:~\/|\/|[a-zA-Z]:[\\/]|\\\\))[^\s'"]*/gi;

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
  return text.replace(ABSOLUTE_PATH_IN_TEXT, "<path>");
}
