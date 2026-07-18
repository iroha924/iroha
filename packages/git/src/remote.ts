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
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const UNC_PATH = /^\\\\/;
const FILE_SCHEME = /^file:\/\//i;

function isLocalAbsolutePathToken(token: string): boolean {
  return (
    FILE_SCHEME.test(token) ||
    token.startsWith("/") ||
    WINDOWS_DRIVE_PATH.test(token) ||
    UNC_PATH.test(token)
  );
}

// Checked token by token (split on any whitespace, not just newlines), not
// just at the start of the whole value: Git accepts (and can print back) a
// value containing an embedded newline OR a literal space — confirmed by
// reproduction that `git remote add origin 'https://x/repo.git
// /Users/alice/private.git'` stores that verbatim as one config value — so
// a local path can appear anywhere after other, safe-looking content.
// `String.prototype.split(/\s+/)` already splits on "\n" (it's whitespace),
// so this single split covers both the newline- and space-joined cases.
function isLocalAbsolutePath(value: string): boolean {
  return value.split(/\s+/).some((token) => isLocalAbsolutePathToken(token));
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
 * Reads `remote.<name>.url` directly via `git config --local --get` rather
 * than `git remote get-url`: per Git's own docs, `remote get-url` expands
 * any local `url.<base>.insteadOf` rewrite the current machine has
 * configured, so two teammates with different rewrite config would compute
 * a different `remote_url_normalized` for the identical repository. `--get`
 * on a missing key exits with status 1 and no stderr (git-config(1)); that
 * exit code alone (not stderr text, unlike Git's other subcommands) is what
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
  const result = await runGit(["config", "--local", "--get", `remote.${remoteName}.url`], {
    cwd,
  });
  if (!result.ok) {
    const exitCode = (result.error.details as { exitCode?: number | null } | undefined)?.exitCode;
    if (exitCode === 1) {
      return ok(null);
    }
    return err(result.error);
  }
  return ok(sanitizeRemoteUrl(result.value));
}
