import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  getCanonicalDocumentByEntityId,
  getEntityById,
  getSearchDocumentByEntityId,
  insertRepository,
  listOpenDirtyMarkers,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { syncCanonicalToDatabase } from "./sync-canonical.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const REPOSITORY_ID = makeTypedId("repo", CLOCK, new CryptoRandomSource());

function decisionCandidate(id: string, title: string, revision: number, relations: unknown[] = []) {
  return {
    frontmatter: {
      schema_version: 1,
      id,
      type: "decision",
      title,
      status: "approved",
      revision,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: { provider: "git", display_name: "Example Developer" },
      approved_by: { provider: "git", display_name: "Example Reviewer" },
      approved_at: "2026-01-01T00:00:00.000Z",
      labels: [],
      scope: { repository: REPOSITORY_ID, paths: [], symbols: ["fooBar"] },
      sources: [{ type: "url", ref: "https://example.com" }],
      relations,
      decision: { kind: "architecture" },
    },
    body: [
      `# ${title}`,
      "## Context",
      "",
      "Context.",
      "## Decision",
      "",
      "Decision.",
      "## Rationale",
      "",
      "Rationale.",
      "## Consequences",
      "",
      "Consequences.",
      "## Alternatives considered",
      "",
      "None.",
    ].join("\n\n"),
  };
}

describe("syncCanonicalToDatabase", () => {
  let tempDir: string | undefined;
  let canonicalDir: string | undefined;
  let db: Database | undefined;
  const repositoryId = REPOSITORY_ID;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function setup(): Promise<void> {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    canonicalDir = join(tempDir, ".iroha");
    await mkdir(canonicalDir, { recursive: true });
    const inserted = await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-sync",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!inserted.ok) {
      throw new Error(`failed to seed repository: ${inserted.error.message}`);
    }
  }

  it("imports a newly added canonical document", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const written = await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    expect(written.ok).toBe(true);

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ added: 1, changed: 0, unchanged: 0, deleted: 0 });
    }

    const entity = await getEntityById(db, id);
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      expect(entity.value?.authority).toBe(100);
      expect(entity.value?.entityType).toBe("decision");
    }
    const canonicalDoc = await getCanonicalDocumentByEntityId(db, id);
    expect(canonicalDoc.ok).toBe(true);
    if (canonicalDoc.ok) {
      expect(canonicalDoc.value?.revision).toBe(1);
    }
    const searchDoc = await getSearchDocumentByEntityId(db, id);
    expect(searchDoc.ok).toBe(true);
    if (searchDoc.ok) {
      expect(searchDoc.value?.codeTerms).toBe("fooBar");
    }
  });

  it("is a no-op on a second sync with no on-disk changes", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    const second = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
    }
  });

  it("re-imports a document whose revision changed", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL v2", 2),
      canonicalDir,
      new CryptoRandomSource(),
    );
    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ added: 0, changed: 1, unchanged: 0 });
    }
    const canonicalDoc = await getCanonicalDocumentByEntityId(db, id);
    expect(canonicalDoc.ok).toBe(true);
    if (canonicalDoc.ok) {
      expect(canonicalDoc.value?.revision).toBe(2);
    }
  });

  it("resolves a relation between two documents synced in the same pass", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const idA = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const idB = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(idB, "Decision B", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 1, [{ type: "RELATED_TO", target: idB }]),
      canonicalDir,
      new CryptoRandomSource(),
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unresolvedRelations).toBe(0);
    }
  });

  it("records a dirty marker for a relation whose target does not exist locally", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const idA = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const missingTarget = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 1, [{ type: "RELATED_TO", target: missingTarget }]),
      canonicalDir,
      new CryptoRandomSource(),
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unresolvedRelations).toBe(1);
    }
    const markers = await listOpenDirtyMarkers(db, repositoryId, "sync_required");
    expect(markers.ok).toBe(true);
    if (markers.ok) {
      expect(markers.value.length).toBe(1);
    }
  });

  it("tombstones the entity for a deleted canonical file", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const written = await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    expect(written.ok).toBe(true);
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());
    if (written.ok) {
      await rm(written.value.path);
    }

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(1);
    }
    const entity = await getEntityById(db, id);
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      expect(entity.value?.status).toBe("tombstoned");
    }
  });

  it("records a dirty marker for a malformed file without aborting the sync", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    await mkdir(join(canonicalDir, "decisions"), { recursive: true });
    await writeFile(
      join(canonicalDir, "decisions", "dec_broken.md"),
      "not valid frontmatter at all",
      "utf8",
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scanErrors).toBe(1);
    }
    const markers = await listOpenDirtyMarkers(db, repositoryId, "canonical_db_divergence");
    expect(markers.ok).toBe(true);
    if (markers.ok) {
      expect(markers.value.length).toBe(1);
    }
  });
});
