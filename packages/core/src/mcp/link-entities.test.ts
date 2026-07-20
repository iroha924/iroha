import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { closeDatabase, getNeighbors, insertEntity, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpLinkEntities } from "./link-entities.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

async function seedEntity(dbPath: string, repo: McpTestRepo, id: string): Promise<void> {
  const db = await openDatabase(dbPath);
  if (!db.ok) {
    throw new Error("open failed");
  }
  const iso = clock.now().toISOString();
  const entity = await insertEntity(db.value, {
    id,
    repositoryId: repo.repositoryId,
    entityType: "decision",
    title: `Entity ${id}`,
    status: "approved",
    authority: 100,
    sourceKind: "canonical",
    createdAt: iso,
    updatedAt: iso,
  });
  await closeDatabase(db.value);
  if (!entity.ok) {
    throw new Error(`seed entity: ${entity.error.code}`);
  }
}

describe("mcpLinkEntities", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("creates an inferred relation between two existing entities", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const fromId = makeTypedId("dec", clock, random);
    const toId = makeTypedId("dec", clock, random);
    await seedEntity(repo.dbPath, repo, fromId);
    await seedEntity(repo.dbPath, repo, toId);

    const result = await mcpLinkEntities({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-link-000000000001",
      fromEntityId: fromId,
      relationType: "APPLIES_TO",
      toEntityId: toId,
      evidence: "the rule applies to this decision",
      confidence: 0.9,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deduplicated).toBe(false);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const neighbors = await getNeighbors(db.value, fromId, {});
    expect(neighbors.ok && neighbors.value.length).toBe(1);
    await closeDatabase(db.value);
  }, 15000);

  it("rejects a self-relation unless the type is RELATED_TO", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const id = makeTypedId("dec", clock, random);
    await seedEntity(repo.dbPath, repo, id);

    const rejected = await mcpLinkEntities({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-link-000000000002",
      fromEntityId: id,
      relationType: "APPLIES_TO",
      toEntityId: id,
      evidence: "self loop",
      confidence: 0.5,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("INVALID_INPUT");
    }

    const allowed = await mcpLinkEntities({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-link-000000000003",
      fromEntityId: id,
      relationType: "RELATED_TO",
      toEntityId: id,
      evidence: "self relation is allowed for RELATED_TO",
      confidence: 0.5,
    });
    expect(allowed.ok).toBe(true);
  }, 15000);

  it("rejects an unknown entity id with NOT_FOUND", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const fromId = makeTypedId("dec", clock, random);
    await seedEntity(repo.dbPath, repo, fromId);

    const result = await mcpLinkEntities({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-link-000000000004",
      fromEntityId: fromId,
      relationType: "RELATED_TO",
      toEntityId: makeTypedId("dec", clock, random),
      evidence: "points at a missing entity",
      confidence: 0.5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  }, 15000);

  it("returns the real stored relationId when the tuple already exists under a different key", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const fromId = makeTypedId("dec", clock, random);
    const toId = makeTypedId("dec", clock, random);
    await seedEntity(repo.dbPath, repo, fromId);
    await seedEntity(repo.dbPath, repo, toId);

    const base = {
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      fromEntityId: fromId,
      relationType: "RELATED_TO" as const,
      toEntityId: toId,
      evidence: "the same edge twice",
      confidence: 0.9,
    };
    const first = await mcpLinkEntities({ ...base, idempotencyKey: "idem-link-000000000010" });
    const second = await mcpLinkEntities({ ...base, idempotencyKey: "idem-link-000000000011" });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Different idempotency keys, but the (from, RELATED_TO, to, inferred) tuple
    // already exists → the second call must return the SAME real relation id
    // (the ON CONFLICT DO NOTHING insert stored nothing new), not a phantom.
    expect(second.value.relationId).toBe(first.value.relationId);
  }, 15000);
});
