import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  insertEntity,
  insertRelation,
  openDatabase,
  upsertCanonicalDocument,
  upsertSearchDocument,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpSearch } from "./search.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("mcpSearch", () => {
  const clock = new FixedClock(T0);
  const random = new CryptoRandomSource();
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("returns approved entities matching the lexical query and flags degraded mode", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const decId = makeTypedId("dec", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    expect(
      (
        await insertEntity(db.value, {
          id: decId,
          repositoryId: repo.repositoryId,
          entityType: "decision",
          title: "Use libSQL",
          status: "approved",
          authority: 100,
          sourceKind: "canonical",
          createdAt: iso,
          updatedAt: iso,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await upsertSearchDocument(db.value, {
          id: makeTypedId("sdoc", clock, random),
          entityId: decId,
          documentKind: "decision",
          title: "Use libSQL",
          body: "We will use libsql as the local index",
          authority: 100,
          contentHash: "sha256:h1",
          indexedAt: iso,
        })
      ).ok,
    ).toBe(true);
    await closeDatabase(db.value);

    const res = await mcpSearch({ cwd: repo.repoDir, clock, random, query: "libsql" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.effectiveMode).toBe("lexical");
    expect(res.value.results.map((r) => r.id)).toContain(decId);

    const degraded = await mcpSearch({
      cwd: repo.repoDir,
      clock,
      random,
      query: "libsql",
      mode: "hybrid",
    });
    expect(degraded.ok).toBe(true);
    if (degraded.ok) expect(degraded.value.degradedFrom).toBe("hybrid");
  }, 15000);

  it("excludes entities below the minimum authority", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const lowId = makeTypedId("dec", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: lowId,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "Low authority note",
      status: "approved",
      authority: 30,
      sourceKind: "hook",
      createdAt: iso,
      updatedAt: iso,
    });
    await upsertSearchDocument(db.value, {
      id: makeTypedId("sdoc", clock, random),
      entityId: lowId,
      documentKind: "decision",
      title: "Low authority note",
      body: "obscureterm content",
      authority: 30,
      contentHash: "sha256:h2",
      indexedAt: iso,
    });
    await closeDatabase(db.value);

    const res = await mcpSearch({ cwd: repo.repoDir, clock, random, query: "obscureterm" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.results.map((r) => r.id)).not.toContain(lowId);
  }, 15000);

  it("boosts a path-scoped match and enriches sources, relations, whyRelevant, and body", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const decId = makeTypedId("dec", clock, random);
    const otherId = makeTypedId("dec", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: decId,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "Payments retry policy",
      summary: "retry with bounded backoff",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    await insertEntity(db.value, {
      id: otherId,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "Related note",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    await upsertSearchDocument(db.value, {
      id: makeTypedId("sdoc", clock, random),
      entityId: decId,
      documentKind: "decision",
      title: "Payments retry policy",
      body: "retry policy for the payments service",
      authority: 100,
      contentHash: "sha256:h",
      indexedAt: iso,
    });
    await upsertCanonicalDocument(db.value, {
      entityId: decId,
      canonicalPath: "decisions/dec.md",
      revision: 1,
      frontmatterJson: JSON.stringify({
        scope: { paths: ["src/payments/**"], symbols: [] },
        labels: ["payments"],
        sources: [{ type: "pull_request", ref: "PR-1" }],
      }),
      body: "the canonical decision body",
      fileHash: "sha256:h",
      approvedAt: iso,
      importedAt: iso,
    });
    await insertRelation(db.value, {
      id: makeTypedId("rel", clock, random),
      repositoryId: repo.repositoryId,
      fromEntityId: decId,
      relationType: "RELATED_TO",
      toEntityId: otherId,
      sourceKind: "canonical",
      createdAt: iso,
    });
    await closeDatabase(db.value);

    const res = await mcpSearch({
      cwd: repo.repoDir,
      clock,
      random,
      query: "payments",
      includeBody: true,
      filters: { paths: ["src/payments/service.ts"] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.value.results.find((r) => r.id === decId);
    expect(hit).toBeDefined();
    expect(hit?.whyRelevant).toContain("same path scope");
    expect(hit?.sources).toEqual([{ type: "pull_request", ref: "PR-1" }]);
    expect(hit?.relations.map((r) => r.entityId)).toContain(otherId);
    expect(hit?.body).toBe("the canonical decision body");
  }, 15000);
});
