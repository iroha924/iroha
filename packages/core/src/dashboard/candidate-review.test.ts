import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import {
  closeDatabase,
  getCandidateById,
  listApprovalsByCandidate,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { decisionDraft, seedCandidate } from "../test-helpers/candidate.js";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { editCandidate, rejectCandidate, supersedeCandidate } from "./candidate-review.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

describe("candidate review mutations", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("rejects a pending candidate and audits the rejection", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await rejectCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      reason: "Not needed",
    });
    expect(result.ok && result.value.status).toBe("rejected");

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const candidate = await getCandidateById(db.value, candidateId);
    const approvals = await listApprovalsByCandidate(db.value, candidateId);
    await closeDatabase(db.value);
    expect(candidate.ok && candidate.value?.status).toBe("rejected");
    expect(approvals.ok && approvals.value[0]?.action).toBe("reject");
  });

  it("edits a draft, returns a fresh token, and invalidates the old one", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const edited = await editCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      draft: decisionDraft({ title: "Adopt libSQL" }),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.revisionToken).not.toBe(revisionToken);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const candidate = await getCandidateById(db.value, candidateId);
    await closeDatabase(db.value);
    expect(candidate.ok && candidate.value?.payloadJson).toContain("Adopt libSQL");
    expect(candidate.ok && candidate.value?.revisionToken).toBe(edited.value.revisionToken);

    // The stale token can no longer edit.
    const stale = await editCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      draft: decisionDraft({ title: "Third title" }),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");
  });

  it("supersedes a pending candidate", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await supersedeCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
    });
    expect(result.ok && result.value.status).toBe("superseded");

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const candidate = await getCandidateById(db.value, candidateId);
    await closeDatabase(db.value);
    expect(candidate.ok && candidate.value?.status).toBe("superseded");
  });
});
