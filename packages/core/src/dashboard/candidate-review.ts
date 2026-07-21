import type {
  CandidateStatus,
  Clock,
  IrohaError,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok, parseTypedId } from "@iroha/domain";
import {
  getCandidateById,
  insertApproval,
  updateCandidatePayload,
  updateCandidateStatus,
  withTransaction,
} from "@iroha/storage";
import type { CandidateDraft } from "./build-canonical.js";
import { withDashboardRepository } from "./with-repository.js";

function newRevisionToken(random: RandomSource): string {
  return Buffer.from(random.bytes(16)).toString("base64url");
}

export interface CandidateStatusChangeData {
  candidateId: TypedId<"cand">;
  status: CandidateStatus;
}

export interface RejectCandidateInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  candidateId: string;
  revisionToken: string;
  reason?: string;
}

/**
 * Rejects a pending candidate (`POST /api/v1/candidates/:id/reject`). No
 * canonical file is written; the candidate transitions `pending -> rejected`
 * (retained locally for audit, database-schema.md §7) and an audit row is
 * appended, both under the optimistic revision token.
 */
export async function rejectCandidate(
  input: RejectCandidateInput,
): Promise<Result<CandidateStatusChangeData, IrohaError>> {
  const parsedId = parseTypedId("cand", input.candidateId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const candidateId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const candidateResult = await getCandidateById(ctx.db, candidateId);
      if (!candidateResult.ok) {
        return candidateResult;
      }
      const candidate = candidateResult.value;
      if (candidate === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Candidate not found"));
      }
      if (candidate.status !== "pending") {
        return err(new IrohaErrorClass("CONFLICT", "Candidate is no longer pending"));
      }
      if (candidate.revisionToken !== input.revisionToken) {
        return err(
          new IrohaErrorClass("CONFLICT", "The candidate changed. Reload before rejecting."),
        );
      }
      const nowIso = ctx.clock.now().toISOString();
      return withTransaction<CandidateStatusChangeData>(ctx.db, "write", async (tx) => {
        const status = await updateCandidateStatus(tx, candidateId, {
          from: "pending",
          to: "rejected",
          expectedRevisionToken: input.revisionToken,
          newRevisionToken: newRevisionToken(ctx.random),
          reviewedAt: nowIso,
        });
        if (!status.ok) {
          return status;
        }
        const approval = await insertApproval(tx, {
          id: makeTypedId("apr", ctx.clock, ctx.random),
          candidateId,
          action: "reject",
          ...(input.reason !== undefined ? { comment: input.reason } : {}),
          createdAt: nowIso,
        });
        if (!approval.ok) {
          return approval;
        }
        return ok({ candidateId, status: "rejected" });
      });
    },
  );
}

export interface SupersedeCandidateInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  candidateId: string;
  revisionToken: string;
  comment?: string;
}

/**
 * Supersedes a pending or approved candidate
 * (`POST /api/v1/candidates/:id/supersede`) — a `pending -> superseded` or
 * `approved -> superseded` transition plus audit (database-schema.md §7). The
 * canonical-side effect of superseding an approved document (setting the file's
 * `status: superseded` and adding a `SUPERSEDES` edge, canonical-schema.md §13)
 * is a canonical edit deferred beyond v0.1.
 */
export async function supersedeCandidate(
  input: SupersedeCandidateInput,
): Promise<Result<CandidateStatusChangeData, IrohaError>> {
  const parsedId = parseTypedId("cand", input.candidateId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const candidateId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const candidateResult = await getCandidateById(ctx.db, candidateId);
      if (!candidateResult.ok) {
        return candidateResult;
      }
      const candidate = candidateResult.value;
      if (candidate === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Candidate not found"));
      }
      if (candidate.status !== "pending" && candidate.status !== "approved") {
        return err(
          new IrohaErrorClass("CONFLICT", "Only a pending or approved candidate can be superseded"),
        );
      }
      if (candidate.revisionToken !== input.revisionToken) {
        return err(
          new IrohaErrorClass("CONFLICT", "The candidate changed. Reload before superseding."),
        );
      }
      const from = candidate.status;
      const nowIso = ctx.clock.now().toISOString();
      return withTransaction<CandidateStatusChangeData>(ctx.db, "write", async (tx) => {
        const status = await updateCandidateStatus(tx, candidateId, {
          from,
          to: "superseded",
          expectedRevisionToken: input.revisionToken,
          newRevisionToken: newRevisionToken(ctx.random),
          reviewedAt: nowIso,
        });
        if (!status.ok) {
          return status;
        }
        const approval = await insertApproval(tx, {
          id: makeTypedId("apr", ctx.clock, ctx.random),
          candidateId,
          action: "supersede",
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          createdAt: nowIso,
        });
        if (!approval.ok) {
          return approval;
        }
        return ok({ candidateId, status: "superseded" });
      });
    },
  );
}

export interface EditCandidateInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  candidateId: string;
  revisionToken: string;
  /** The validated (by the API boundary) replacement draft. */
  draft: CandidateDraft;
}

export interface EditCandidateData {
  candidateId: TypedId<"cand">;
  revisionToken: string;
}

/**
 * Edits a pending candidate's draft (`PATCH /api/v1/candidates/:id`). Only the
 * payload changes — no canonical file, no status transition — guarded by the
 * optimistic token, and a new token is returned so the reviewer can continue
 * editing (dashboard-api.md §5). An `edit` audit row is appended.
 */
export async function editCandidate(
  input: EditCandidateInput,
): Promise<Result<EditCandidateData, IrohaError>> {
  const parsedId = parseTypedId("cand", input.candidateId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const candidateId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const candidateResult = await getCandidateById(ctx.db, candidateId);
      if (!candidateResult.ok) {
        return candidateResult;
      }
      const candidate = candidateResult.value;
      if (candidate === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Candidate not found"));
      }
      if (candidate.status !== "pending") {
        return err(new IrohaErrorClass("CONFLICT", "Only a pending candidate draft can be edited"));
      }
      const nextToken = newRevisionToken(ctx.random);
      const nowIso = ctx.clock.now().toISOString();
      return withTransaction<EditCandidateData>(ctx.db, "write", async (tx) => {
        const updated = await updateCandidatePayload(tx, candidateId, {
          expectedRevisionToken: input.revisionToken,
          newRevisionToken: nextToken,
          payloadJson: JSON.stringify(input.draft),
        });
        if (!updated.ok) {
          return updated;
        }
        const approval = await insertApproval(tx, {
          id: makeTypedId("apr", ctx.clock, ctx.random),
          candidateId,
          action: "edit",
          createdAt: nowIso,
        });
        if (!approval.ok) {
          return approval;
        }
        return ok({ candidateId, revisionToken: nextToken });
      });
    },
  );
}
