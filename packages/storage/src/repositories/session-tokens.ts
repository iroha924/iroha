import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";

// `session_tokens` (migrations/002_session_tokens.sql). A SessionStart hook
// issues a 256-bit token to the agent; only its salt-keyed HMAC-SHA-256 digest
// is stored here, bound to one repository / Agent Session / Session Run /
// platform (implementation/design.md §9, mcp-contract.md §5). The MCP server
// (a later work package) reads and verifies it; this package exposes the write
// and read-back surface WP-06 needs.

export type SessionTokenPlatform = "claude_code" | "codex";

export interface SessionTokenRow {
  tokenHmac: string;
  repositoryId: TypedId<"repo">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  platform: SessionTokenPlatform;
  issuedAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface InsertSessionTokenInput {
  /** `hmac-sha256:<hex>` — the salt-keyed HMAC of the plaintext token, never the token itself. */
  tokenHmac: string;
  repositoryId: TypedId<"repo">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  platform: SessionTokenPlatform;
  issuedAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

function rowToSessionToken(row: Record<string, unknown>): SessionTokenRow {
  return {
    tokenHmac: String(row.token_hmac),
    repositoryId: row.repository_id as TypedId<"repo">,
    sessionId: row.session_id as TypedId<"ses">,
    runId: row.run_id as TypedId<"run">,
    platform: row.platform as SessionTokenPlatform,
    issuedAt: String(row.issued_at),
    lastUsedAt: String(row.last_used_at),
    expiresAt: String(row.expires_at),
  };
}

export async function insertSessionToken(
  db: Executor,
  input: InsertSessionTokenInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO session_tokens
        (token_hmac, repository_id, session_id, run_id, platform, issued_at, last_used_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.tokenHmac,
        input.repositoryId,
        input.sessionId,
        input.runId,
        input.platform,
        input.issuedAt,
        input.lastUsedAt,
        input.expiresAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert session token"));
  }
}

/** Looks up a token by its stored HMAC digest (the verification entry point). */
export async function getSessionToken(
  db: Executor,
  tokenHmac: string,
): Promise<Result<SessionTokenRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM session_tokens WHERE token_hmac = ?",
      args: [tokenHmac],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSessionToken(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read session token"));
  }
}
