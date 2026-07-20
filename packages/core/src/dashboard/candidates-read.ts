import { scanForSecrets, serializeCanonicalDocument, validateBodyTemplate } from "@iroha/canonical";
import type {
  CandidateStatus,
  Clock,
  IrohaError,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok, parseTypedId } from "@iroha/domain";
import { type CandidateType, getCandidateById, listCandidatesPage } from "@iroha/storage";
import { buildCanonicalDocumentFromCandidate, type CandidateDraft } from "./build-canonical.js";
import { decodeCursor, encodeCursor, resolvePageSize } from "./cursor.js";
import { withDashboardRepository } from "./with-repository.js";

const AGENT_ACTOR = { provider: "local", display_name: "iroha agent" } as const;
const REVIEWER_ACTOR = { provider: "local", display_name: "reviewer" } as const;

export interface CandidateQueueItem {
  id: string;
  type: CandidateType;
  status: CandidateStatus;
  title: string;
  summary: string;
  confidence: number | null;
  createdAt: string;
  revisionToken: string;
}

export interface CandidateQueuePage {
  items: CandidateQueueItem[];
  nextCursor: string | null;
}

export interface ListCandidateQueueInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  status?: CandidateStatus;
  limit?: number;
  cursor?: string;
}

/** Paginated review queue (`GET /api/v1/candidates`), pending candidates by default. */
export async function listCandidateQueue(
  input: ListCandidateQueueInput,
): Promise<Result<CandidateQueuePage, IrohaError>> {
  const status: CandidateStatus = input.status ?? "pending";
  const pageSize = resolvePageSize(input.limit);
  let beforeCreatedAt: string | undefined;
  let beforeId: TypedId<"cand"> | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) {
      return err(new IrohaErrorClass("INVALID_INPUT", "Malformed pagination cursor"));
    }
    const parsedCursorId = parseTypedId("cand", decoded.id);
    if (!parsedCursorId.ok) {
      return err(new IrohaErrorClass("INVALID_INPUT", "Malformed pagination cursor"));
    }
    beforeCreatedAt = decoded.key;
    beforeId = parsedCursorId.value;
  }

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const rows = await listCandidatesPage(ctx.db, ctx.repo.repositoryId, {
        status,
        limit: pageSize + 1,
        ...(beforeCreatedAt !== undefined && beforeId !== undefined
          ? { beforeCreatedAt, beforeId }
          : {}),
      });
      if (!rows.ok) {
        return rows;
      }
      const page = rows.value.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        rows.value.length > pageSize && last !== undefined
          ? encodeCursor({ key: last.createdAt, id: last.id })
          : null;
      const items: CandidateQueueItem[] = page.map((row) => {
        const draft = JSON.parse(row.payloadJson) as CandidateDraft;
        return {
          id: row.id,
          type: row.candidateType,
          status: row.status,
          title: draft.title,
          summary: draft.summary,
          confidence: row.confidence,
          createdAt: row.createdAt,
          revisionToken: row.revisionToken,
        };
      });
      return ok({ items, nextCursor });
    },
  );
}

export interface CandidateValidation {
  schemaValid: boolean;
  bodyValid: boolean;
  secretsClean: boolean;
  /** True only when every check passes — the API gates approval on this (dashboard-api.md §6). */
  approvable: boolean;
  issues: string[];
  secretFindings: Array<{ ruleId: string; message: string }>;
}

export interface CandidateDetailData {
  id: string;
  type: CandidateType;
  status: CandidateStatus;
  confidence: number | null;
  createdAt: string;
  revisionToken: string;
  source: { sessionId: string | null; checkpointId: string | null };
  draft: CandidateDraft;
  /** The serialized canonical file preview, or `null` when schema validation fails. */
  canonicalPreview: string | null;
  validation: CandidateValidation;
}

export interface GetCandidateDetailInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  candidateId: string;
}

/**
 * Candidate detail with the canonical diff preview and validation results the
 * Review Queue shows (dashboard-api.md §6). Builds the canonical document from
 * the draft and runs the same Zod + body-template + secret checks the approval
 * transaction runs — WITHOUT writing anything — so the UI can render the
 * preview, block approval on a detected secret, and show why validation fails.
 */
export async function getCandidateDetail(
  input: GetCandidateDetailInput,
): Promise<Result<CandidateDetailData, IrohaError>> {
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
      const draft = JSON.parse(candidate.payloadJson) as CandidateDraft;

      const validation: CandidateValidation = {
        schemaValid: false,
        bodyValid: false,
        secretsClean: false,
        approvable: false,
        issues: [],
        secretFindings: [],
      };
      let canonicalPreview: string | null = null;

      const built = buildCanonicalDocumentFromCandidate({
        candidateType: candidate.candidateType,
        draft,
        repositoryId: ctx.repo.repositoryId,
        clock: ctx.clock,
        random: ctx.random,
        createdBy: AGENT_ACTOR,
        approvedBy: REVIEWER_ACTOR,
        createdAt: candidate.createdAt,
        approvedAt: ctx.clock.now().toISOString(),
        revision: 1,
        provenance: [],
      });
      if (!built.ok) {
        validation.issues.push(built.error.message);
      } else {
        const serialized = serializeCanonicalDocument(built.value);
        if (!serialized.ok) {
          validation.issues.push(serialized.error.message);
        } else {
          validation.schemaValid = true;
          canonicalPreview = serialized.value.content;
          const bodyResult = validateBodyTemplate(serialized.value.document);
          if (bodyResult.ok) {
            validation.bodyValid = true;
          } else {
            validation.issues.push(bodyResult.error.message);
          }
          const scan = await scanForSecrets(serialized.value.content);
          if (!scan.ok) {
            validation.issues.push(scan.error.message);
          } else {
            validation.secretsClean = scan.value.clean;
            if (!scan.value.clean) {
              validation.secretFindings = scan.value.findings.map((finding) => ({
                ruleId: finding.ruleId,
                message: finding.message,
              }));
              validation.issues.push("A possible secret was detected; approval is blocked.");
            }
          }
        }
      }
      validation.approvable =
        validation.schemaValid && validation.bodyValid && validation.secretsClean;

      return ok({
        id: candidate.id,
        type: candidate.candidateType,
        status: candidate.status,
        confidence: candidate.confidence,
        createdAt: candidate.createdAt,
        revisionToken: candidate.revisionToken,
        source: {
          sessionId: candidate.sourceSessionId,
          checkpointId: candidate.sourceCheckpointId,
        },
        draft,
        canonicalPreview,
        validation,
      });
    },
  );
}
