import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

  function importDocs(database: Database, repositoryRoot: string, repositoryId: TypedId<"repo">) {
    return importRepositoryDocs(
      database,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
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

  it("does not follow a symlinked .claude/rules or root doc out of the repository", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    const outside = join(repositoryRoot, "..", "outside-the-repo");
    await mkdir(join(outside, "rules"), { recursive: true });
    await writeFile(join(outside, "rules", "leaked.md"), "OUTSIDE-RULE-BODY", "utf8");
    await writeFile(join(outside, "root-target.md"), "OUTSIDE-ROOT-BODY", "utf8");
    await mkdir(join(repositoryRoot, ".claude"), { recursive: true });
    await symlink(join(outside, "rules"), join(repositoryRoot, ".claude", "rules"));
    await symlink(join(outside, "root-target.md"), join(repositoryRoot, "AGENTS.md"));

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsImported).toEqual([]);
    expect(result.value.entitiesWritten).toBe(0);
    expect(result.value.docsSkipped).toBe(2);

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value).toEqual([]);
    }
  });

  it("records a symlink that stays inside the repository under its real path", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, "shared"), { recursive: true });
    await mkdir(join(repositoryRoot, ".claude"), { recursive: true });
    await writeFile(join(repositoryRoot, "shared", "inside.md"), "# Inside", "utf8");
    await symlink(join(repositoryRoot, "shared"), join(repositoryRoot, ".claude", "rules"));

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsImported).toEqual(["shared/inside.md"]);
    expect(result.value.docsSkipped).toBe(0);
  });

  it("skips an unreadable document instead of throwing out of the Result", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    const unreadable = join(repositoryRoot, ".claude", "rules", "locked.md");
    await writeFile(unreadable, "# Locked", "utf8");
    await chmod(unreadable, 0o000);
    // A directory where a root doc is expected, and a symlink that loops.
    await mkdir(join(repositoryRoot, "CLAUDE.md"), { recursive: true });
    await symlink(join(repositoryRoot, "AGENTS.md"), join(repositoryRoot, "AGENTS.md"));

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsImported).toEqual([]);

    await chmod(unreadable, 0o644);
  });

  it("reads frontmatter from a CRLF checkout and from a file with a BOM", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    await writeFile(
      join(repositoryRoot, ".claude", "rules", "crlf.md"),
      ["---", "paths:", '  - "packages/*/src/**/*.ts"', "---", "", "# CRLF rule"].join("\r\n"),
      "utf8",
    );
    await writeFile(
      join(repositoryRoot, ".claude", "rules", "bom.md"),
      `﻿${["---", "paths:", '  - "apps/**/*.tsx"', "---", "", "# BOM rule"].join("\n")}`,
      "utf8",
    );

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entitiesWritten).toBe(2);

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const byPath = new Map(imported.value.map((e) => [e.sourceRef, e.id]));
    for (const [path, expectedPaths] of [
      [".claude/rules/crlf.md", ["packages/*/src/**/*.ts"]],
      [".claude/rules/bom.md", ["apps/**/*.tsx"]],
    ] as const) {
      const id = byPath.get(path);
      expect(id).toBeDefined();
      const knowledge = await getKnowledgeItemById(db, id ?? "");
      expect(knowledge.ok).toBe(true);
      if (!knowledge.ok) return;
      expect(JSON.parse(knowledge.value?.scopeJson ?? "{}").paths).toEqual(expectedPaths);
      expect(knowledge.value?.body).not.toContain("paths:");
      expect(knowledge.value?.body).not.toContain("\r");
    }
  });

  it("tombstones an entity whose source document was deleted or renamed", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    const oldPath = join(repositoryRoot, ".claude", "rules", "old.md");
    await writeFile(oldPath, "# Old rule", "utf8");

    const first = await importDocs(db, repositoryRoot, repositoryId);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.entitiesTombstoned).toBe(0);
    }

    await rm(oldPath);
    await writeFile(join(repositoryRoot, ".claude", "rules", "new.md"), "# Old rule", "utf8");

    const second = await importDocs(db, repositoryRoot, repositoryId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.entitiesTombstoned).toBe(1);

    const stillImported = await listImported(db, repositoryId);
    expect(stillImported.ok).toBe(true);
    if (!stillImported.ok) return;
    expect(stillImported.value.map((e) => e.sourceRef)).toEqual([".claude/rules/new.md"]);

    const tombstoned = await listKnowledgeEntities(db, repositoryId, {
      statuses: ["tombstoned"],
      limit: 10,
    });
    expect(tombstoned.ok).toBe(true);
    if (tombstoned.ok) {
      expect(tombstoned.value.map((e) => e.sourceRef)).toEqual([".claude/rules/old.md"]);
    }
  });

  it("revives a tombstoned entity when its document comes back unchanged", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    const path = join(repositoryRoot, "CLAUDE.md");
    await writeFile(path, "# Claude\n\nBody.", "utf8");
    await importDocs(db, repositoryRoot, repositoryId);
    await rm(path);
    await importDocs(db, repositoryRoot, repositoryId);

    await writeFile(path, "# Claude\n\nBody.", "utf8");
    const revived = await importDocs(db, repositoryRoot, repositoryId);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    // The content hash still matches, so only the status check can bring it back.
    expect(revived.value.entitiesWritten).toBe(1);

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value.map((e) => e.sourceRef)).toEqual(["CLAUDE.md"]);
    }
  });

  it("keeps a rule that is a symlink to another path inside the repository", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    await mkdir(join(repositoryRoot, "shared"), { recursive: true });
    await writeFile(join(repositoryRoot, "shared", "linked.md"), "# Linked rule", "utf8");
    // `Dirent.isFile()` is false for a symlink, so filtering on it alone drops
    // a perfectly valid in-repository rule before containment is ever checked.
    await symlink(
      join(repositoryRoot, "shared", "linked.md"),
      join(repositoryRoot, ".claude", "rules", "linked.md"),
    );

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsImported).toEqual(["shared/linked.md"]);
  });

  it("withholds a document whose text trips the secret scan", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    const keyBody =
      "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n-----END RSA PRIVATE KEY-----`;
    await writeFile(join(repositoryRoot, "CLAUDE.md"), `# Project\n\n${key}\n`, "utf8");

    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docsWithheld).toBe(1);
    expect(result.value.docsImported).toEqual([]);

    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value).toEqual([]);
    }
  });

  it("does not tombstone a document it merely failed to read this run", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await mkdir(join(repositoryRoot, ".claude", "rules"), { recursive: true });
    const rule = join(repositoryRoot, ".claude", "rules", "flaky.md");
    await writeFile(rule, "# Flaky rule", "utf8");
    await importDocs(db, repositoryRoot, repositoryId);

    // The file is still there; only this run cannot read it. Treating that as a
    // deletion would pull a live rule out of retrieval.
    await chmod(rule, 0o000);
    const result = await importDocs(db, repositoryRoot, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entitiesTombstoned).toBe(0);
    await chmod(rule, 0o644);

    const stillImported = await listImported(db, repositoryId);
    expect(stillImported.ok).toBe(true);
    if (stillImported.ok) {
      expect(stillImported.value.map((e) => e.sourceRef)).toEqual([".claude/rules/flaky.md"]);
    }
  });

  it("queues an embedding job so vector-only search can reach imported rules", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "CLAUDE.md"), "# Project\n\nRun the tests.\n", "utf8");

    await importDocs(db, repositoryRoot, repositoryId);
    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const entityId = imported.value[0]?.id ?? "";
    const searchDocument = await getSearchDocumentByEntityId(db, entityId);
    expect(searchDocument.ok).toBe(true);
    if (!searchDocument.ok || searchDocument.value === null) return;

    const jobs = await db.execute({
      sql: "SELECT provider, model FROM embedding_jobs WHERE search_document_id = ?",
      args: [searchDocument.value.id],
    });
    expect(jobs.rows.length).toBe(1);
    expect(jobs.rows[0]?.provider).toBe("voyage");
  });

  it("gives an imported entity a summary so search results are not blank", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(
      join(repositoryRoot, "CLAUDE.md"),
      "# Heading only\n\nThe first real sentence.\n",
      "utf8",
    );

    await importDocs(db, repositoryRoot, repositoryId);
    const imported = await listImported(db, repositoryId);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value[0]?.summary).toBe("The first real sentence.");
    }
  });
});
