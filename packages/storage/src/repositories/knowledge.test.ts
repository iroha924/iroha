import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { insertEntity, insertRepository } from "./identity.js";
import {
  getCandidateById,
  getKnowledgeItemById,
  insertApproval,
  insertCandidate,
  listApprovalsByCandidate,
  listApprovedRulesForRepository,
  listCandidatesByStatus,
  updateCandidatePayload,
  updateCandidateStatus,
  upsertKnowledgeItem,
} from "./knowledge.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function candId(suffix: string): TypedId<"cand"> {
  return `cand_${suffix.padEnd(25, "0")}` as TypedId<"cand">;
}
function aprId(suffix: string): TypedId<"apr"> {
  return `apr_${suffix.padEnd(26, "0")}` as TypedId<"apr">;
}

async function seedRepository(db: Database, suffix: string): Promise<TypedId<"repo">> {
  const id = repoId(suffix);
  await insertRepository(db, {
    id,
    rootFingerprint: `fp-${suffix}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("knowledge repositories", () => {
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

  it("upserts an advisory knowledge item and reads it back", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "a");
    const id = "dec_0000000000000000000000020";
    await insertEntity(db, {
      id,
      repositoryId,
      entityType: "decision",
      title: "Use libSQL",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const inserted = await upsertKnowledgeItem(db, {
      id,
      knowledgeType: "decision",
      body: "We use libSQL for the local index.",
      scopeJson: "{}",
      enforcement: "advisory",
      approvedAt: NOW,
      canonicalPath: "knowledge/decisions/dec_0000000000000000000000020.md",
    });
    expect(inserted.ok).toBe(true);

    const read = await getKnowledgeItemById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.enforcement).toBe("advisory");
      expect(read.value?.guardSpecJson).toBeNull();
      expect(read.value?.severity).toBeNull();
      expect(read.value?.canonicalPath).toBe(
        "knowledge/decisions/dec_0000000000000000000000020.md",
      );
    }
  });

  it("upserts a guardrail knowledge item with its required guard spec", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b");
    const id = "rul_0000000000000000000000021";
    await insertEntity(db, {
      id,
      repositoryId,
      entityType: "rule",
      title: "No secrets in commits",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const inserted = await upsertKnowledgeItem(db, {
      id,
      knowledgeType: "rule",
      body: "Never commit secrets.",
      scopeJson: "{}",
      enforcement: "guardrail",
      guardSpecJson: '{"tools":["Bash"],"paths":[]}',
      severity: "error",
      approvedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const read = await getKnowledgeItemById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.enforcement).toBe("guardrail");
      expect(read.value?.guardSpecJson).toBe('{"tools":["Bash"],"paths":[]}');
      expect(read.value?.severity).toBe("error");
    }
  });

  it("lists approved rules with null severity on a DB from before migration 004", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "presev");
    const id = "rul_0000000000000000000000022";
    await insertEntity(db, {
      id,
      repositoryId,
      entityType: "rule",
      title: "Validate boundaries",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await upsertKnowledgeItem(db, {
      id,
      knowledgeType: "rule",
      body: "Validate every boundary.",
      scopeJson: "{}",
      enforcement: "advisory",
      severity: "warning",
    });

    // Simulate the pre-004 schema: the hook guardrail path and the MCP server
    // read an un-migrated DB, so the query must not error on the missing column.
    await db.execute("ALTER TABLE knowledge_items DROP COLUMN severity");

    const listed = await listApprovedRulesForRepository(db, repositoryId);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((r) => r.id)).toEqual([id]);
      expect(listed.value[0]?.severity).toBe(null);
    }
  });

  it("returns null for a knowledge item that does not exist", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;

    const result = await getKnowledgeItemById(db, "dec_missing00000000000000000");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("inserts a candidate pending and lists it in the repository's review queue", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "c");
    const id = candId("c");

    const inserted = await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: '{"title":"Use libSQL"}',
      revisionToken: "rev-1",
      createdAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const read = await getCandidateById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("pending");
      expect(read.value?.revisionToken).toBe("rev-1");
    }

    const queue = await listCandidatesByStatus(db, repositoryId, "pending");
    expect(queue.ok).toBe(true);
    if (queue.ok) {
      expect(queue.value.map((c) => c.id)).toEqual([id]);
    }
  });

  it("orders same-timestamp candidates deterministically by id, not arbitrarily", async () => {
    // dashboard-api.md §4: "deterministic sort with ID tie-breaker" —
    // several candidates can share created_at, e.g. one Checkpoint
    // producing multiple proposals at once.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "c2");
    const idA = candId("c2a");
    const idB = candId("c2b");
    await insertCandidate(db, {
      id: idB,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });
    await insertCandidate(db, {
      id: idA,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });

    const queue1 = await listCandidatesByStatus(db, repositoryId, "pending");
    const queue2 = await listCandidatesByStatus(db, repositoryId, "pending");
    expect(queue1.ok).toBe(true);
    expect(queue2.ok).toBe(true);
    if (queue1.ok && queue2.ok) {
      expect(queue1.value.map((c) => c.id)).toEqual(queue2.value.map((c) => c.id));
      expect(queue1.value.map((c) => c.id)).toEqual([idB, idA]);
    }
  });

  it("approves a candidate through the domain transition validator, rotating its revision token", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "d");
    const id = candId("d");
    await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });

    const result = await updateCandidateStatus(db, id, {
      from: "pending",
      to: "approved",
      expectedRevisionToken: "rev-1",
      newRevisionToken: "rev-2",
      reviewedAt: LATER,
    });
    expect(result.ok).toBe(true);

    const read = await getCandidateById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("approved");
      expect(read.value?.revisionToken).toBe("rev-2");
      expect(read.value?.reviewedAt).toBe(LATER);
    }
  });

  it("rejects an illegal candidate status transition before touching the database", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "e");
    const id = candId("e");
    await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });
    await updateCandidateStatus(db, id, {
      from: "pending",
      to: "rejected",
      expectedRevisionToken: "rev-1",
      newRevisionToken: "rev-2",
      reviewedAt: LATER,
    });

    // "rejected" -> "approved" is not in the domain's allowed transition set.
    const result = await updateCandidateStatus(db, id, {
      from: "rejected",
      to: "approved",
      expectedRevisionToken: "rev-2",
      newRevisionToken: "rev-3",
      reviewedAt: LATER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("fails with CONFLICT when the revision token is stale (concurrent modification)", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f");
    const id = candId("f");
    await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });
    // Someone else already edited the candidate, bumping its revision token.
    await updateCandidatePayload(db, id, {
      expectedRevisionToken: "rev-1",
      newRevisionToken: "rev-2",
      payloadJson: '{"title":"edited"}',
    });

    const result = await updateCandidateStatus(db, id, {
      from: "pending",
      to: "approved",
      expectedRevisionToken: "rev-1", // stale
      newRevisionToken: "rev-3",
      reviewedAt: LATER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
    const read = await getCandidateById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("pending");
      expect(read.value?.revisionToken).toBe("rev-2");
    }
  });

  it("fails with CONFLICT when editing the payload of a candidate that already left pending", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f2");
    const id = candId("f2");
    await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });
    const approved = await updateCandidateStatus(db, id, {
      from: "pending",
      to: "approved",
      expectedRevisionToken: "rev-1",
      newRevisionToken: "rev-2",
      reviewedAt: LATER,
    });
    expect(approved.ok).toBe(true);

    // dashboard-api.md describes PATCH /candidates/:id as editing a draft;
    // once approved, the payload must be fixed even with a fresh, correct
    // revision token.
    const result = await updateCandidatePayload(db, id, {
      expectedRevisionToken: "rev-2",
      newRevisionToken: "rev-3",
      payloadJson: '{"title":"edited after approval"}',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
    const read = await getCandidateById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.payloadJson).toBe("{}");
      expect(read.value?.revisionToken).toBe("rev-2");
    }
  });

  it("inserts approvals and lists them for a candidate in created_at order", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "g");
    const id = candId("g");
    await insertCandidate(db, {
      id,
      repositoryId,
      candidateType: "decision",
      payloadJson: "{}",
      revisionToken: "rev-1",
      createdAt: NOW,
    });

    await insertApproval(db, {
      id: aprId("g1"),
      candidateId: id,
      action: "edit",
      comment: "tweaked wording",
      createdAt: NOW,
    });
    await insertApproval(db, {
      id: aprId("g2"),
      candidateId: id,
      action: "approve",
      createdAt: LATER,
    });

    const list = await listApprovalsByCandidate(db, id);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.map((a) => a.action)).toEqual(["edit", "approve"]);
    }
  });
});
