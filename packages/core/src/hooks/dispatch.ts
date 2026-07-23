import { scanForSecrets } from "@iroha/canonical";
import { type Clock, makeTypedId, ok, type RandomSource, type TypedId } from "@iroha/domain";
import { type HeadState, readHeadState } from "@iroha/git";
import {
  contextOutput,
  continuationOutput,
  denyOutput,
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
  listApprovedRulesForRepository,
  listCheckpointsBySession,
  type SessionRunEndReason,
  type ToolEventTargetKind,
  touchAgentSessionLastSeen,
  updateTurnCheckpointState,
  withTransaction,
} from "@iroha/storage";
import type { ResolvedRepository } from "../resolve-repository.js";
import {
  type ApprovedKnowledgeItem,
  formatSessionContext,
  type RecentCheckpoint,
} from "./context.js";
import { evaluateActiveGuardrails } from "./guardrail.js";
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

/**
 * A branch name is chosen by whoever created the branch, and `git clone` names
 * the local branch after the remote's HEAD — so a hostile repository controls
 * this string. Git's own `check_refname_format` bans ASCII control characters
 * and space but permits any non-ASCII byte (U+00A0 among them) and, since `/`
 * is legal inside a ref name, a total length of several KB. `get_session_state`
 * returns this field to the model, where every other value is bounded, so it is
 * bounded here too — at the same 200 characters an entity title is cut to.
 */
const MAX_BRANCH_CHARS = 200;

/**
 * An iroha session token embedded anywhere in a string — `ist_` followed by 43
 * base64url characters, `sessionTokenSchema`'s shape without its anchors. The
 * shared `scanForSecrets` deliberately requires the token to be followed by a
 * non-token character (a canonical-write tradeoff, decision-log ID-050) so it
 * does not over-reject prose, which means a token glued to a suffix
 * (`…ist_<43>-work`) passes it. For a branch name that leniency is wrong: the
 * value is short opaque provenance, dropping it costs only a `NULL` (the same as
 * a detached HEAD), and a legitimate branch has no reason to carry a 43-char
 * token run — so here the token is dropped whatever follows it. A verbose branch
 * whose own words happen to spell `…ist_` + 43 identifier characters is dropped
 * too; that false-drop is an acceptable price for a best-effort annotation.
 */
const EMBEDDED_SESSION_TOKEN = /ist_[A-Za-z0-9_-]{43}/;

/**
 * HEAD as it stands for this hook invocation, or `null` when Git cannot answer
 * — an unborn HEAD, a Git failure, or no Git at all. Fail-open like the rest of
 * the hook path (hooks-contract.md §2/§7): the Run is still recorded, just
 * without the code state it acted on. A detached HEAD is not a failure; it
 * resolves to a sha with no branch.
 *
 * The branch name is bounded and then scanned before it can be stored: it is
 * the one unconstrained free-text value this path persists, and
 * `secure-subprocess-and-credentials.md` requires every such field to be
 * scanned before it reaches the at-rest store, local and disposable though it
 * is. A secret-shaped name (`ist_…` is a legal ref name — verified) is dropped
 * rather than blanked, which makes it indistinguishable from a detached HEAD;
 * that is the right trade for a rare case in a best-effort annotation. The scan
 * is fail-closed — an error drops the branch — and costs ~13ms cold, against a
 * §7 budget of 1.5s at the tightest calling event. A supplementary check drops
 * an embedded iroha token the shared scanner's canonical-tuned boundary lets
 * through (`EMBEDDED_SESSION_TOKEN`). The sha needs no scan: it has already been
 * checked against the object-id format.
 */
async function readHeadOrNull(ctx: HookDispatchContext): Promise<HeadState | null> {
  const head = await readHeadState(ctx.repo.gitLocation.root);
  if (!head.ok) {
    return null;
  }
  const { branch, sha } = head.value;
  if (branch === null) {
    return { sha, branch: null };
  }
  const bounded = branch.slice(0, MAX_BRANCH_CHARS);
  if (EMBEDDED_SESSION_TOKEN.test(bounded)) {
    return { sha, branch: null };
  }
  const scan = await scanForSecrets(bounded);
  return { sha, branch: scan.ok && scan.value.clean ? bounded : null };
}

/**
 * Closes a Run and, in the same transaction, the most recent Turn if it was
 * left open.
 *
 * A Turn still `active` when its Run is closed never reached its own Stop
 * (§6.6) — the work stopped without finishing — so it becomes `interrupted`,
 * never `completed`. Without this, a closed Run can contain a Turn that still
 * claims to be running, and nothing ever revisits it. `checkpoint_state` is
 * left untouched: `pending` on such a Turn is the accurate record that a
 * checkpoint was asked for and never saved.
 *
 * Only the most recent Turn is repaired. `handlePromptSubmitted` opens a Turn
 * per prompt without closing the previous one, so consecutive prompts with no
 * Stop between them can still leave an earlier Turn open — that is the prompt
 * path's own gap, not this one's, and is out of scope here.
 *
 * Fail-open: callers ignore the result, and a rolled-back transaction leaves
 * exactly the state that existed before.
 */
