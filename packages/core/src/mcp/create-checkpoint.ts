import type {
  CheckpointInput,
  Clock,
  IrohaError,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok } from "@iroha/domain";
import {
  type Executor,
  getEntityById,
  getLatestTurnForRun,
  getTurnById,
  insertCandidate,
  insertCheckpoint,
  insertEntity,
  insertRelation,
  updateTurnCheckpointState,
} from "@iroha/storage";
import { runIdempotentWrite } from "./idempotency.js";
import { type FieldRedaction, redactField, redactProposal, redactReference } from "./redact.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpCreateCheckpointData {
  checkpointId: TypedId<"chk">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  turnId?: TypedId<"trn"> | undefined;
  candidateIds: TypedId<"cand">[];
  redactions: FieldRedaction[];
  deduplicated: boolean;
}

export interface McpCreateCheckpointInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  input: CheckpointInput;
}

const OPERATION = "create_checkpoint";

interface RedactedCheckpoint {
  objective: string;
  summary: string;
  implementation: CheckpointInput["implementation"];
  validation: CheckpointInput["validation"];
  unresolved: string[];
  references: CheckpointInput["references"];
  proposals: CheckpointInput["proposals"];
  redactions: FieldRedaction[];
}

/** Scans and redacts every free-text checkpoint/proposal field (mcp-contract.md §6.6 step 2). */
async function redactCheckpoint(
  input: CheckpointInput,
): Promise<Result<RedactedCheckpoint, IrohaError>> {
  const redactions: FieldRedaction[] = [];

  const objective = await redactField("objective", input.objective);
  if (!objective.ok) {
    return err(objective.error);
  }
  if (objective.value.redaction) {
    redactions.push(objective.value.redaction);
  }

  const summary = await redactField("summary", input.summary);
  if (!summary.ok) {
    return err(summary.error);
  }
  if (summary.value.redaction) {
    redactions.push(summary.value.redaction);
  }

  const implementation: CheckpointInput["implementation"] = [];
  for (const [index, item] of input.implementation.entries()) {
    const change = await redactField(`implementation[${index}].change`, item.change);
    if (!change.ok) {
      return err(change.error);
    }
    if (change.value.redaction) {
      redactions.push(change.value.redaction);
    }
    const next = { ...item, change: change.value.value };
    if (item.symbol !== undefined) {
      const symbol = await redactField(`implementation[${index}].symbol`, item.symbol);
      if (!symbol.ok) {
        return err(symbol.error);
      }
      if (symbol.value.redaction) {
        redactions.push(symbol.value.redaction);
      }
      next.symbol = symbol.value.value;
    }
    // `file` is a `relativePath` (checkpoint.ts) — same unconstrained free-text
    // class as `change`/`symbol` here and `scope.paths` in a proposal, so it is
    // scanned too rather than passed through verbatim.
    if (item.file !== undefined) {
      const file = await redactField(`implementation[${index}].file`, item.file);
      if (!file.ok) {
        return err(file.error);
      }
      if (file.value.redaction) {
        redactions.push(file.value.redaction);
      }
      next.file = file.value.value;
    }
    implementation.push(next);
  }

  const validation: CheckpointInput["validation"] = [];
  for (const [index, item] of input.validation.entries()) {
    const next = { ...item };
    if (item.command !== undefined) {
      const command = await redactField(`validation[${index}].command`, item.command);
      if (!command.ok) {
        return err(command.error);
      }
      if (command.value.redaction) {
        redactions.push(command.value.redaction);
      }
      next.command = command.value.value;
    }
    if (item.note !== undefined) {
      const note = await redactField(`validation[${index}].note`, item.note);
      if (!note.ok) {
        return err(note.error);
      }
      if (note.value.redaction) {
        redactions.push(note.value.redaction);
      }
      next.note = note.value.value;
    }
    validation.push(next);
  }

  const unresolved: string[] = [];
  for (const [index, item] of input.unresolved.entries()) {
    const value = await redactField(`unresolved[${index}]`, item);
    if (!value.ok) {
      return err(value.error);
    }
    if (value.value.redaction) {
      redactions.push(value.value.redaction);
    }
    unresolved.push(value.value.value);
  }

  const references: CheckpointInput["references"] = [];
  for (const [index, reference] of input.references.entries()) {
    const result = await redactReference(reference, `references[${index}]`);
    if (!result.ok) {
      return err(result.error);
    }
    references.push(result.value.reference);
    redactions.push(...result.value.redactions);
  }

  const proposals: CheckpointInput["proposals"] = [];
  for (const [index, proposal] of input.proposals.entries()) {
    const result = await redactProposal(proposal, `proposals[${index}]`);
    if (!result.ok) {
      return err(result.error);
    }
    proposals.push(result.value.proposal);
    redactions.push(...result.value.redactions);
  }

  return ok({
    objective: objective.value.value,
    summary: summary.value.value,
    implementation,
    validation,
    unresolved,
    references,
    proposals,
    redactions,
  });
}

