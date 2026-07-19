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

    // Once a query/fragment is known to be present, `redactUrlLikeCredentials`
    // drops it (and anything nested in it) regardless of content, so its
    // true extent is the true end of the text — not `nextStart` (lets a
    // nested scheme through, already handled above) and not any delimiter
    // search, including whitespace-only (an earlier version of this
    // function tried both; confirmed by reproduction that Git accepts and
    // echoes back a query value containing a raw, unencoded space —
    // "?access_token=abc def" — so there is no character, not even
    // whitespace, that Git guarantees a credential-bearing query cannot
    // contain). The cost: a genuinely separate, unrelated URL later in the
    // same text after a query-bearing one is swallowed along with the
    // query instead of being redacted on its own — accepted, since there is
    // no reliable way to tell that case apart from an opaque query value
    // that happens to contain "https://" as literal text.
    const delimiter = HARD_DELIMITER.exec(boundedRemainder);
    const end = hasQuery
      ? text.length
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
//
// Only marks the *start* of each path — how far it extends is resolved
// separately below, since a path can itself contain a space (confirmed by
// reproduction: a `GIT_CONFIG_GLOBAL` file under a directory with a space in
// its name produces "...in file /tmp/dir with space/gitconfig", and Git can
// also quote a `file://` pathspec containing one), which an earlier version
// of this module's single `[^\s'"]*` tail wrongly treated as "the path has
// ended here". `~[a-zA-Z0-9_-]*\/` (not just bare `~\/`) matches both `~/`
// (current user's home) and `~user/` (another user's home) — see
// `LOCAL_PATH_MARKER` in remote.ts, kept consistent with this module, for
// the reproduction confirming Git expands both forms for a local remote.
const ABSOLUTE_PATH_START =
  /(?:(?<![a-zA-Z0-9:/\\])file:(?:\/+|[a-zA-Z]:[\\/])|(?:^|(?<![a-zA-Z0-9:/\\@_.~!$&()*+,;=-]))(?:~[a-zA-Z0-9_-]*\/|\/|[a-zA-Z]:[\\/]|\\\\))/gi;

/**
 * Finds the quote that closes a Git-quoted region starting at `from`
 * (immediately after the opening `quoteChar`). Confirmed by reproduction
 * that Git does not escape a quote character embedded *within* the quoted
 * value itself (e.g. `checkout /tmp/secret'with'quotes` produces `fatal:
 * ... '/tmp/secret'with'quotes' is outside repository at ...` — two
 * embedded quotes before the real closing one), so the first occurrence of
 * `quoteChar` is not reliably the closing one. A quote immediately followed
 * by whitespace or the end of the text is treated as the genuine close;
 * one immediately followed by more non-whitespace text is treated as still
 * inside the path and skipped, since Git's own path content never abuts
 * another value with no separator at all in any confirmed reproduction.
 */
function findClosingQuote(text: string, quoteChar: string, from: number): number {
  let index = text.indexOf(quoteChar, from);
  while (index !== -1) {
    const next = index + 1 < text.length ? text[index + 1] : undefined;
    if (next === undefined || /\s/.test(next)) {
      return index;
    }
    index = text.indexOf(quoteChar, index + 1);
  }
  return -1;
}

/**
 * Finds the first quote character *preceded by whitespace* at or after
 * `from` — the point where an unquoted path plausibly ends and a
 * quoted repeat of it (Git's own "X: 'X' is outside repository at '...'"
 * pattern, confirmed by reproduction) begins. Unlike `findClosingQuote`,
 * this deliberately does NOT stop at just any quote: a quote embedded
 * directly in the unquoted path itself (no reproduction has shown Git
 * inserting whitespace before such a quote) must not be mistaken for that
 * boundary the same way `findClosingQuote`'s own target quote must not be
 * mistaken for one embedded in the *quoted* form of the same path.
 */
function findBoundaryQuote(text: string, from: number): number {
  const QUOTE = /['"]/g;
  QUOTE.lastIndex = from;
  for (const match of text.slice(from).matchAll(QUOTE)) {
    const index = from + (match.index ?? 0);
    const preceding = index > 0 ? text[index - 1] : undefined;
    if (preceding !== undefined && /\s/.test(preceding)) {
      return index;
    }
  }
  return -1;
}

/**
 * Replaces every filesystem-path-shaped substring in free-form text (e.g.
 * Git's own stderr) with a placeholder — mcp-contract.md §8 forbids
 * returning filesystem absolute paths in any DB/API/MCP-reachable text, and
 * Git's diagnostic messages can embed one with no credential-URL shape for
 * `redactUrlLikeCredentialsInText` to catch. Apply this *after* credential
 * redaction, not before: this leaves an already-redacted URL's own `/`s
 * alone (see `ABSOLUTE_PATH_START`), but running it first would let a
 * still-credentialed URL's leading `/` (if boundary-preceded) get replaced
 * wholesale instead of just having its userinfo stripped.
 *
 * A path's extent depends on whether Git quoted it: a path immediately
 * preceded by `'`/`"` extends through everything up to its `findClosingQuote`
 * — spaces and even embedded quote characters included, since a quote is
 * only trusted as the boundary once it's confirmed not to be embedded path
 * content. An unquoted path has no such boundary of its own, so it extends
 * up to (but not including) `findBoundaryQuote`'s result, trimming any
 * whitespace immediately before it — or to the true end of the text if no
 * such quote exists anywhere later.
 */
export function redactAbsolutePathsInText(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(ABSOLUTE_PATH_START)) {
    const start = match.index;
    if (start < cursor) {
      continue;
    }
    result += text.slice(cursor, start);

    const precedingChar = start > 0 ? text[start - 1] : undefined;
    let end: number;
    if (precedingChar === "'" || precedingChar === '"') {
      const closingQuote = findClosingQuote(text, precedingChar, start);
      end = closingQuote === -1 ? text.length : closingQuote;
    } else {
      const boundaryQuote = findBoundaryQuote(text, start);
      end = boundaryQuote === -1 ? text.length : boundaryQuote;
      while (end > start && /\s/.test(text[end - 1] ?? "")) {
        end--;
      }
    }

    result += "<path>";
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}
