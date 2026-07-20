import { fileURLToPath } from "node:url";
import type { Clock, RandomSource, TypedId } from "@iroha/domain";
import { makeTypedId } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import {
  type Database,
  insertAgentSession,
  insertEntity,
  insertSessionRun,
  insertTurn,
} from "@iroha/storage";
import { runInit } from "../commands.js";
import { issueSessionToken } from "../hooks/session-token.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { createTempGitRepo } from "./tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

export interface McpTestRepo {
  repoDir: string;
  repositoryId: TypedId<"repo">;
  dbPath: string;
  irohaStateDir: string;
  salt: Uint8Array;
}

/**
 * Creates a temp Git repo, runs `iroha init` (creating and migrating the local
 * DB), and returns the resolved identity plus salt — the shared fixture for the
 * MCP use-case tests. Callers open their own DB connection to seed rows, then
 * call the use-case (which opens its own connection against the same file).
 * Clean up with `removeTempDir(repoDir)`.
 */
export async function setupMcpRepo(random: RandomSource): Promise<McpTestRepo> {
  const repoDir = await createTempGitRepo();
  const init = await runInit(repoDir, MIGRATIONS_DIR);
  if (!init.ok) {
    throw new Error(`init failed: ${init.error.code}: ${init.error.message}`);
  }
  const resolved = await resolveInitializedRepository(repoDir);
  if (!resolved.ok) {
    throw new Error(`resolve failed: ${resolved.error.code}: ${resolved.error.message}`);
  }
  const salt = await ensureRepositorySalt(resolved.value.irohaStateDir, random);
  if (!salt.ok) {
    throw new Error(`salt failed: ${salt.error.code}: ${salt.error.message}`);
  }
  return {
    repoDir,
    repositoryId: resolved.value.repositoryId,
    dbPath: resolved.value.dbPath,
    irohaStateDir: resolved.value.irohaStateDir,
    salt: salt.value,
  };
}

export interface SeededSession {
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  turnId: TypedId<"trn">;
  token: string;
}

/**
 * Seeds a session entity, agent session, run, and active turn against `db`, then
 * issues a real session token for them — the shared fixture for the MCP
 * write-tool use-case tests. Throws on any storage failure.
 */
export async function seedSessionWithToken(
  db: Database,
  repo: McpTestRepo,
  clock: Clock,
  random: RandomSource,
): Promise<SeededSession> {
  const sessionId = makeTypedId("ses", clock, random);
  const runId = makeTypedId("run", clock, random);
  const turnId = makeTypedId("trn", clock, random);
  const iso = clock.now().toISOString();

  const entity = await insertEntity(db, {
    id: sessionId,
    repositoryId: repo.repositoryId,
    entityType: "session",
    title: "Agent session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: iso,
    updatedAt: iso,
  });
  if (!entity.ok) {
    throw new Error(`seed entity: ${entity.error.code}`);
  }
  const session = await insertAgentSession(db, {
    id: sessionId,
    repositoryId: repo.repositoryId,
    platform: "claude_code",
    startedAt: iso,
    lastSeenAt: iso,
  });
  if (!session.ok) {
    throw new Error(`seed session: ${session.error.code}`);
  }
  const run = await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: "cwd-fp",
    startedAt: iso,
  });
  if (!run.ok) {
    throw new Error(`seed run: ${run.error.code}`);
  }
  const turn = await insertTurn(db, { id: turnId, runId, startedAt: iso });
  if (!turn.ok) {
    throw new Error(`seed turn: ${turn.error.code}`);
  }
  const token = await issueSessionToken({
    db,
    salt: repo.salt,
    clock,
    random,
    repositoryId: repo.repositoryId,
    sessionId,
    runId,
    platform: "claude_code",
  });
  if (!token.ok) {
    throw new Error(`seed token: ${token.error.code}`);
  }
  return { sessionId, runId, turnId, token: token.value };
}
