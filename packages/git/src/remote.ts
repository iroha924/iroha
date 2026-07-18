import type { IrohaError } from "@iroha/domain";
import { ok, type Result } from "@iroha/domain";
import { runGit } from "./run-git.js";

const SCHEME_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]*@)?(.*)$/;

/**
 * Strips embedded credentials from a Git remote URL so it is safe to store.
 * Only `scheme://[user[:token]@]host/...` URLs carry a userinfo slot that can
 * hold a secret (e.g. a GitHub PAT as the "username"), so only that form is
 * rewritten. SCP-like remotes (`git@host:path`) and bare local paths
 * (including Windows drive letters, which would otherwise look like an SCP
 * `host:path` pair) are returned unchanged — SCP syntax has no field for a
 * password, and the leading `user@` there is a fixed transport user, not a
 * secret.
 */
export function sanitizeRemoteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();

  const schemeMatch = SCHEME_URL.exec(trimmed);
  if (schemeMatch) {
    const [, scheme, rest] = schemeMatch;
    return `${scheme}://${rest}`;
  }

  return trimmed;
}

/**
 * Reads the given remote's URL and returns it with credentials stripped.
 * Returns `null` (not an error) when the remote is not configured, since a
 * fresh or local-only repository legitimately has none.
 */
export async function getSanitizedRemoteUrl(
  cwd: string,
  remoteName = "origin",
): Promise<Result<string | null, IrohaError>> {
  const result = await runGit(["remote", "get-url", remoteName], { cwd });
  if (!result.ok) {
    return ok(null);
  }
  return ok(sanitizeRemoteUrl(result.value));
}
