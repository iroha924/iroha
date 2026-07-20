import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok } from "@iroha/domain";
import {
  getEntityById,
  getRelationByTuple,
  insertRelation,
  type RelationType,
} from "@iroha/storage";
import { runIdempotentWrite } from "./idempotency.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpLinkEntitiesData {
  relationId: TypedId<"rel">;
  deduplicated: boolean;
}

export interface McpLinkEntitiesInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  idempotencyKey: string;
  fromEntityId: string;
  relationType: RelationType;
  toEntityId: string;
  evidence: string;
  confidence: number;
}

const OPERATION = "link_entities";

function storedToData(responseJson: string): McpLinkEntitiesData {
  const parsed = JSON.parse(responseJson) as McpLinkEntitiesData;
  return { ...parsed, deduplicated: true };
}

/**
 * Creates a local inferred relation between two existing entities
 * (mcp-contract.md §6.8). A self-relation is rejected unless the type is
 * `RELATED_TO`, and both endpoints must already exist — this tool never invents
 * placeholder entities. The write is idempotent by `idempotencyKey`; the
 * underlying insert also de-duplicates the (from, type, to, source) tuple.
 */
export async function mcpLinkEntities(
  input: McpLinkEntitiesInput,
): Promise<Result<McpLinkEntitiesData, IrohaError>> {
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
      const { repositoryId } = verified.value;

      if (input.fromEntityId === input.toEntityId && input.relationType !== "RELATED_TO") {
        return err(
          new IrohaErrorClass("INVALID_INPUT", "self-relations are only allowed for RELATED_TO"),
        );
      }

      const from = await getEntityById(ctx.db, input.fromEntityId);
      if (!from.ok) {
        return err(from.error);
      }
      if (from.value === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "fromEntityId does not exist"));
      }
      const to = await getEntityById(ctx.db, input.toEntityId);
      if (!to.ok) {
        return err(to.error);
      }
      if (to.value === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "toEntityId does not exist"));
      }

      const relationId = makeTypedId("rel", ctx.clock, ctx.random);
      const nowIso = ctx.clock.now().toISOString();

      return runIdempotentWrite<McpLinkEntitiesData>({
        db: ctx.db,
        clock: ctx.clock,
        repositoryId,
        operation: OPERATION,
        idempotencyKey: input.idempotencyKey,
        fromStored: storedToData,
        // A relation id is not an `entities` row, so it is not stored as the
        // idempotency record's `result_entity_id` (which FKs `entities`).
        toStored: (data) => ({ responseJson: JSON.stringify(data) }),
        work: async (tx) => {
          const relation = await insertRelation(tx, {
            id: relationId,
            repositoryId,
            fromEntityId: input.fromEntityId,
            relationType: input.relationType,
            toEntityId: input.toEntityId,
            sourceKind: "inferred",
            sourceRef: input.evidence,
            confidence: input.confidence,
            createdAt: nowIso,
          });
          if (!relation.ok) {
            return err(relation.error);
          }
          // `insertRelation` is ON CONFLICT DO NOTHING: if this (from, type, to,
          // inferred) tuple already existed under a different call, our generated
          // id was not stored. Return the id actually on record, never a phantom.
          const stored = await getRelationByTuple(
            tx,
            input.fromEntityId,
            input.relationType,
            input.toEntityId,
            "inferred",
          );
          if (!stored.ok) {
            return err(stored.error);
          }
          return ok({ relationId: stored.value?.id ?? relationId, deduplicated: false });
        },
      });
    },
  );
}
