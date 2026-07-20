import type { Clock, Result, TypedId } from "@iroha/domain";
import { err, IrohaError, ok, sessionTokenSchema } from "@iroha/domain";
import {
  type Database,
  getSessionRunById,
  getSessionToken,
  type SessionTokenPlatform,
  updateSessionTokenLastUsed,
} from "@iroha/storage";
import { hashSessionToken } from "../hooks/session-token.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** The repository/Session/Run/platform a verified session token is bound to. */
export interface McpSessionContext {
  repositoryId: TypedId<"repo">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  platform: SessionTokenPlatform;
}

export interface VerifySessionTokenInput {
  db: Database;
  salt: Uint8Array;
  /** The repository this MCP request resolved to; the token must be bound to it. */
  repositoryId: TypedId<"repo">;
  clock: Clock;
  token: string;
}

/**
 * Verifies an `ist_` session token against the local `session_tokens` table
 * (mcp-contract.md §5): the token is valid only if its salt-keyed HMAC is on
 * record, bound to this repository, not past its idle-expiry, and its Run is
 * still active. On success the idle window slides forward (`last_used_at` /
 * `expires_at` bumped) and the bound identity is returned.
 *
 * Every failure returns an opaque message — the token, the reason it failed,
 * and which check rejected it are never surfaced to the model (§4/§5). The
 * plaintext token is never logged and is not placed in any error.
 */
export async function verifySessionToken(
  input: VerifySessionTokenInput,
): Promise<Result<McpSessionContext, IrohaError>> {
  const parsed = sessionTokenSchema.safeParse(input.token);
  if (!parsed.success) {
    return err(new IrohaError("INVALID_SESSION_TOKEN", "Session token is invalid"));
  }

  const tokenHmac = hashSessionToken(input.salt, input.token);
  const found = await getSessionToken(input.db, tokenHmac);
  if (!found.ok) {
    return err(found.error);
  }
  const row = found.value;
  if (row === null || row.repositoryId !== input.repositoryId) {
    return err(new IrohaError("INVALID_SESSION_TOKEN", "Session token is invalid"));
  }

  const now = input.clock.now();
  if (now.getTime() > new Date(row.expiresAt).getTime()) {
    return err(new IrohaError("SESSION_EXPIRED", "Session token has expired"));
  }

  const run = await getSessionRunById(input.db, row.runId);
  if (!run.ok) {
    return err(run.error);
  }
  if (run.value === null || run.value.status !== "active") {
    return err(new IrohaError("SESSION_EXPIRED", "Session run is no longer active"));
  }

  const bumped = await updateSessionTokenLastUsed(
    input.db,
    tokenHmac,
    now.toISOString(),
    new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  );
  if (!bumped.ok) {
    return err(bumped.error);
  }

  return ok({
    repositoryId: row.repositoryId,
    sessionId: row.sessionId,
    runId: row.runId,
    platform: row.platform,
  });
}
