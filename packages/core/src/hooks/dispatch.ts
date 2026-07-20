import { type Clock, makeTypedId, type RandomSource, type TypedId } from "@iroha/domain";
import {
  contextOutput,
  continuationOutput,
  type HookOutput,
  type NormalizedEvent,
  noOutput,
  type ToolTarget,
} from "@iroha/platform";
import {
  closeSessionRun,
  closeTurn,
  type Database,
  getActiveSessionRunForSession,
  getAgentSessionByPlatformIdentity,
  getLatestTurnForRun,
  insertAgentSession,
  insertEntity,
  insertSessionRun,
  insertToolEvent,
  insertTurn,
  listCheckpointsBySession,
  type SessionRunEndReason,
  type ToolEventTargetKind,
  touchAgentSessionLastSeen,
  updateTurnCheckpointState,
} from "@iroha/storage";
import type { ResolvedRepository } from "../resolve-repository.js";
import { formatSessionContext, type RecentCheckpoint } from "./context.js";
import { resolveTargets } from "./resolve-targets.js";
import { issueSessionToken } from "./session-token.js";

export interface HookDispatchContext {
  db: Database;
  repo: ResolvedRepository;
  /** The agent's working directory — the base for resolving relative tool-target paths. */
  cwd: string;
  salt: Uint8Array;
  clock: Clock;
  random: RandomSource;
}

type EventOf<K extends NormalizedEvent["kind"]> = Extract<NormalizedEvent, { kind: K }>;

/** Resolve the iroha Agent Session id for the platform session, or `null` if none exists yet. */
async function resolveSessionId(
  ctx: HookDispatchContext,
  platform: NormalizedEvent["platform"],
  platformSessionId: string,
): Promise<TypedId<"ses"> | null> {
  const found = await getAgentSessionByPlatformIdentity(
    ctx.db,
    ctx.repo.repositoryId,
    platform,
    platformSessionId,
  );
  return found.ok && found.value ? found.value.id : null;
}

async function handleSessionStart(
  event: EventOf<"SESSION_STARTED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const now = ctx.clock.now().toISOString();
  const repositoryId = ctx.repo.repositoryId;
  const platform = event.platform;

  // Map platform session to an Agent Session, creating one on first sight.
  const existing = await getAgentSessionByPlatformIdentity(
    ctx.db,
    repositoryId,
    platform,
    event.platformSessionId,
  );
  if (!existing.ok) {
    return noOutput;
  }
  let sessionId: TypedId<"ses">;
  if (existing.value) {
    sessionId = existing.value.id;
    await touchAgentSessionLastSeen(ctx.db, sessionId, now);
  } else {
    sessionId = makeTypedId("ses", ctx.clock, ctx.random);
    const entity = await insertEntity(ctx.db, {
      id: sessionId,
      repositoryId,
      entityType: "session",
      title: "Agent session",
      status: "active",
      authority: 60,
      sourceKind: "hook",
      createdAt: now,
      updatedAt: now,
    });
    if (!entity.ok) {
      return noOutput;
    }
    const session = await insertAgentSession(ctx.db, {
      id: sessionId,
      repositoryId,
      platform,
      platformSessionId: event.platformSessionId,
      startedAt: now,
      lastSeenAt: now,
    });
    if (!session.ok) {
      return noOutput;
    }
  }

  // Repair a stale active Run as interrupted, then start a new Run. A `compact`
  // start keeps the current Run (design.md §8: resume creates a Run; compact
  // does not).
  const activeRun = await getActiveSessionRunForSession(ctx.db, sessionId);
  const source = event.payload.source;
  let runId: TypedId<"run">;
  if (source === "compact" && activeRun.ok && activeRun.value) {
    runId = activeRun.value.id;
  } else {
    if (activeRun.ok && activeRun.value) {
      await closeSessionRun(ctx.db, activeRun.value.id, {
        from: "active",
        to: "interrupted",
        endedAt: now,
        endReason: "interrupted",
      });
    }
    runId = makeTypedId("run", ctx.clock, ctx.random);
    const run = await insertSessionRun(ctx.db, {
      id: runId,
      sessionId,
      startSource: source === "compact" ? "startup" : source,
      cwdFingerprint: event.cwdFingerprint,
      startedAt: now,
    });
    if (!run.ok) {
      return noOutput;
    }
  }

  const token = await issueSessionToken({
    db: ctx.db,
    salt: ctx.salt,
    clock: ctx.clock,
    random: ctx.random,
    repositoryId,
    sessionId,
    runId,
    platform,
  });
  if (!token.ok) {
    return noOutput;
  }

  let recentCheckpoint: RecentCheckpoint | undefined;
  const checkpoints = await listCheckpointsBySession(ctx.db, sessionId, 1);
  if (checkpoints.ok && checkpoints.value[0]) {
    const latest = checkpoints.value[0];
    recentCheckpoint = { id: latest.id, summary: latest.summary };
  }

  return contextOutput(
    formatSessionContext({
      token: token.value,
      sessionId,
      runId,
      ...(recentCheckpoint === undefined ? {} : { recentCheckpoint }),
    }),
  );
}

