import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, makeTypedId, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  getKnowledgeItemById,
  getSearchDocumentByEntityId,
  insertRepository,
  listCandidatesByStatus,
  listKnowledgeEntities,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { importRepositoryDocs } from "./docs-import.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("importRepositoryDocs", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

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

  async function setup(): Promise<{ repositoryRoot: string; repositoryId: TypedId<"repo"> }> {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = makeTypedId("repo", CLOCK, new CryptoRandomSource());
    const inserted = await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-docs-import",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!inserted.ok) {
      throw new Error(`failed to seed repository: ${inserted.error.message}`);
    }
    return { repositoryRoot: tempDir, repositoryId };
  }

  function listImported(database: Database, repositoryId: TypedId<"repo">) {
    return listKnowledgeEntities(database, repositoryId, {
      statuses: ["imported"],
      limit: 50,
    });
  }

  it("imports AGENTS.md/CLAUDE.md at the repository root, skipping unchanged content", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "AGENTS.md"), "# Agents\n\nFollow these rules.", "utf8");
    await writeFile(join(repositoryRoot, "CLAUDE.md"), "# Claude\n\nProject instructions.", "utf8");

    const first = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.docsImported.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(first.value.entitiesWritten).toBe(2);
    }

    const rerun = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(rerun.ok).toBe(true);
    if (rerun.ok) {
      expect(rerun.value.entitiesWritten).toBe(0);
    }

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value).toHaveLength(2);
    }
  });

  it("never creates a review candidate (contracts/canonical.md §14)", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "CLAUDE.md"), "# Claude\n\nProject instructions.", "utf8");

    const result = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);

    const pending = await listCandidatesByStatus(db, repositoryId, "pending");
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.value).toEqual([]);
    }
  });

  it("re-imports an edited document into the same entity rather than a second one", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    const path = join(repositoryRoot, "CLAUDE.md");
    await writeFile(path, "# Claude\n\nFirst revision.", "utf8");
    const first = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(first.ok).toBe(true);
    const afterFirst = await listImported(db, repositoryId);
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    const entityId = afterFirst.value[0]?.id;
    expect(entityId).toBeDefined();

    await writeFile(path, "# Claude\n\nSecond revision.", "utf8");
    const second = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.entitiesWritten).toBe(1);
    }

    const afterSecond = await listImported(db, repositoryId);
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(afterSecond.value).toHaveLength(1);
    expect(afterSecond.value[0]?.id).toBe(entityId);

    const knowledge = await getKnowledgeItemById(db, entityId ?? "");
    expect(knowledge.ok).toBe(true);
    if (knowledge.ok) {
      expect(knowledge.value?.body).toContain("Second revision.");
    }
  });

  it("discovers .claude/rules/**/*.md recursively", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules", "nested"), { recursive: true });
    await writeFile(join(repositoryRoot, ".claude", "rules", "top.md"), "# Top rule", "utf8");
    await writeFile(
      join(repositoryRoot, ".claude", "rules", "nested", "deep.md"),
      "# Deep rule",
      "utf8",
    );

    const result = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.docsImported.sort()).toEqual([
        ".claude/rules/nested/deep.md",
        ".claude/rules/top.md",
      ]);
      expect(result.value.entitiesWritten).toBe(2);
    }
  });

  it("does not fail when .claude/rules/ does not exist", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;

    const result = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.docsImported).toEqual([]);
    }
  });

  it("records path/hash/scope on the entity and indexes the body for lexical search", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(repositoryRoot, ".claude", "rules", "scoped.md"),
      [
        "---",
        "paths:",
        '  - "packages/*/src/**/*.ts"',
        "---",
        "",
        "# Scoped rule",
        "",
        "Body text.",
      ].join("\n"),
      "utf8",
    );

    const result = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entitiesWritten).toBe(1);

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const entity = imported.value[0];
    expect(entity).toBeDefined();
    if (!entity) return;
    expect(entity.entityType).toBe("rule");
    expect(entity.status).toBe("imported");
    expect(entity.sourceKind).toBe("import");
    expect(entity.sourceRef).toBe(".claude/rules/scoped.md");
    expect(entity.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entity.authority).toBe(80);
    expect(entity.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    const knowledge = await getKnowledgeItemById(db, entity.id);
    expect(knowledge.ok).toBe(true);
    if (!knowledge.ok) return;
    expect(knowledge.value?.knowledgeType).toBe("rule");
    expect(knowledge.value?.enforcement).toBe("advisory");
    expect(knowledge.value?.body).not.toContain("paths:");
    expect(knowledge.value?.body).toContain("# Scoped rule");
    expect(JSON.parse(knowledge.value?.scopeJson ?? "{}")).toEqual({
      repository: repositoryId,
      paths: ["packages/*/src/**/*.ts"],
      symbols: [],
    });
    expect(knowledge.value?.approvedAt).toBeNull();
    expect(knowledge.value?.canonicalPath).toBeNull();

    const searchDocument = await getSearchDocumentByEntityId(db, entity.id);
    expect(searchDocument.ok).toBe(true);
    if (searchDocument.ok) {
      expect(searchDocument.value?.body).toContain("Body text.");
    }
  });

  it("defaults the scope paths to an empty list for a doc with no frontmatter", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "AGENTS.md"), "# Agents\n\nNo frontmatter here.", "utf8");

    const result = await importRepositoryDocs(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const entity = imported.value[0];
    expect(entity).toBeDefined();
    if (!entity) return;
    const knowledge = await getKnowledgeItemById(db, entity.id);
    expect(knowledge.ok).toBe(true);
    if (knowledge.ok) {
      expect(JSON.parse(knowledge.value?.scopeJson ?? "{}").paths).toEqual([]);
    }
  });
});
