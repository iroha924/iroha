import {
  type CandidateStatus,
  err,
  IrohaError,
  ok,
  type Result,
  type TypedId,
  transitionCandidateStatus,
} from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableNumber, nullableString } from "../row-helpers.js";

// --- knowledge_items ---------------------------------------------------

export const KNOWLEDGE_TYPES = [
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export interface KnowledgeItemRow {
  id: string;
  knowledgeType: KnowledgeType;
  body: string;
  scopeJson: string;
  enforcement: "advisory" | "guardrail";
  guardSpecJson: string | null;
  confidence: number | null;
  approvedByActorId: TypedId<"act"> | null;
  approvedAt: string | null;
  canonicalPath: string | null;
}

interface UpsertKnowledgeItemCommon {
  id: string;
  knowledgeType: KnowledgeType;
  body: string;
  scopeJson: string;
  confidence?: number;
  approvedByActorId?: TypedId<"act">;
  approvedAt?: string;
  canonicalPath?: string;
}

/**
 * A discriminated union mirroring the DB's own
 * `CHECK (enforcement <> 'guardrail' OR guard_spec_json IS NOT NULL)`:
 * a `'guardrail'` item cannot be constructed here without `guardSpecJson`.
 */
export type UpsertKnowledgeItemInput =
  | (UpsertKnowledgeItemCommon & { enforcement: "advisory" })
  | (UpsertKnowledgeItemCommon & { enforcement: "guardrail"; guardSpecJson: string });

function rowToKnowledgeItem(row: Record<string, unknown>): KnowledgeItemRow {
  return {
    id: String(row.id),
    knowledgeType: row.knowledge_type as KnowledgeType,
    body: String(row.body),
    scopeJson: String(row.scope_json),
    enforcement: row.enforcement as "advisory" | "guardrail",
    guardSpecJson: nullableString(row.guard_spec_json),
    confidence: nullableNumber(row.confidence),
    approvedByActorId:
      row.approved_by_actor_id === null ? null : (row.approved_by_actor_id as TypedId<"act">),
    approvedAt: nullableString(row.approved_at),
    canonicalPath: nullableString(row.canonical_path),
  };
}

/** One row per entity (`id` is the primary key), matching `canonical_documents`' upsert pattern. */
export async function upsertKnowledgeItem(
  db: Executor,
  input: UpsertKnowledgeItemInput,
): Promise<Result<void, IrohaError>> {
  const guardSpecJson = input.enforcement === "guardrail" ? input.guardSpecJson : null;
  try {
    await db.execute({
      sql: `INSERT INTO knowledge_items
        (id, knowledge_type, body, scope_json, enforcement, guard_spec_json, confidence, approved_by_actor_id, approved_at, canonical_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          knowledge_type = excluded.knowledge_type,
          body = excluded.body,
          scope_json = excluded.scope_json,
          enforcement = excluded.enforcement,
          guard_spec_json = excluded.guard_spec_json,
          confidence = excluded.confidence,
          approved_by_actor_id = excluded.approved_by_actor_id,
          approved_at = excluded.approved_at,
          canonical_path = excluded.canonical_path`,
      args: [
        input.id,
        input.knowledgeType,
        input.body,
        input.scopeJson,
        input.enforcement,
        guardSpecJson,
        input.confidence ?? null,
        input.approvedByActorId ?? null,
        input.approvedAt ?? null,
        input.canonicalPath ?? null,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert knowledge item"));
  }
}

export async function getKnowledgeItemById(
  db: Executor,
  id: string,
): Promise<Result<KnowledgeItemRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM knowledge_items WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToKnowledgeItem(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read knowledge item"));
  }
}

// --- candidates ---------------------------------------------------

export const CANDIDATE_TYPES = [
  "session_summary",
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export interface CandidateRow {
  id: TypedId<"cand">;
  repositoryId: TypedId<"repo">;
  targetEntityId: string | null;
  candidateType: CandidateType;
  payloadJson: string;
  sourceSessionId: TypedId<"ses"> | null;
  sourceCheckpointId: TypedId<"chk"> | null;
  status: CandidateStatus;
  confidence: number | null;
  revisionToken: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedByActorId: TypedId<"act"> | null;
}

export interface InsertCandidateInput {
  id: TypedId<"cand">;
  repositoryId: TypedId<"repo">;
  targetEntityId?: string;
  candidateType: CandidateType;
  payloadJson: string;
  sourceSessionId?: TypedId<"ses">;
  sourceCheckpointId?: TypedId<"chk">;
  confidence?: number;
  revisionToken: string;
  createdAt: string;
}

function rowToCandidate(row: Record<string, unknown>): CandidateRow {
  return {
    id: row.id as TypedId<"cand">,
    repositoryId: row.repository_id as TypedId<"repo">,
    targetEntityId: nullableString(row.target_entity_id),
    candidateType: row.candidate_type as CandidateType,
    payloadJson: String(row.payload_json),
    sourceSessionId:
      row.source_session_id === null ? null : (row.source_session_id as TypedId<"ses">),
    sourceCheckpointId:
      row.source_checkpoint_id === null ? null : (row.source_checkpoint_id as TypedId<"chk">),
    status: row.status as CandidateStatus,
    confidence: nullableNumber(row.confidence),
    revisionToken: String(row.revision_token),
    createdAt: String(row.created_at),
    reviewedAt: nullableString(row.reviewed_at),
    reviewedByActorId:
      row.reviewed_by_actor_id === null ? null : (row.reviewed_by_actor_id as TypedId<"act">),
  };
}

/** A Candidate always starts `pending` with no review metadata yet. */
export async function insertCandidate(
  db: Executor,
  input: InsertCandidateInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO candidates
        (id, repository_id, target_entity_id, candidate_type, payload_json, source_session_id, source_checkpoint_id, status, confidence, revision_token, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      args: [
        input.id,
        input.repositoryId,
        input.targetEntityId ?? null,
        input.candidateType,
        input.payloadJson,
        input.sourceSessionId ?? null,
        input.sourceCheckpointId ?? null,
        input.confidence ?? null,
        input.revisionToken,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert candidate"));
  }
}

export async function getCandidateById(
  db: Executor,
  id: TypedId<"cand">,
): Promise<Result<CandidateRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM candidates WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCandidate(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read candidate"));
  }
}

/** Matches the `idx_candidates_queue` index — backs the dashboard review queue. */
export async function listCandidatesByStatus(
  db: Executor,
  repositoryId: TypedId<"repo">,
  status: CandidateStatus,
  limit?: number,
): Promise<Result<CandidateRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql:
        limit === undefined
          ? "SELECT * FROM candidates WHERE repository_id = ? AND status = ? ORDER BY created_at DESC"
          : "SELECT * FROM candidates WHERE repository_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
      args: limit === undefined ? [repositoryId, status] : [repositoryId, status, limit],
    });
    return ok(result.rows.map(rowToCandidate));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list candidates"));
  }
}

