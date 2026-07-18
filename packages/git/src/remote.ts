import type { IrohaError } from "@iroha/domain";
import { ok, type Result } from "@iroha/domain";
import { redactUrlLikeCredentials } from "./credential-redaction.js";
import { runGit } from "./run-git.js";

/**
 * Strips embedded credentials from a Git remote URL so it is safe to store.
 * Only `scheme://[user[:token]@]host/...` URLs carry a slot that can hold a
 * secret — the userinfo (e.g. a GitHub PAT as the "username") and, less
 * conventionally, the query string or fragment (e.g. a presigned URL's
 * `?access_token=...`) — so only that form is rewritten, dropping both.
 * SCP-like remotes (`git@host:path`) and bare local paths (including
 * Windows drive letters, which would otherwise look like an SCP `host:path`
 * pair) are returned unchanged — SCP syntax has no field for a password, and
 * the leading `user@` there is a fixed transport user, not a secret.
 */
export function sanitizeRemoteUrl(rawUrl: string): string {
  return redactUrlLikeCredentials(rawUrl.trim());
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
