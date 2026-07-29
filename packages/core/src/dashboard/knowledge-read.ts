import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import {
  countKnowledgeEntities,
  type EntityRow,
  getCanonicalDocumentByEntityId,
  getEntityById,
  getNeighbors,
  listKnowledgeEntities,
  withTransaction,
} from "@iroha/storage";
import { decodeCursor, encodeCursor, resolvePageSize } from "./cursor.js";
import { withDashboardRepository } from "./with-repository.js";

export interface KnowledgeListItem {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  authority: number;
  status: string;
  updatedAt: string;
}

export interface KnowledgeListPage {
  items: KnowledgeListItem[];
  nextCursor: string | null;
  /** Rows matching the filters, for numbered pages. */
  total: number;
}

export interface ListKnowledgeInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  limit?: number;
  cursor?: string;
  statuses?: string[];
  entityTypes?: string[];
  /** Rows to skip. Ignored when `cursor` is given. */
  offset?: number;
}

/**
 * Paginated approved-knowledge list (`GET /api/v1/knowledge`).
 *
 * The page and `total` are read in one transaction for the same reason the review
 * queue does it: two statements over the same table, and a sync writing between
 * them makes the count disagree with the rows.
 *
 * `offset` is as unstable here as in the review queue: the order is
 * `updated_at DESC`, so an approval lands at the front and repeats a row on the
 * next page, and archiving one removes it from the default filter and can skip
 * one. Numbered pages are worth that; a caller that must not miss a row uses the
 * cursor.
 */
export async function listKnowledge(
  input: ListKnowledgeInput,
): Promise<Result<KnowledgeListPage, IrohaError>> {
  const pageSize = resolvePageSize(input.limit);
  let before: { key: string; id: string } | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) {
      return err(new IrohaErrorClass("INVALID_INPUT", "Malformed pagination cursor"));
    }
    before = decoded;
  }

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const filters = {
        ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
        ...(input.entityTypes !== undefined ? { entityTypes: input.entityTypes } : {}),
      };
      const snapshot = await withTransaction<{ rows: EntityRow[]; total: number }>(
        ctx.db,
        "read",
        async (tx) => {
          const page = await listKnowledgeEntities(tx, ctx.repo.repositoryId, {
            limit: pageSize + 1,
            ...filters,
            ...(before !== undefined
              ? { beforeUpdatedAt: before.key, beforeId: before.id }
              : input.offset !== undefined
                ? { offset: input.offset }
                : {}),
          });
          if (!page.ok) {
            return page;
          }
          const count = await countKnowledgeEntities(tx, ctx.repo.repositoryId, filters);
          if (!count.ok) {
            return count;
          }
          return ok({ rows: page.value, total: count.value });
        },
      );
      if (!snapshot.ok) {
        return snapshot;
      }
      const rows = { value: snapshot.value.rows };
      const total = snapshot.value.total;
      const page = rows.value.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        rows.value.length > pageSize && last !== undefined
          ? encodeCursor({ key: last.updatedAt, id: last.id })
          : null;
      return ok({
        items: page.map((row) => ({
          id: row.id,
          type: row.entityType,
          title: row.title,
          summary: row.summary,
          authority: row.authority,
          status: row.status,
          updatedAt: row.updatedAt,
        })),
        nextCursor,
        total,
      });
    },
  );
}

export interface KnowledgeRelation {
  relationType: string;
  direction: "outgoing" | "incoming";
  entityId: string;
}

export interface KnowledgeDetailData {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  status: string;
  authority: number;
  body: string | null;
  canonicalPath: string | null;
  revision: number | null;
  approvedAt: string | null;
  frontmatter: unknown;
  relations: KnowledgeRelation[];
}

export interface GetKnowledgeDetailInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  entityId: string;
}

/** Knowledge detail with body, provenance frontmatter, and relations (`GET /api/v1/knowledge/:id`). */
export async function getKnowledgeDetail(
  input: GetKnowledgeDetailInput,
): Promise<Result<KnowledgeDetailData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const entityResult = await getEntityById(ctx.db, input.entityId);
      if (!entityResult.ok) {
        return entityResult;
      }
      const entity = entityResult.value;
      if (entity === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Knowledge item not found"));
      }
      const docResult = await getCanonicalDocumentByEntityId(ctx.db, input.entityId);
      if (!docResult.ok) {
        return docResult;
      }
      const doc = docResult.value;
      const neighborsResult = await getNeighbors(ctx.db, input.entityId, {
        direction: "both",
        limit: 200,
      });
      if (!neighborsResult.ok) {
        return neighborsResult;
      }
      const relations: KnowledgeRelation[] = neighborsResult.value.map((rel) =>
        rel.fromEntityId === input.entityId
          ? { relationType: rel.relationType, direction: "outgoing", entityId: rel.toEntityId }
          : { relationType: rel.relationType, direction: "incoming", entityId: rel.fromEntityId },
      );
      return ok({
        id: entity.id,
        type: entity.entityType,
        title: entity.title,
        summary: entity.summary,
        status: entity.status,
        authority: entity.authority,
        body: doc?.body ?? null,
        canonicalPath: doc?.canonicalPath ?? null,
        revision: doc?.revision ?? null,
        approvedAt: doc?.approvedAt ?? null,
        frontmatter: doc === null ? null : JSON.parse(doc.frontmatterJson),
        relations,
      });
    },
  );
}