export interface UpdateCandidateStatusInput {
  from: CandidateStatus;
  to: CandidateStatus;
  /** design.md §10 step 2: "Candidate revision token再検査" — optimistic-concurrency guard. */
  expectedRevisionToken: string;
  newRevisionToken: string;
  reviewedAt: string;
  reviewedByActorId?: TypedId<"act">;
}

/**
 * Validates the transition against the domain state machine (states/
 * candidate.ts) before writing, then updates only if `id`/`status`/
 * `revision_token` all still match — a `rowsAffected === 0` result means
 * either the candidate no longer exists or it was already changed by a
 * concurrent reviewer, both surfaced as `CONFLICT` rather than a silent
 * no-op.
 */
export async function updateCandidateStatus(
  db: Executor,
  id: TypedId<"cand">,
  input: UpdateCandidateStatusInput,
): Promise<Result<void, IrohaError>> {
  const transition = transitionCandidateStatus(input.from, input.to);
  if (!transition.ok) {
    return transition;
  }
  try {
    const result = await db.execute({
      sql: `UPDATE candidates
        SET status = ?, revision_token = ?, reviewed_at = ?, reviewed_by_actor_id = ?
        WHERE id = ? AND status = ? AND revision_token = ?`,
      args: [
        input.to,
        input.newRevisionToken,
        input.reviewedAt,
        input.reviewedByActorId ?? null,
        id,
        input.from,
        input.expectedRevisionToken,
      ],
    });
    if (result.rowsAffected === 0) {
      return err(
        new IrohaError("CONFLICT", "Candidate was modified concurrently or no longer exists", {
          details: { id },
        }),
      );
    }
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update candidate status"));
  }
}

