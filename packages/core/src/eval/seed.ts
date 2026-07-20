import type { IrohaError, Result, TypedId } from "@iroha/domain";
import {
  type Database,
  insertEntity,
  insertRelation,
  upsertCanonicalDocument,
  upsertEmbedding,
  upsertSearchDocument,
} from "@iroha/storage";
import { DOCS, RELATIONS } from "./fixture.js";

const FIXED_AT = "2026-01-01T00:00:00.000Z";

function sdocIdFor(docId: string): TypedId<"sdoc"> {
  return `sdoc_${docId}` as TypedId<"sdoc">;
}

async function mustOk(promise: Promise<Result<unknown, IrohaError>>, label: string): Promise<void> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(`${label}: ${result.error.code}: ${result.error.message}`);
  }
}

/**
 * Seeds a migrated database from the evaluation fixture: each document becomes
 * an approved entity + canonical document (scope/labels/sources in frontmatter)
 * + search document, plus its recorded embedding when present, and the fixture
 * relations. Deterministic (fixed timestamps, stable ids).
 */
export async function seedFixture(
  db: Database,
  repositoryId: TypedId<"repo">,
  corpusVectors: Record<string, number[]>,
): Promise<void> {
  for (const doc of DOCS) {
    await mustOk(
      insertEntity(db, {
        id: doc.id,
        repositoryId,
        entityType: doc.type,
        title: doc.title,
        summary: doc.summary,
        status: "approved",
        authority: 100,
        sourceKind: "canonical",
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      }),
      `insertEntity ${doc.id}`,
    );
    const contentHash = `sha256:${doc.id}`;
    const frontmatter = {
      scope: { paths: doc.scope?.paths ?? [], symbols: doc.scope?.symbols ?? [] },
      labels: doc.labels ?? [],
      sources: doc.sources ?? [],
    };
    await mustOk(
      upsertCanonicalDocument(db, {
        entityId: doc.id,
        canonicalPath: `${doc.type}/${doc.id}.md`,
        revision: 1,
        frontmatterJson: JSON.stringify(frontmatter),
        body: doc.body,
        fileHash: contentHash,
        approvedAt: FIXED_AT,
        importedAt: FIXED_AT,
      }),
      `upsertCanonicalDocument ${doc.id}`,
    );
    const sdocId = sdocIdFor(doc.id);
    await mustOk(
      upsertSearchDocument(db, {
        id: sdocId,
        entityId: doc.id,
        documentKind: doc.type,
        title: doc.title,
        body: doc.body,
        codeTerms: (doc.scope?.symbols ?? []).join(" "),
        authority: 100,
        contentHash,
        indexedAt: FIXED_AT,
      }),
      `upsertSearchDocument ${doc.id}`,
    );
    const vector = corpusVectors[doc.id];
    if (vector !== undefined) {
      await mustOk(
        upsertEmbedding(db, {
          searchDocumentId: sdocId,
          contentHash,
          embedding: vector,
          createdAt: FIXED_AT,
        }),
        `upsertEmbedding ${doc.id}`,
      );
    }
  }

  for (const relation of RELATIONS) {
    await mustOk(
      insertRelation(db, {
        id: `rel_${relation.from}__${relation.to}` as TypedId<"rel">,
        repositoryId,
        fromEntityId: relation.from,
        relationType: relation.type,
        toEntityId: relation.to,
        sourceKind: "canonical",
        createdAt: FIXED_AT,
      }),
      `insertRelation ${relation.from}->${relation.to}`,
    );
  }
}
