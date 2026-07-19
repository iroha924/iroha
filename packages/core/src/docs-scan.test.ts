import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, makeTypedId, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  getCandidateById,
  insertRepository,
  listCandidatesByStatus,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { scanDocsIntoCandidates } from "./docs-scan.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("scanDocsIntoCandidates", () => {
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
      rootFingerprint: "fp-docs-scan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!inserted.ok) {
      throw new Error(`failed to seed repository: ${inserted.error.message}`);
    }
    return { repositoryRoot: tempDir, repositoryId };
  }

  it("scans AGENTS.md/CLAUDE.md at the repository root, deduplicating unchanged content", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "AGENTS.md"), "# Agents\n\nFollow these rules.", "utf8");
    await writeFile(join(repositoryRoot, "CLAUDE.md"), "# Claude\n\nProject instructions.", "utf8");

    const first = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.docsScanned.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(first.value.candidatesCreated).toBe(2);
    }

    const rerun = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(rerun.ok).toBe(true);
    if (rerun.ok) {
      expect(rerun.value.candidatesCreated).toBe(0);
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

    const result = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.docsScanned.sort()).toEqual([
        ".claude/rules/nested/deep.md",
        ".claude/rules/top.md",
      ]);
      expect(result.value.candidatesCreated).toBe(2);
    }
  });

  it("does not fail when .claude/rules/ does not exist", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;

    const result = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.docsScanned).toEqual([]);
    }
  });

  it("extracts a rule file's frontmatter paths as detected_scope, and retains source/content_hash/imported_at/line_range", async () => {
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

    const result = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidatesCreated).toBe(1);

    const pending = await listCandidatesByStatus(db, repositoryId, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const candidate = pending.value.find((c) => c.payloadJson.includes("scoped.md"));
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const payload = JSON.parse(candidate.payloadJson) as {
      body: string;
      source: { type: string; path: string; content_hash: string };
      imported_at: string;
      line_range: { start: number; end: number };
      detected_scope: { paths: string[] };
    };
    expect(payload.body).not.toContain("paths:");
    expect(payload.body).toContain("# Scoped rule");
    expect(payload.source).toEqual({
      type: "document",
      path: ".claude/rules/scoped.md",
      content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(payload.imported_at).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.line_range.start).toBe(1);
    expect(payload.line_range.end).toBeGreaterThan(1);
    expect(payload.detected_scope).toEqual({ paths: ["packages/*/src/**/*.ts"] });

    const fetched = await getCandidateById(db, candidate.id);
    expect(fetched.ok).toBe(true);
  });

  it("defaults detected_scope to an empty paths list for a doc with no frontmatter", async () => {
    const { repositoryRoot, repositoryId } = await setup();
    if (!db) return;
    await writeFile(join(repositoryRoot, "AGENTS.md"), "# Agents\n\nNo frontmatter here.", "utf8");

    const result = await scanDocsIntoCandidates(
      db,
      repositoryRoot,
      repositoryId,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pending = await listCandidatesByStatus(db, repositoryId, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const payload = JSON.parse(pending.value[0]?.payloadJson ?? "{}") as {
      detected_scope: { paths: string[] };
    };
    expect(payload.detected_scope).toEqual({ paths: [] });
  });
});
