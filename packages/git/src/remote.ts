import { err, type IrohaError, ok, type Result } from "@iroha/domain";
import { redactUrlLikeCredentials } from "./credential-redaction.js";
import { runGit } from "./run-git.js";

// `git remote get-url <missing>` fails with exit code 2 and exactly this
// stderr line (confirmed by manual reproduction) — distinct from "not a git
// repository" (exit 128) or any other failure, which must not be collapsed
// into the same "no remote configured" result.
const NO_SUCH_REMOTE = /^error: No such remote '/;

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
 * Returns `null` (not an error) only when Git reports the specific "no such
 * remote" condition, since a fresh or local-only repository legitimately has
 * none. Any other failure (not a repository, timeout, missing Git binary,
 * ...) propagates as an error instead of being silently reinterpreted as
 * "no remote configured".
 */
export async function getSanitizedRemoteUrl(
  cwd: string,
  remoteName = "origin",
): Promise<Result<string | null, IrohaError>> {
  const result = await runGit(["remote", "get-url", remoteName], { cwd });
  if (!result.ok) {
    const stderr = (result.error.details as { stderr?: string } | undefined)?.stderr;
    if (stderr !== undefined && NO_SUCH_REMOTE.test(stderr)) {
      return ok(null);
    }
    return err(result.error);
  }
  return ok(sanitizeRemoteUrl(result.value));
}