async function handlePromptSubmitted(
  event: EventOf<"PROMPT_SUBMITTED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const sessionId = await resolveSessionId(ctx, event.platform, event.platformSessionId);
  if (sessionId === null) {
    return noOutput;
  }
  const activeRun = await getActiveSessionRunForSession(ctx.db, sessionId);
  if (!activeRun.ok || !activeRun.value) {
    return noOutput;
  }
  await insertTurn(ctx.db, {
    id: makeTypedId("trn", ctx.clock, ctx.random),
    runId: activeRun.value.id,
    ...(event.platformTurnId === undefined ? {} : { externalTurnId: event.platformTurnId }),
    promptDigest: event.payload.promptDigest,
    startedAt: ctx.clock.now().toISOString(),
  });
  // No context injected here in v0.1: retrieval is WP-08's search layer.
  return noOutput;
}

/** The current Turn of the session's active Run, or `null` if there is none. */
async function currentTurn(ctx: HookDispatchContext, sessionId: TypedId<"ses">) {
  const activeRun = await getActiveSessionRunForSession(ctx.db, sessionId);
  if (!activeRun.ok || !activeRun.value) {
    return null;
  }
  const turn = await getLatestTurnForRun(ctx.db, activeRun.value.id);
  return turn.ok ? turn.value : null;
}

async function handleToolStarted(
  event: EventOf<"TOOL_STARTED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const sessionId = await resolveSessionId(ctx, event.platform, event.platformSessionId);
  if (sessionId === null) {
    return noOutput;
  }
  const turn = await currentTurn(ctx, sessionId);
  if (turn === null) {
    return noOutput;
  }
  const targets = await resolveTargets(event.payload.targets, ctx.repo.gitLocation.root, ctx.cwd);
  const primary = targets[0];
  await insertToolEvent(ctx.db, {
    id: makeTypedId("evt", ctx.clock, ctx.random),
    turnId: turn.id,
    ...(event.payload.toolUseId === undefined
      ? {}
      : { externalToolUseId: event.payload.toolUseId }),
    toolName: event.payload.toolName,
    phase: "pre",
    ...(primary === undefined ? {} : { targetKind: primary.kind as ToolEventTargetKind }),
    ...(primary === undefined ? {} : { targetSummary: primary.value }),
    ...(event.payload.inputDigest === undefined ? {} : { inputDigest: event.payload.inputDigest }),
    status: "started",
    occurredAt: event.occurredAt,
  });

  // Guardrail evaluation seam: no active Guardrail can match yet — a machine
  // guard spec has no schema in this repository (decision-log ID-024(6)), so no
  // Guardrail is authorable/active. When one exists, a deterministic scope match
  // over `targets` returns `denyOutput(ruleId, reason)` here.
  return noOutput;
}

/** A tool use is "meaningful" (checkpoint-worthy) when it mutates files or runs a command. */
function isMeaningfulMutation(targets: readonly ToolTarget[]): boolean {
  return targets.some(
    (t) => t.operation === "write" || t.operation === "delete" || t.kind === "command",
  );
}

