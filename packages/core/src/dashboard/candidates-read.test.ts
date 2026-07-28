import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { decisionDraft, seedCandidate, VALID_DECISION_BODY } from "../test-helpers/candidate.js";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { rejectCandidate } from "./candidate-review.js";
import { getCandidateDetail, listCandidateQueue } from "./candidates-read.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

const PRIVATE_KEY_BODY =
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
const SECRET_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

describe("candidate read", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("lists pending candidates in the review queue", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await listCandidateQueue({ cwd: repo.repoDir, clock, random });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.id)).toContain(candidateId);
    expect(result.value.items[0]?.type).toBe("decision");
  });

  // Without this, dropping the status predicate from the count query leaves
  // every core dashboard test green while the UI paginates over rows that the
  // requested tab does not contain.
  it("counts only the requested status, not every candidate", async () => {
    repo = await setupMcpRepo(random);
    const pending = [];
    for (let i = 0; i < 3; i += 1) {
      pending.push(
        await seedCandidate(
          repo.dbPath,
          repo.repositoryId,
          "decision",
          decisionDraft(),
          clock,
          random,
        ),
      );
    }
    const doomed = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );
    const rejected = await rejectCandidate({
      cwd: repo.repoDir,
      clock,
      random,
      candidateId: doomed.candidateId,
      revisionToken: doomed.revisionToken,
    });
    expect(rejected.ok).toBe(true);

    const pendingPage = await listCandidateQueue({ cwd: repo.repoDir, clock, random });
    const rejectedPage = await listCandidateQueue({
      cwd: repo.repoDir,
      clock,
      random,
      status: "rejected",
    });

    expect(pendingPage.ok && pendingPage.value.total).toBe(pending.length);
    expect(rejectedPage.ok && rejectedPage.value.total).toBe(1);
  });

  it("skips to a later page by offset without walking the cursor", async () => {
    repo = await setupMcpRepo(random);
    const seeded = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push(
        await seedCandidate(
          repo.dbPath,
          repo.repositoryId,
          "decision",
          decisionDraft(),
          clock,
          random,
        ),
      );
    }

    const firstPage = await listCandidateQueue({ cwd: repo.repoDir, clock, random, limit: 2 });
    const thirdPage = await listCandidateQueue({
      cwd: repo.repoDir,
      clock,
      random,
      limit: 2,
      offset: 4,
    });

    expect(firstPage.ok).toBe(true);
    expect(thirdPage.ok).toBe(true);
    if (!firstPage.ok || !thirdPage.ok) return;
    expect(thirdPage.value.items).toHaveLength(1);
    expect(thirdPage.value.total).toBe(seeded.length);
    // The offset page is genuinely further in, not the first page again.
    expect(thirdPage.value.items[0]?.id).not.toBe(firstPage.value.items[0]?.id);
  });

  // Stated in the contract, the route description and the storage docstring;
  // inverting the precedence must break something.
  it("lets the cursor win when both a cursor and an offset are given", async () => {
    repo = await setupMcpRepo(random);
    for (let i = 0; i < 5; i += 1) {
      await seedCandidate(
        repo.dbPath,
        repo.repositoryId,
        "decision",
        decisionDraft(),
        clock,
        random,
      );
    }

    const first = await listCandidateQueue({ cwd: repo.repoDir, clock, random, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.nextCursor === null) return;

    const withBoth = await listCandidateQueue({
      cwd: repo.repoDir,
      clock,
      random,
      limit: 2,
      cursor: first.value.nextCursor,
      offset: 100,
    });
    const cursorOnly = await listCandidateQueue({
      cwd: repo.repoDir,
      clock,
      random,
      limit: 2,
      cursor: first.value.nextCursor,
    });

    expect(withBoth.ok).toBe(true);
    expect(cursorOnly.ok).toBe(true);
    if (!withBoth.ok || !cursorOnly.ok) return;
    // Honouring the offset instead would skip past the end and return nothing.
    expect(withBoth.value.items.map((i) => i.id)).toEqual(cursorOnly.value.items.map((i) => i.id));
    expect(withBoth.value.items.length).toBeGreaterThan(0);
  });

  it("ignores a fractional offset rather than failing the query", async () => {
    repo = await setupMcpRepo(random);
    for (let i = 0; i < 3; i += 1) {
      await seedCandidate(
        repo.dbPath,
        repo.repositoryId,
        "decision",
        decisionDraft(),
        clock,
        random,
      );
    }

    const result = await listCandidateQueue({
      cwd: repo.repoDir,
      clock,
      random,
      limit: 2,
      offset: 1.5,
    });

    // Reaching SQLite it would raise a datatype mismatch and surface as a 500.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(2);
  });

  it("reports the full pending total, not the page size", async () => {
    repo = await setupMcpRepo(random);
    for (let i = 0; i < 3; i += 1) {
      await seedCandidate(
        repo.dbPath,
        repo.repositoryId,
        "decision",
        decisionDraft(),
        clock,
        random,
      );
    }

    const result = await listCandidateQueue({ cwd: repo.repoDir, clock, random, limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(2);
    expect(result.value.total).toBe(3);
    expect(result.value.nextCursor).not.toBeNull();
  });

  it("reports a valid draft as approvable with a canonical preview", async () => {
    repo = await setupMcpRepo(random);
    const { candidateId } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft(),
      clock,
      random,
    );

    const result = await getCandidateDetail({ cwd: repo.repoDir, clock, random, candidateId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.approvable).toBe(true);
    expect(result.value.validation.schemaValid).toBe(true);
    expect(result.value.validation.secretsClean).toBe(true);
    expect(result.value.canonicalPreview).toContain("# Use libSQL as the local index");
  });

  it("reports a draft containing a secret as not approvable, with masked findings", async () => {
    repo = await setupMcpRepo(random);
    const secretBody = VALID_DECISION_BODY.replace(
      "We need a rebuildable local index.",
      SECRET_BLOCK,
    );
    const { candidateId } = await seedCandidate(
      repo.dbPath,
      repo.repositoryId,
      "decision",
      decisionDraft({ body: secretBody }),
      clock,
      random,
    );

    const result = await getCandidateDetail({ cwd: repo.repoDir, clock, random, candidateId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.approvable).toBe(false);
    expect(result.value.validation.secretsClean).toBe(false);
    expect(result.value.validation.secretFindings.length).toBeGreaterThan(0);
    // The finding message is masked and must never contain the raw key body.
    expect(JSON.stringify(result.value.validation.secretFindings)).not.toContain(PRIVATE_KEY_BODY);
  });
});
