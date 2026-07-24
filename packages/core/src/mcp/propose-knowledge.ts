import type {
  Clock,
  IrohaError,
  KnowledgeProposal,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok } from "@iroha/domain";
import {
  type CandidateRow,
  type Executor,
  getCandidateById,
  getCheckpointById,
  insertCandidate,
  listCandidatesByType,
  updateCandidateStatus,
} from "@iroha/storage";
import { runIdempotentWrite } from "./idempotency.js";
import { type FieldRedaction, redactProposal } from "./redact.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpProposeKnowledgeData {
  candidateId: TypedId<"cand">;
  redactions: FieldRedaction[];
  deduplicated: boolean;
  /**
   * Existing pending/approved candidates of the same type whose title matches
   * this proposal's (mcp-contract.md §6.7: "a likely duplicate returns a warning
   * and related IDs; it does not silently merge"). Advisory only — the new
   * candidate is always created regardless.
   */
  duplicateCandidateIds: TypedId<"cand">[];
}

export interface McpProposeKnowledgeInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  idempotencyKey: string;
  proposal: KnowledgeProposal;
  sourceCheckpointId?: string | undefined;
  supersedesCandidateId?: string | undefined;
}

const OPERATION = "propose_knowledge";

function storedToData(responseJson: string): McpProposeKnowledgeData {
  const parsed = JSON.parse(responseJson) as McpProposeKnowledgeData;
  return { ...parsed, deduplicated: true };
}

/**
 * Collapse a proposal title to a duplicate-detection key: lowercase and collapse
 * whitespace. Two proposals with the same title (case/spacing aside) map to the
 * same key. Deliberately title-only and conservative — a false positive only
 * emits an advisory warning, never blocks or merges.
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * From `candidates` (already the same type as the proposal), the ones whose
 * title matches `title` (normalized), excluding `excludeId` (the candidate being
 * superseded). Any status — a duplicate a human already rejected is still worth
 * surfacing.
 */
function findDuplicateCandidateIds(
  candidates: CandidateRow[],
  title: string,
  excludeId: string | undefined,
): TypedId<"cand">[] {
  const key = normalizeTitle(title);
  const duplicates: TypedId<"cand">[] = [];
  for (const candidate of candidates) {
    if (candidate.id === excludeId) {
      continue;
    }
    let candidateTitle: unknown;
    try {
      candidateTitle = (JSON.parse(candidate.payloadJson) as { title?: unknown }).title;
    } catch {
      // A stored payload is written by this codebase and CHECK-constrained to
      // valid JSON; a parse failure here is not actionable, so skip the row.
      continue;
    }
    if (typeof candidateTitle === "string" && normalizeTitle(candidateTitle) === key) {
      duplicates.push(candidate.id);
    }
  }
  return duplicates;
}

/**
 * Resolves the candidate that this proposal supersedes and transitions it to
 * `superseded` (state machine: `pending`/`approved` → `superseded`). Runs inside
 * the write transaction so the supersession and the new candidate insert commit
 * atomically. The revision token is read here (not before the transaction) to
 * avoid a TOCTOU against a concurrent reviewer.
 */
async function supersedePriorCandidate(
  tx: Executor,
  supersedesCandidateId: string,
  nowIso: string,
  random: RandomSource,
): Promise<Result<void, IrohaError>> {
  const prior = await getCandidateById(tx, supersedesCandidateId as TypedId<"cand">);
  if (!prior.ok) {
    return err(prior.error);
  }
  if (prior.value === null) {
    return err(new IrohaErrorClass("INVALID_INPUT", "supersedesCandidateId does not exist"));
  }
  const newRevisionToken = Buffer.from(random.bytes(16)).toString("base64url");
  return updateCandidateStatus(tx, prior.value.id, {
    from: prior.value.status,
    to: "superseded",
    expectedRevisionToken: prior.value.revisionToken,
    newRevisionToken,
    reviewedAt: nowIso,
  });
}

/**
 * Creates one pending knowledge candidate outside a Checkpoint (mcp-contract.md
 * §6.7). Never writes `.iroha/` — the candidate stays local and pending until a
 * human approves it. Free-text proposal fields are secret-scanned and redacted;
 * the write is idempotent by `idempotencyKey`. When `supersedesCandidateId` is
 * given, the prior candidate is transitioned to `superseded` in the same
 * transaction; likely duplicates (same type + title) are reported in
 * `duplicateCandidateIds` without blocking or merging.
 */
export async function mcpProposeKnowledge(
  input: McpProposeKnowledgeInput,
): Promise<Result<McpProposeKnowledgeData, IrohaError>> {
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
      const { repositoryId, sessionId } = verified.value;

      if (input.sourceCheckpointId !== undefined) {
        const checkpoint = await getCheckpointById(
          ctx.db,
          input.sourceCheckpointId as TypedId<"chk">,
        );
        if (!checkpoint.ok) {
          return err(checkpoint.error);
        }
        if (checkpoint.value === null) {
          return err(new IrohaErrorClass("INVALID_INPUT", "sourceCheckpointId does not exist"));
        }
      }

      const redacted = await redactProposal(input.proposal, "proposal");
      if (!redacted.ok) {
        return err(redacted.error);
      }

      const candidateId = makeTypedId("cand", ctx.clock, ctx.random);
      const nowIso = ctx.clock.now().toISOString();

      return runIdempotentWrite<McpProposeKnowledgeData>({
        db: ctx.db,
        clock: ctx.clock,
        repositoryId,
        operation: OPERATION,
        idempotencyKey: input.idempotencyKey,
        fromStored: storedToData,
        // A candidate id is not an `entities` row, so it is not stored as the
        // idempotency record's `result_entity_id` (which FKs `entities`).
        toStored: (data) => ({ responseJson: JSON.stringify(data) }),
        work: async (tx) => {
          // Detect duplicates against the pre-insert snapshot, excluding the
          // candidate we are about to supersede.
          const existing = await listCandidatesByType(tx, repositoryId, input.proposal.type);
          if (!existing.ok) {
            return err(existing.error);
          }
          const duplicateCandidateIds = findDuplicateCandidateIds(
            existing.value,
            redacted.value.proposal.title,
            input.supersedesCandidateId,
          );

          const revisionToken = Buffer.from(ctx.random.bytes(16)).toString("base64url");
          const candidate = await insertCandidate(tx, {
            id: candidateId,
            repositoryId,
            candidateType: input.proposal.type,
            payloadJson: JSON.stringify(redacted.value.proposal),
            sourceSessionId: sessionId,
            ...(input.sourceCheckpointId !== undefined
              ? { sourceCheckpointId: input.sourceCheckpointId as TypedId<"chk"> }
              : {}),
            ...(input.proposal.confidence !== undefined
              ? { confidence: input.proposal.confidence }
              : {}),
            revisionToken,
            createdAt: nowIso,
          });
          if (!candidate.ok) {
            return err(candidate.error);
          }

          if (input.supersedesCandidateId !== undefined) {
            const superseded = await supersedePriorCandidate(
              tx,
              input.supersedesCandidateId,
              nowIso,
              ctx.random,
            );
            if (!superseded.ok) {
              return err(superseded.error);
            }
          }

          return ok({
            candidateId,
            redactions: redacted.value.redactions,
            deduplicated: false,
            duplicateCandidateIds,
          });
        },
      });
    },
  );
}
