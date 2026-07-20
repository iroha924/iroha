import type { KnowledgeProposal } from "@iroha/domain";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { closeDatabase, listCandidatesByStatus, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpProposeKnowledge } from "./propose-knowledge.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

const PROPOSAL: KnowledgeProposal = {
  type: "rule",
  title: "Validate every external boundary",
  summary: "All external input is validated with Zod",
  body: "Every boundary crossing must be validated with a Zod schema and return a Result.",
  labels: ["typescript"],
  scope: { paths: [], symbols: [] },
  sources: [{ type: "commit", ref: "abc1234" }],
};

// Same known-detected private-key shape the canonical secret-scan test uses.
const PRIVATE_KEY_BODY =
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
const SECRET_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

describe("mcpProposeKnowledge", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("creates one pending candidate", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const result = await mcpProposeKnowledge({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-propose-00000001",
      proposal: PROPOSAL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deduplicated).toBe(false);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const candidates = await listCandidatesByStatus(db.value, repo.repositoryId, "pending");
    expect(candidates.ok && candidates.value.length).toBe(1);
    await closeDatabase(db.value);
  }, 15000);

  it("is idempotent on retry with the same key", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const key = "idem-propose-00000002";
    const first = await mcpProposeKnowledge({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: key,
      proposal: PROPOSAL,
    });
    const second = await mcpProposeKnowledge({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: key,
      proposal: PROPOSAL,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.candidateId).toBe(first.value.candidateId);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const candidates = await listCandidatesByStatus(db.value, repo.repositoryId, "pending");
    expect(candidates.ok && candidates.value.length).toBe(1);
    await closeDatabase(db.value);
  }, 15000);

  it("rejects a non-existent sourceCheckpointId with INVALID_INPUT", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const result = await mcpProposeKnowledge({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-propose-00000003",
      proposal: PROPOSAL,
      sourceCheckpointId: "chk_0000000000000000000000000A",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  }, 15000);

  it("redacts a secret embedded in a guard denyCommand", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const guardrailProposal: KnowledgeProposal = {
      type: "rule",
      title: "Block a dangerous command",
      summary: "a guardrail rule",
      body: "This guardrail denies a command.",
      labels: [],
      scope: { paths: [], symbols: [] },
      sources: [{ type: "commit", ref: "abc1234" }],
      enforcement: "guardrail",
      guard: { tools: ["bash"], paths: [], denyCommands: [SECRET_BLOCK] },
    };

    const result = await mcpProposeKnowledge({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: seeded.token,
      idempotencyKey: "idem-propose-00000004",
      proposal: guardrailProposal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.redactions.some((redaction) => redaction.field.includes("denyCommands")),
    ).toBe(true);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const candidates = await listCandidatesByStatus(db.value, repo.repositoryId, "pending");
    const candidate = candidates.ok ? candidates.value[0] : undefined;
    if (candidate) {
      expect(candidate.payloadJson).not.toContain("PRIVATE KEY");
      expect(candidate.payloadJson).toContain("[redacted");
    }
    await closeDatabase(db.value);
  }, 15000);
});
