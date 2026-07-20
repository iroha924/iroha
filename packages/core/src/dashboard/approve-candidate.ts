import { computeCanonicalPath, writeCanonicalDocument } from "@iroha/canonical";
import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok, parseTypedId } from "@iroha/domain";
import {
  getCandidateById,
  insertApproval,
  insertDirtyMarker,
  updateCandidateStatus,
  withTransaction,
} from "@iroha/storage";
import { importCanonicalDocument, insertCanonicalDocumentRelations } from "../sync-canonical.js";
import {
  buildCanonicalDocumentFromCandidate,
  type CandidateDraft,
  type CanonicalActorRef,
  type CanonicalProvenanceSource,
} from "./build-canonical.js";
import { withDashboardRepository } from "./with-repository.js";
import { withRepositoryWriteLock } from "./write-mutex.js";

/** The AI agent that authored a candidate, recorded as `created_by` (NFR-006: AI-vs-human provenance). */
const AGENT_ACTOR: CanonicalActorRef = { provider: "local", display_name: "iroha agent" };

export interface ReviewActorInput {
  provider: "git" | "github" | "gitlab" | "local";
  displayName: string;
}

export interface ApproveCandidateInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  candidateId: string;
  revisionToken: string;
  actor: ReviewActorInput;
  comment?: string;
}

export interface ApproveCandidateData {
  candidateId: TypedId<"cand">;
  entityId: string;
  canonicalPath: string;
  type: string;
  revision: number;
}

function provenanceFor(
  sourceSessionId: string | null,
  sourceCheckpointId: string | null,
): CanonicalProvenanceSource[] {
  const provenance: CanonicalProvenanceSource[] = [];
  if (sourceCheckpointId !== null) {
    provenance.push({ type: "checkpoint", ref: sourceCheckpointId });
  }
  if (sourceSessionId !== null) {
    provenance.push({ type: "session", ref: sourceSessionId });
  }
  return provenance;
}

/**
 * The human approval transaction (canonical-schema.md §12 / design.md §10 /
 * decision-log ID-025(2)) — the higher layer that composes
 * `writeCanonicalDocument` (steps 3-7) with the storage/git steps
 * `@iroha/canonical` cannot reach. Fixed order:
 *
 * 1. acquire the in-process per-repository write lock;
 * 2. reload the candidate and verify its optimistic revision token;
 * 3-7. `writeCanonicalDocument` validates (Zod + body template + secret scan)
 *      and atomically writes the `.iroha/` file — a detected secret or invalid
 *      body fails here BEFORE any DB change (dashboard-api.md §6/§10 "secret
 *      warning blocks approval");
 * 8-9. in one DB transaction: import the document exactly as `sync --rebuild`
 *      would (so approve and rebuild produce identical rows), insert its
 *      relations, transition the candidate `pending -> approved` under the same
 *      optimistic token, and append the approval audit record.
 *
 * If the DB transaction fails after the file has landed, a
 * `canonical_db_divergence` dirty marker is recorded and a recoverable error
 * returned: the canonical file is authoritative and the next `sync` repairs the
 * DB (FR-053).
 */
export async function approveCandidate(
  input: ApproveCandidateInput,
): Promise<Result<ApproveCandidateData, IrohaError>> {
  const parsedId = parseTypedId("cand", input.candidateId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const candidateId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    (ctx) =>
      withRepositoryWriteLock(ctx.repo.repositoryId, async () => {
        // Step 2: reload the candidate and verify the optimistic token.
        const candidateResult = await getCandidateById(ctx.db, candidateId);
        if (!candidateResult.ok) {
          return candidateResult;
        }
        const candidate = candidateResult.value;
        if (candidate === null) {
          return err(new IrohaErrorClass("NOT_FOUND", "Candidate not found"));
        }
        if (candidate.status !== "pending") {
          return err(
            new IrohaErrorClass(
              "CONFLICT",
              "Candidate is no longer pending; reload before approving",
            ),
          );
        }
        if (candidate.revisionToken !== input.revisionToken) {
          return err(
            new IrohaErrorClass("CONFLICT", "The candidate changed. Reload before approving."),
          );
        }

        const draft = JSON.parse(candidate.payloadJson) as CandidateDraft;
        const nowIso = ctx.clock.now().toISOString();

        // Steps 3-7: build, validate, and atomically write the canonical file.
        const built = buildCanonicalDocumentFromCandidate({
          candidateType: candidate.candidateType,
          draft,
          repositoryId: ctx.repo.repositoryId,
          clock: ctx.clock,
          random: ctx.random,
          createdBy: AGENT_ACTOR,
          approvedBy: { provider: input.actor.provider, display_name: input.actor.displayName },
          createdAt: candidate.createdAt,
          approvedAt: nowIso,
          revision: 1,
          provenance: provenanceFor(candidate.sourceSessionId, candidate.sourceCheckpointId),
        });
        if (!built.ok) {
          return built;
        }

        const writeResult = await writeCanonicalDocument(
          built.value,
          ctx.repo.irohaCanonicalDir,
          ctx.random,
        );
        if (!writeResult.ok) {
          return writeResult;
        }
        const document = writeResult.value.document;
        const hash = writeResult.value.hash;
        const canonicalPath = computeCanonicalPath(document);
        const entityId = document.frontmatter.id;

        // Steps 8-9: one DB transaction mirroring the rebuild import path.
        const committed = await withTransaction<ApproveCandidateData>(
          ctx.db,
          "write",
          async (tx) => {
            const imported = await importCanonicalDocument(
              tx,
              ctx.repo.repositoryId,
              canonicalPath,
              hash,
              document,
              ctx.clock,
              ctx.random,
            );
            if (!imported.ok) {
              return imported;
            }
            const relations = await insertCanonicalDocumentRelations(
              tx,
              ctx.repo.repositoryId,
              document,
              ctx.clock,
              ctx.random,
            );
            if (!relations.ok) {
              return relations;
            }
            const status = await updateCandidateStatus(tx, candidateId, {
              from: "pending",
              to: "approved",
              expectedRevisionToken: input.revisionToken,
              newRevisionToken: Buffer.from(ctx.random.bytes(16)).toString("base64url"),
              reviewedAt: nowIso,
            });
            if (!status.ok) {
              return status;
            }
            const approval = await insertApproval(tx, {
              id: makeTypedId("apr", ctx.clock, ctx.random),
              candidateId,
              action: "approve",
              afterHash: hash,
              ...(input.comment !== undefined ? { comment: input.comment } : {}),
              createdAt: nowIso,
            });
            if (!approval.ok) {
              return approval;
            }
            return ok({
              candidateId,
              entityId,
              canonicalPath,
              type: document.frontmatter.type,
              revision: document.frontmatter.revision,
            });
          },
        );

        if (!committed.ok) {
          // The canonical file already landed and is authoritative; record a
          // divergence marker so the next `sync` reconciles the DB (§12).
          await insertDirtyMarker(ctx.db, {
            id: makeTypedId("dirty", ctx.clock, ctx.random),
            repositoryId: ctx.repo.repositoryId,
            markerType: "canonical_db_divergence",
            entityId,
            detailsJson: JSON.stringify({
              reason: "approval_db_commit_failed",
              path: canonicalPath,
              candidateId,
            }),
            createdAt: nowIso,
          }).catch(() => undefined);
          return committed;
        }

        return committed;
      }),
  );
}