async function closeRunAndOpenTurn(
  ctx: HookDispatchContext,
  runId: TypedId<"run">,
  input: {
    to: "completed" | "interrupted";
    endedAt: string;
    endReason: SessionRunEndReason;
    headShaEnd?: string;
  },
): Promise<void> {
  await withTransaction(ctx.db, "write", async (tx) => {
    const run = await closeSessionRun(tx, runId, { from: "active", ...input });
    if (!run.ok) {
      return run;
    }
    const turn = await getLatestTurnForRun(tx, runId);
    if (!turn.ok) {
      return turn;
    }
    if (turn.value?.status === "active") {
      const closedTurn = await closeTurn(tx, turn.value.id, {
        from: "active",
        to: "interrupted",
        stoppedAt: input.endedAt,
      });
      if (!closedTurn.ok) {
        return closedTurn;
      }
    }
    return ok(undefined);
  });
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
      // No `headShaEnd`: HEAD now is where the *new* invocation starts, not
      // where the abandoned Run actually stopped, and inventing that is worse
      // than leaving it unknown.
      await closeRunAndOpenTurn(ctx, activeRun.value.id, {
        to: "interrupted",
        endedAt: now,
        endReason: "interrupted",
      });
    }
    // The branch and commit this Run acts on (dashboard-api.md §6): the only
    // link from a recorded session back to the code state it saw.
    const head = await readHeadOrNull(ctx);
    runId = makeTypedId("run", ctx.clock, ctx.random);
    const run = await insertSessionRun(ctx.db, {
      id: runId,
      sessionId,
      startSource: source === "compact" ? "startup" : source,
      cwdFingerprint: event.cwdFingerprint,
      ...(head?.branch ? { gitBranch: head.branch } : {}),
      ...(head === null ? {} : { headShaStart: head.sha }),
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
    const unresolved = formatUnresolvedItems(latest.unresolvedJson);
    recentCheckpoint = {
      id: latest.id,
      summary: latest.summary,
      ...(unresolved === undefined ? {} : { unresolved }),
    };
  }

  const approvedKnowledge = await buildApprovedKnowledge(ctx.db, repositoryId);

  return contextOutput(
    formatSessionContext({
      token: token.value,
      sessionId,
      runId,
      ...(approvedKnowledge.length === 0 ? {} : { approvedKnowledge }),
      ...(recentCheckpoint === undefined ? {} : { recentCheckpoint }),
    }),
  );
}

/** Bounds on the recovery `unresolved:` line so a large list cannot crowd out the rest of the context block. */
const MAX_UNRESOLVED_ITEMS = 10;
const MAX_UNRESOLVED_CHARS = 800;

/**
 * The last Checkpoint's unresolved items, rendered as a single bounded line for
 * the recovery context (hooks-contract.md §9). Returns `undefined` when there
 * are none, so a resumed session only shows work that actually remained open —
 * no summary is fabricated (vertical-slice.md §5). The output is length-capped
 * because `create_checkpoint` permits up to 100 items × 1000 chars, which would
 * otherwise truncate the whole 8,000-char block (`formatSessionContext`).
 */
function formatUnresolvedItems(unresolvedJson: string): string | undefined {
  try {
    const parsed = JSON.parse(unresolvedJson) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const items = parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (items.length === 0) {
      return undefined;
    }
    const joined = items.slice(0, MAX_UNRESOLVED_ITEMS).join("; ");
    return joined.length > MAX_UNRESOLVED_CHARS
      ? `${joined.slice(0, MAX_UNRESOLVED_CHARS)}…`
      : joined;
  } catch {
    return undefined;
  }
}

/** Approved Rules shown at SessionStart, oldest→newest (hooks-contract.md §9). No embedding — a direct list. */
const MAX_HOOK_KNOWLEDGE = 10;

function ruleProvenance(scopeJson: string): string {
  try {
    const scope = JSON.parse(scopeJson) as { paths?: unknown };
    const paths = Array.isArray(scope.paths)
      ? scope.paths.filter((path): path is string => typeof path === "string")
      : [];
    return paths.length > 0 ? `why: path ${paths[0]}` : "why: repository-wide";
  } catch {
    return "why: repository-wide";
  }
}

async function buildApprovedKnowledge(
  db: Database,
  repositoryId: TypedId<"repo">,
): Promise<ApprovedKnowledgeItem[]> {
  const listed = await listApprovedRulesForRepository(db, repositoryId);
  if (!listed.ok) {
    return [];
  }
  return listed.value.slice(0, MAX_HOOK_KNOWLEDGE).map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary ?? "",
    provenance: ruleProvenance(row.scopeJson),
  }));
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

  // Evaluate approved Guardrails over the resolved targets (hooks-contract.md
  // §6.3). Fail-open: a query failure or a corrupt spec yields no denial. A
  // matching Guardrail records the Tool Event as denied and returns a
  // deterministic deny with the Rule id and reason.
  const denial = await evaluateActiveGuardrails(ctx.db, ctx.repo.repositoryId, targets);

  // On a denial, record the target that actually violated the Guardrail (a patch
  // can touch several files); otherwise the first resolved target is representative.
  const auditTarget = denial === null ? targets[0] : denial.target;

  await insertToolEvent(ctx.db, {
    id: makeTypedId("evt", ctx.clock, ctx.random),
    turnId: turn.id,
    ...(event.payload.toolUseId === undefined
      ? {}
      : { externalToolUseId: event.payload.toolUseId }),
    toolName: event.payload.toolName,
    phase: denial === null ? "pre" : "denied",
    ...(auditTarget === undefined ? {} : { targetKind: auditTarget.kind as ToolEventTargetKind }),
    ...(auditTarget === undefined ? {} : { targetSummary: auditTarget.value }),
    ...(event.payload.inputDigest === undefined ? {} : { inputDigest: event.payload.inputDigest }),
    status: denial === null ? "started" : "denied",
    occurredAt: event.occurredAt,
  });

  return denial === null ? noOutput : denyOutput(denial.ruleId, denial.reason);
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
    const head = await readHeadOrNull(ctx);
    await closeRunAndOpenTurn(ctx, activeRun.value.id, {
      to: "completed",
      endedAt: ctx.clock.now().toISOString(),
      endReason: mapSessionEndReason(event.payload.reason),
      ...(head === null ? {} : { headShaEnd: head.sha }),
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