function storedToData(responseJson: string): McpCreateCheckpointData {
  const parsed = JSON.parse(responseJson) as McpCreateCheckpointData;
  return { ...parsed, deduplicated: true };
}

/**
 * Materializes a checkpoint's `references[]` as graph edges (mcp-contract.md
 * §6.6 step 6). Resolve-only, matching how canonical `relations[]` are imported
 * (`sync-canonical.ts` `insertCanonicalDocumentRelations`) and how forge sync
 * links work items: a `ref` that resolves to an existing entity becomes a
 * `checkpoint RELATED_TO entity` edge (`source_kind = 'inferred'`); a `ref` that
 * names no known entity is left recorded on the checkpoint but not linked — this
 * tool never invents placeholder entities (§6.8). The reference `type` is not
 * modeled as the relation type: a checkpoint referencing an artifact does not
 * assert a specific semantic (ADDRESSES/AFFECTS/…), so the honest edge is the
 * generic `RELATED_TO`. Duplicate edges (the same entity referenced twice, or a
 * retried checkpoint) collapse via `insertRelation`'s `ON CONFLICT DO NOTHING`.
 */
async function materializeReferenceRelations(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  checkpointId: TypedId<"chk">,
  references: CheckpointInput["references"],
  nowIso: string,
  clock: Clock,
  random: RandomSource,
): Promise<Result<void, IrohaError>> {
  for (const reference of references) {
    const target = await getEntityById(tx, reference.ref);
    if (!target.ok) {
      return err(target.error);
    }
    if (target.value === null) {
      continue;
    }
    const inserted = await insertRelation(tx, {
      id: makeTypedId("rel", clock, random),
      repositoryId,
      fromEntityId: checkpointId,
      relationType: "RELATED_TO",
      toEntityId: reference.ref,
      sourceKind: "inferred",
      createdAt: nowIso,
    });
    if (!inserted.ok) {
      return err(inserted.error);
    }
  }
  return ok(undefined);
}

/**
 * Saves a structured Checkpoint and its knowledge candidates (mcp-contract.md
 * §6.6). Fixed order: authenticate the session token, secret-scan/redact every
 * free-text field, resolve the Turn, then — under the idempotency contract, in
 * one write transaction — insert the checkpoint entity, the checkpoint, the
 * candidates from `proposals`, and mark the Turn `checkpoint_state = saved`. A
 * retry with the same key returns the original result (`deduplicated: true`)
 * and never creates a second checkpoint.
 */
