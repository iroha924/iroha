import { createHmac } from "node:crypto";
import {
  type Clock,
  err,
  type IrohaError,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import { type Database, insertSessionToken, type SessionTokenPlatform } from "@iroha/storage";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The salt-keyed HMAC-SHA-256 of a plaintext token, in `hmac-sha256:<hex>` form
 * — the only representation of the token that is ever persisted (mcp-contract.md
 * §5). Verification (a later work package) recomputes this from the presented
 * token and looks it up; a leaked database alone yields no usable token.
 */
export function hashSessionToken(salt: Uint8Array, token: string): string {
  return `hmac-sha256:${createHmac("sha256", Buffer.from(salt)).update(token, "utf8").digest("hex")}`;
}

export interface IssueSessionTokenInput {
  db: Database;
  salt: Uint8Array;
  clock: Clock;
  random: RandomSource;
  repositoryId: TypedId<"repo">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  platform: SessionTokenPlatform;
}

/**
 * Mints a 256-bit `ist_<base64url>` session token, stores only its HMAC bound to
 * this repository/Session/Run/platform, and returns the plaintext token for the
 * agent's context. The plaintext is never logged or persisted.
 */
export async function issueSessionToken(
  input: IssueSessionTokenInput,
): Promise<Result<string, IrohaError>> {
  const token = `ist_${Buffer.from(input.random.bytes(TOKEN_BYTES)).toString("base64url")}`;
  const now = input.clock.now();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();

  const inserted = await insertSessionToken(input.db, {
    tokenHmac: hashSessionToken(input.salt, token),
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    runId: input.runId,
    platform: input.platform,
    issuedAt,
    lastUsedAt: issuedAt,
    expiresAt,
  });
  if (!inserted.ok) {
    return err(inserted.error);
  }
  return ok(token);
}
