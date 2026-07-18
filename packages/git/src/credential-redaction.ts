const SCHEME_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]*@)?([^?#]*)/;

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