async function handleToolCompleted(
  event: EventOf<"TOOL_COMPLETED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const sessionId = await resolveSessionId(ctx, event.platform, event.platformSessionId);
  if (sessionId === null) {
    return noOutput;
  }
  const turn = await currentTurn(ctx, sessionId);
  if (turn === null) {
    return noOutput;
  }
  const targets = await resolveTargets(event.payload.targets, ctx.repo.gitLocation.root, ctx.cwd);
  const primary = targets[0];
  await insertToolEvent(ctx.db, {
    id: makeTypedId("evt", ctx.clock, ctx.random),
    turnId: turn.id,
    ...(event.payload.toolUseId === undefined
      ? {}
      : { externalToolUseId: event.payload.toolUseId }),
    toolName: event.payload.toolName,
    phase: "post",
    ...(primary === undefined ? {} : { targetKind: primary.kind as ToolEventTargetKind }),
    ...(primary === undefined ? {} : { targetSummary: primary.value }),
    ...(event.payload.inputDigest === undefined ? {} : { inputDigest: event.payload.inputDigest }),
    ...(event.payload.responseDigest === undefined
      ? {}
      : { responseDigest: event.payload.responseDigest }),
    status: "succeeded",
    ...(event.payload.durationMs === undefined ? {} : { durationMs: event.payload.durationMs }),
    occurredAt: event.occurredAt,
  });

  if (isMeaningfulMutation(targets) && turn.checkpointState === "not_required") {
    await updateTurnCheckpointState(ctx.db, turn.id, "pending");
  }
  return noOutput;
}

const CONTINUATION_REASON =
  "Save an iroha checkpoint with the create_checkpoint MCP tool, then finish. " +
  "Include implementation, validation, decisions, and unresolved items. " +
  "Do not invent work that did not occur.";

async function handleStop(
  event: EventOf<"TURN_STOPPED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const sessionId = await resolveSessionId(ctx, event.platform, event.platformSessionId);
  if (sessionId === null) {
    return noOutput;
  }
  const turn = await currentTurn(ctx, sessionId);
  if (turn === null) {
    return noOutput;
  }

  // Ask for a checkpoint exactly once: the Turn needs one (pending) and this is
  // not already a continuation retry (hooks-contract.md §6.6 step 3). The Turn
  // stays active so the agent can still save it.
  if (turn.checkpointState === "pending" && !event.payload.stopHookActive) {
    return continuationOutput(CONTINUATION_REASON);
  }

  // Otherwise the Turn ends now (§6.6 steps 1/2/4: no checkpoint required, one
  // was already saved, or we are allowing the stop after the single
  // continuation). Complete it if still active (database-schema.md §7).
  if (turn.status === "active") {
    await closeTurn(ctx.db, turn.id, {
      from: "active",
      to: "completed",
      stoppedAt: ctx.clock.now().toISOString(),
    });
  }
  return noOutput;
}

const SESSION_END_REASONS: ReadonlySet<SessionRunEndReason> = new Set([
  "clear",
  "logout",
  "prompt_input_exit",
  "other",
]);

function mapSessionEndReason(reason: string): SessionRunEndReason {
  return (SESSION_END_REASONS as ReadonlySet<string>).has(reason)
    ? (reason as SessionRunEndReason)
    : "other";
}

async function handleSessionEnd(
  event: EventOf<"SESSION_ENDED">,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  const sessionId = await resolveSessionId(ctx, event.platform, event.platformSessionId);
  if (sessionId === null) {
    return noOutput;
  }
  const activeRun = await getActiveSessionRunForSession(ctx.db, sessionId);
  if (activeRun.ok && activeRun.value) {
    await closeSessionRun(ctx.db, activeRun.value.id, {
      from: "active",
      to: "completed",
      endedAt: ctx.clock.now().toISOString(),
      endReason: mapSessionEndReason(event.payload.reason),
    });
  }
  return noOutput;
}

/**
 * Run the use case for one normalized event and return what, if anything, the
 * hook should emit. Events with no v0.1 use case (compaction, and any P1/P2
 * kind an adapter still produced) are recorded implicitly by their upstream
 * lifecycle and need no output.
 */
export async function dispatchHookEvent(
  event: NormalizedEvent,
  ctx: HookDispatchContext,
): Promise<HookOutput> {
  switch (event.kind) {
    case "SESSION_STARTED":
      return handleSessionStart(event, ctx);
    case "PROMPT_SUBMITTED":
      return handlePromptSubmitted(event, ctx);
    case "TOOL_STARTED":
      return handleToolStarted(event, ctx);
    case "TOOL_COMPLETED":
      return handleToolCompleted(event, ctx);
    case "TURN_STOPPED":
      return handleStop(event, ctx);
    case "SESSION_ENDED":
      return handleSessionEnd(event, ctx);
    default:
      return noOutput;
  }
}
