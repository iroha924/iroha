// The userinfo group is `[^/]*@` (greedy, `@` allowed inside), not `[^@/]*@`
// (`@` excluded) — a password containing a literal unescaped `@` (e.g.
// `alice:p@ss@host`) has more than one `@` before the host, and only the
// greedy form backtracks to match through the *last* one, the actual
// userinfo/host boundary. The excluded-`@` form would stop at the first `@`
// and leave the password's tail sitting in the "host" position, unredacted.
const SCHEME_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^/]*@)?([^?#]*)/;

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

const EMBEDDED_URL = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+/g;

/**
 * Redacts every `scheme://`-shaped substring found anywhere inside free-form
 * text (e.g. Git's own stderr, which can echo a caller-supplied argument
 * back verbatim — confirmed for `checkout <unmatched-pathspec>` — rather
 * than treating the whole string as a single URL like
 * `redactUrlLikeCredentials` does).
 */
export function redactUrlLikeCredentialsInText(text: string): string {
  return text.replace(EMBEDDED_URL, (match) => redactUrlLikeCredentials(match));
}