export interface UpdateCandidatePayloadInput {
  expectedRevisionToken: string;
  newRevisionToken: string;
  payloadJson: string;
}

/**
 * Dashboard candidate edit (design.md §10's `approvals.action = 'edit'`),
 * guarded the same way. dashboard-api.md describes `PATCH /candidates/:id`
 * as editing a *draft*; once a candidate leaves `pending` (approved,
 * rejected, or superseded), its payload is fixed and any further change
 * must go through a new transition, not a silent payload rewrite — so this
 * only succeeds while `status = 'pending'`, matching that contract.
 */
export async function updateCandidatePayload(
  db: Executor,
  id: TypedId<"cand">,
  input: UpdateCandidatePayloadInput,
): Promise<Result<void, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "UPDATE candidates SET payload_json = ?, revision_token = ? WHERE id = ? AND status = 'pending' AND revision_token = ?",
      args: [input.payloadJson, input.newRevisionToken, id, input.expectedRevisionToken],
    });
    if (result.rowsAffected === 0) {
      return err(
        new IrohaError("CONFLICT", "Candidate was modified concurrently or no longer exists", {
          details: { id },
        }),
      );
    }
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update candidate payload"));
  }
}

// --- approvals ---------------------------------------------------

export type ApprovalAction = "approve" | "reject" | "supersede" | "edit";

export interface ApprovalRow {
  id: TypedId<"apr">;
  candidateId: TypedId<"cand">;
  actorId: TypedId<"act"> | null;
  action: ApprovalAction;
  beforeHash: string | null;
  afterHash: string | null;
  comment: string | null;
  createdAt: string;
}

export interface InsertApprovalInput {
  id: TypedId<"apr">;
  candidateId: TypedId<"cand">;
  actorId?: TypedId<"act">;
  action: ApprovalAction;
  beforeHash?: string;
  afterHash?: string;
  comment?: string;
  createdAt: string;
}

function rowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: row.id as TypedId<"apr">,
    candidateId: row.candidate_id as TypedId<"cand">,
    actorId: row.actor_id === null ? null : (row.actor_id as TypedId<"act">),
    action: row.action as ApprovalAction,
    beforeHash: nullableString(row.before_hash),
    afterHash: nullableString(row.after_hash),
    comment: nullableString(row.comment),
    createdAt: String(row.created_at),
  };
}

/** Append-only audit trail — no update/delete functions by design. */
export async function insertApproval(
  db: Executor,
  input: InsertApprovalInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO approvals (id, candidate_id, actor_id, action, before_hash, after_hash, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.candidateId,
        input.actorId ?? null,
        input.action,
        input.beforeHash ?? null,
        input.afterHash ?? null,
        input.comment ?? null,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert approval"));
  }
}

/** Matches the `idx_approvals_candidate_time` index. */
export async function listApprovalsByCandidate(
  db: Executor,
  candidateId: TypedId<"cand">,
): Promise<Result<ApprovalRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM approvals WHERE candidate_id = ? ORDER BY created_at",
      args: [candidateId],
    });
    return ok(result.rows.map(rowToApproval));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list approvals"));
  }
}
