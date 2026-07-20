import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import {
  type CheckpointOutcome,
  getLatestTurnForRun,
  getSessionRunById,
  listCheckpointsBySession,
} from "@iroha/storage";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpCheckpointSummary {
  id: TypedId<"chk">;
  outcome: CheckpointOutcome;
  summary: string;
  createdAt: string;
}

/**
 * The caller's own local session state (mcp-contract.md §6.4). Excludes raw
 * prompt and tool contents by construction — only structured lifecycle IDs,
 * the last Checkpoint's summary, and its recorded unresolved/reference items
 * are exposed.
 */
export interface McpSessionState {
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  turnId: TypedId<"trn"> | null;
  branch: string | null;
  startSha: string | null;
  lastCheckpoint: McpCheckpointSummary | null;
  pendingCheckpoint: boolean;
  unresolved: string[];
  issueRefs: string[];
  prRefs: string[];
}

export interface McpGetSessionStateInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
}

/** Parses a stored JSON string column, degrading to `[]` on any malformed value. */
function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function checkpointRefsOfType(referencesJson: string, type: "issue" | "pull_request"): string[] {
  const refs: string[] = [];
  for (const entry of parseJsonArray(referencesJson)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === type &&
      typeof (entry as { ref?: unknown }).ref === "string"
    ) {
      refs.push((entry as { ref: string }).ref);
    }
  }
  return refs;
}

export async function mcpGetSessionState(
  input: McpGetSessionStateInput,
): Promise<Result<McpSessionState, IrohaError>> {
  return withMcpRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const verified = await verifySessionToken({
        db: ctx.db,
        salt: ctx.salt,
        repositoryId: ctx.repo.repositoryId,
        clock: ctx.clock,
        token: input.sessionToken,
      });
      if (!verified.ok) {
        return verified;
      }
      const session = verified.value;

      const run = await getSessionRunById(ctx.db, session.runId);
      if (!run.ok) {
        return err(run.error);
      }
      const runRow = run.value;

      const latestTurn = await getLatestTurnForRun(ctx.db, session.runId);
      if (!latestTurn.ok) {
        return err(latestTurn.error);
      }
      const turn = latestTurn.value;

      const checkpoints = await listCheckpointsBySession(ctx.db, session.sessionId, 1);
      if (!checkpoints.ok) {
        return err(checkpoints.error);
      }
      const last = checkpoints.value[0] ?? null;

      const lastCheckpoint: McpCheckpointSummary | null =
        last === null
          ? null
          : {
              id: last.id,
              outcome: last.outcome,
              summary: last.summary,
              createdAt: last.createdAt,
            };
      const unresolved =
        last === null
          ? []
          : parseJsonArray(last.unresolvedJson).filter(
              (item): item is string => typeof item === "string",
            );
      const issueRefs = last === null ? [] : checkpointRefsOfType(last.referencesJson, "issue");
      const prRefs = last === null ? [] : checkpointRefsOfType(last.referencesJson, "pull_request");

      return ok({
        sessionId: session.sessionId,
        runId: session.runId,
        turnId: turn?.id ?? null,
        branch: runRow?.gitBranch ?? null,
        startSha: runRow?.headShaStart ?? null,
        lastCheckpoint,
        pendingCheckpoint: turn?.checkpointState === "pending",
        unresolved,
        issueRefs,
        prRefs,
      });
    },
  );
}
