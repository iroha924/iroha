import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { closeDatabase, insertEntity, insertRelation, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpGetRelations } from "./get-relations.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("mcpGetRelations", () => {
  const clock = new FixedClock(T0);
  const random = new CryptoRandomSource();
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("returns the bounded graph (nodes and edges) around an entity", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const a = makeTypedId("dec", clock, random);
    const b = makeTypedId("con", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: a,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "A",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    await insertEntity(db.value, {
      id: b,
      repositoryId: repo.repositoryId,
      entityType: "concept",
      title: "B",
      status: "approved",
      authority: 80,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    expect(
      (
        await insertRelation(db.value, {
          id: makeTypedId("rel", clock, random),
          repositoryId: repo.repositoryId,
          fromEntityId: a,
          relationType: "RELATED_TO",
          toEntityId: b,
          sourceKind: "human",
          createdAt: iso,
        })
      ).ok,
    ).toBe(true);
    await closeDatabase(db.value);

    const res = await mcpGetRelations({ cwd: repo.repoDir, clock, random, entityIds: [a] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.edges).toHaveLength(1);
    expect(res.value.edges[0]?.from).toBe(a);
    expect(res.value.edges[0]?.to).toBe(b);
    expect(res.value.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());
    expect(res.value.truncated).toBe(false);
  }, 15000);

  it("reports truncated when a root has more relations than maxEdges", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const root = makeTypedId("dec", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: root,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "root",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    for (let i = 0; i < 5; i++) {
      const target = makeTypedId("con", clock, random);
      await insertEntity(db.value, {
        id: target,
        repositoryId: repo.repositoryId,
        entityType: "concept",
        title: `t${i}`,
        status: "approved",
        authority: 80,
        sourceKind: "canonical",
        createdAt: iso,
        updatedAt: iso,
      });
      await insertRelation(db.value, {
        id: makeTypedId("rel", clock, random),
        repositoryId: repo.repositoryId,
        fromEntityId: root,
        relationType: "RELATED_TO",
        toEntityId: target,
        sourceKind: "human",
        createdAt: iso,
      });
    }
    await closeDatabase(db.value);

    const res = await mcpGetRelations({
      cwd: repo.repoDir,
      clock,
      random,
      entityIds: [root],
      maxEdges: 3,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.edges).toHaveLength(3);
    expect(res.value.truncated).toBe(true);
  }, 15000);
});
