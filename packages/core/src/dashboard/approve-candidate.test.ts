import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeCanonicalPath } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import {
  closeDatabase,
  getCandidateById,
  getCanonicalDocumentByEntityId,
  getEntityById,
  listApprovalsByCandidate,
  listOpenDirtyMarkers,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { decisionDraft, seedCandidate, VALID_DECISION_BODY } from "../test-helpers/candidate.js";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { approveCandidate } from "./approve-candidate.js";
import { buildCanonicalDocumentFromCandidate } from "./build-canonical.js";

/** The absolute path the deterministic id will target for this candidate. */
function canonicalPathFor(
  repoDir: string,
  repositoryId: McpTestRepo["repositoryId"],
  candidateId: string,
): string {
  const built = buildCanonicalDocumentFromCandidate({
    candidateType: "decision",
    draft: decisionDraft(),
    repositoryId,
    candidateId,
    createdBy: { provider: "local", display_name: "x" },
    approvedBy: { provider: "git", display_name: "y" },
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    provenance: [],
  });
  if (!built.ok) throw new Error(`build failed: ${built.error.code}`);
  return join(repoDir, ".iroha", computeCanonicalPath(built.value));
}

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

const PRIVATE_KEY_BODY =
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
const SECRET_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

describe("approveCandidate", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("writes the canonical file, marks the entity approved (authority 100), and audits the approval", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await approveCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
      comment: "Verified",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`approve failed: ${result.error.code}: ${result.error.message}`);
    }
    expect(result.value.type).toBe("decision");
    expect(result.value.canonicalPath).toMatch(/^decisions\/dec_[0-9A-Z]+\.md$/);

    // Canonical file exists and round-trips the title + approval metadata.
    const filePath = join(repo.repoDir, ".iroha", result.value.canonicalPath);
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("# Use libSQL as the local index");
    expect(content).toContain("status: approved");
    expect(content).toContain("Example Reviewer"); // approved_by (the reviewer)
    expect(content).toContain("iroha agent"); // created_by (the proposing agent)

    // DB reflects an approved canonical entity at authority 100.
    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const entity = await getEntityById(db.value, result.value.entityId);
    const doc = await getCanonicalDocumentByEntityId(db.value, result.value.entityId);
    const candidate = await getCandidateById(db.value, candidateId);
    const approvals = await listApprovalsByCandidate(db.value, candidateId);
    await closeDatabase(db.value);

    expect(entity.ok && entity.value?.authority).toBe(100);
    expect(entity.ok && entity.value?.status).toBe("approved");
    expect(entity.ok && entity.value?.entityType).toBe("decision");
    expect(doc.ok && doc.value?.canonicalPath).toBe(result.value.canonicalPath);
    expect(candidate.ok && candidate.value?.status).toBe("approved");
    expect(approvals.ok && approvals.value.length).toBe(1);
    expect(approvals.ok && approvals.value[0]?.action).toBe("approve");
  });

  it("still approves when the target canonical file already exists (crash-then-retry overwrites)", async () => {
    // The cross-process guard aborts only when the file exists AND the candidate is
    // no longer pending. A same-process retry after a crash (file already written,
    // candidate still pending) must proceed and overwrite its own file — the
    // idempotent-retry behavior the deterministic id exists for. (The abort branch is reachable
    // only via a concurrent cross-process commit between the reload and the guard,
    // which is not deterministically unit-testable — the same class as the write-mutex note.)
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );
    const targetPath = canonicalPathFor(repo.repoDir, repo.repositoryId, candidateId);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "stale content from a crashed prior attempt\n");

    const result = await approveCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`approve failed: ${result.error.code}: ${result.error.message}`);
    }
    // The stale file was overwritten with the real approved document.
    const content = await readFile(
      join(repo.repoDir, ".iroha", result.value.canonicalPath),
      "utf8",
    );
    expect(content).toContain("status: approved");
    expect(content).not.toContain("stale content");
  });

  it("rejects a stale revision token with CONFLICT and leaves the candidate pending", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await approveCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken: "not-the-real-token",
      actor: { provider: "git", displayName: "Reviewer" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const candidate = await getCandidateById(db.value, candidateId);
    await closeDatabase(db.value);
    expect(candidate.ok && candidate.value?.status).toBe("pending");
  });

  it("blocks approval when the body contains a detected secret, writing no file and no DB change", async () => {
    repo = await setupMcpRepo(random);
    const secretBody = VALID_DECISION_BODY.replace(
      "We need a rebuildable local index.",
      SECRET_BLOCK,
    );
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft({ body: secretBody }),
      clock,
      random,
    );

    const result = await approveCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      actor: { provider: "git", displayName: "Reviewer" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const candidate = await getCandidateById(db.value, candidateId);
    const dirty = await listOpenDirtyMarkers(db.value, repo.repositoryId);
    await closeDatabase(db.value);
    // Secret detection fails BEFORE the file write, so nothing diverges.
    expect(candidate.ok && candidate.value?.status).toBe("pending");
    expect(dirty.ok && dirty.value.length).toBe(0);
  });

  it("rejects Session Summary candidates from the review queue", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId, revisionToken } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "session_summary",
      decisionDraft({ type: "decision" }),
      clock,
      random,
    );

    const result = await approveCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId,
      revisionToken,
      actor: { provider: "git", displayName: "Reviewer" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
  });
});
