import type {
  Clock,
  IrohaError,
  KnowledgeProposal,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok } from "@iroha/domain";
import { getCheckpointById, insertCandidate } from "@iroha/storage";
import { runIdempotentWrite } from "./idempotency.js";
import { type FieldRedaction, redactProposal } from "./redact.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpProposeKnowledgeData {
  candidateId: TypedId<"cand">;
  redactions: FieldRedaction[];
  deduplicated: boolean;
}

export interface McpProposeKnowledgeInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  idempotencyKey: string;
  proposal: KnowledgeProposal;
  sourceCheckpointId?: string | undefined;
}

const OPERATION = "propose_knowledge";

function storedToData(responseJson: string): McpProposeKnowledgeData {
  const parsed = JSON.parse(responseJson) as McpProposeKnowledgeData;
  return { ...parsed, deduplicated: true };
}

/**
 * Creates one pending knowledge candidate outside a Checkpoint (mcp-contract.md
 * §6.7). Never writes `.iroha/` — the candidate stays local and pending until a
 * human approves it. Free-text proposal fields are secret-scanned and redacted;
 * the write is idempotent by `idempotencyKey`.
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
          return ok({ candidateId, redactions: redacted.value.redactions, deduplicated: false });
        },
      });
    },
  );
}