export async function mcpCreateCheckpoint(
  args: McpCreateCheckpointInput,
): Promise<Result<McpCreateCheckpointData, IrohaError>> {
  const { input } = args;
  return withMcpRepository(
    { cwd: args.cwd, clock: args.clock, random: args.random },
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
      const { repositoryId, sessionId, runId } = verified.value;

      const redacted = await redactCheckpoint(input);
      if (!redacted.ok) {
        return err(redacted.error);
      }

      // `input.turnId` is runtime-validated to the `trn_` prefix by
      // `checkpointInputSchema`; the Zod `typedId` helper's inferred type is the
      // broad branded string, so narrow it here at the boundary.
      let turnId: TypedId<"trn"> | undefined = input.turnId as TypedId<"trn"> | undefined;
      if (turnId !== undefined) {
        const turn = await getTurnById(ctx.db, turnId);
        if (!turn.ok) {
          return err(turn.error);
        }
        if (turn.value === null || turn.value.runId !== runId) {
          return err(
            new IrohaErrorClass("INVALID_INPUT", "turnId does not belong to the active run"),
          );
        }
      } else {
        const latest = await getLatestTurnForRun(ctx.db, runId);
        if (!latest.ok) {
          return err(latest.error);
        }
        turnId = latest.value?.id;
      }

      const checkpointId = makeTypedId("chk", ctx.clock, ctx.random);
      const nowIso = ctx.clock.now().toISOString();
      const resolvedTurnId = turnId;

      return runIdempotentWrite<McpCreateCheckpointData>({
        db: ctx.db,
        clock: ctx.clock,
        repositoryId,
        operation: OPERATION,
        idempotencyKey: input.idempotencyKey,
        fromStored: storedToData,
        toStored: (data) => ({
          responseJson: JSON.stringify(data),
          resultEntityId: data.checkpointId,
        }),
        work: async (tx) => {
          const entity = await insertEntity(tx, {
            id: checkpointId,
            repositoryId,
            entityType: "checkpoint",
            title: redacted.value.objective.slice(0, 200),
            status: "active",
            authority: 60,
            sourceKind: "mcp",
            createdAt: nowIso,
            updatedAt: nowIso,
          });
          if (!entity.ok) {
            return err(entity.error);
          }

          const checkpoint = await insertCheckpoint(tx, {
            id: checkpointId,
            sessionId,
            ...(resolvedTurnId !== undefined ? { turnId: resolvedTurnId } : {}),
            outcome: input.outcome,
            objective: redacted.value.objective,
            summary: redacted.value.summary,
            implementationJson: JSON.stringify(redacted.value.implementation),
            validationJson: JSON.stringify(redacted.value.validation),
            unresolvedJson: JSON.stringify(redacted.value.unresolved),
            referencesJson: JSON.stringify(redacted.value.references),
            labelsJson: JSON.stringify(input.labels),
            createdAt: nowIso,
          });
          if (!checkpoint.ok) {
            return err(checkpoint.error);
          }

          const candidateIds: TypedId<"cand">[] = [];
          for (const proposal of redacted.value.proposals) {
            const candidateId = makeTypedId("cand", ctx.clock, ctx.random);
            const revisionToken = Buffer.from(ctx.random.bytes(16)).toString("base64url");
            const candidate = await insertCandidate(tx, {
              id: candidateId,
              repositoryId,
              candidateType: proposal.type,
              payloadJson: JSON.stringify(proposal),
              sourceSessionId: sessionId,
              sourceCheckpointId: checkpointId,
              ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
              revisionToken,
              createdAt: nowIso,
            });
            if (!candidate.ok) {
              return err(candidate.error);
            }
            candidateIds.push(candidateId);
          }

          const referenceRelations = await materializeReferenceRelations(
            tx,
            repositoryId,
            checkpointId,
            redacted.value.references,
            nowIso,
            ctx.clock,
            ctx.random,
          );
          if (!referenceRelations.ok) {
            return err(referenceRelations.error);
          }

          if (resolvedTurnId !== undefined) {
            const turnState = await updateTurnCheckpointState(tx, resolvedTurnId, "saved");
            if (!turnState.ok) {
              return err(turnState.error);
            }
          }

          return ok({
            checkpointId,
            sessionId,
            runId,
            turnId: resolvedTurnId,
            candidateIds,
            redactions: redacted.value.redactions,
            deduplicated: false,
          });
        },
      });
    },
  );
}
