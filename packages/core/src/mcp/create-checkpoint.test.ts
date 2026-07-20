import type { CheckpointInput } from "@iroha/domain";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import {
  closeDatabase,
  getCheckpointById,
  getTurnById,
  listCandidatesByStatus,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpCreateCheckpoint } from "./create-checkpoint.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

// Same known-detected private-key shape the canonical secret-scan test uses.
const PRIVATE_KEY_BODY =
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
const SECRET_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

const SAMPLE_PROPOSAL: CheckpointInput["proposals"][number] = {
  type: "decision",
  title: "Use libSQL",
  summary: "libSQL was chosen as the local index",
  body: "We will use libSQL because it is an embeddable, rebuildable local index.",
  labels: [],
  scope: { paths: [], symbols: [] },
  sources: [{ type: "commit", ref: "abc1234" }],
};

function baseInput(
  token: string,
  key: string,
  overrides: Partial<CheckpointInput> = {},
): CheckpointInput {
  return {
    schemaVersion: 1,
    sessionToken: token,
    idempotencyKey: key,
    outcome: "completed",
    objective: "Implement the MCP checkpoint tool",
    summary: "Wired create_checkpoint end to end",
    implementation: [{ file: "src/foo.ts", change: "added mcpCreateCheckpoint" }],
    validation: [{ command: "pnpm test", result: "passed" }],
    unresolved: [],
    references: [],
    labels: ["wp-07"],
    proposals: [],
    ...overrides,
  };
}

describe("mcpCreateCheckpoint", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("saves the checkpoint, creates candidates, and marks the turn saved", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    expect(seedDb.ok).toBe(true);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const result = await mcpCreateCheckpoint({
      cwd: repo.repoDir,
      clock,
      random,
      input: baseInput(seeded.token, "idem-key-000000000001", { proposals: [SAMPLE_PROPOSAL] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidateIds).toHaveLength(1);
    expect(result.value.redactions).toEqual([]);
    expect(result.value.deduplicated).toBe(false);
    expect(result.value.turnId).toBe(seeded.turnId);

    const db = await openDatabase(repo.dbPath);
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    const checkpoint = await getCheckpointById(db.value, result.value.checkpointId);
    expect(checkpoint.ok && checkpoint.value !== null).toBe(true);
    const turn = await getTurnById(db.value, seeded.turnId);
    if (turn.ok && turn.value) {
      expect(turn.value.checkpointState).toBe("saved");
    }
    const candidates = await listCandidatesByStatus(db.value, repo.repositoryId, "pending");
    expect(candidates.ok && candidates.value.length).toBe(1);
    await closeDatabase(db.value);
  }, 15000);

  it("is idempotent: a retry with the same key returns the original checkpoint", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const key = "idem-key-000000000002";
    const first = await mcpCreateCheckpoint({
      cwd: repo.repoDir,
      clock,
      random,
      input: baseInput(seeded.token, key, { proposals: [SAMPLE_PROPOSAL] }),
    });
    const second = await mcpCreateCheckpoint({
      cwd: repo.repoDir,
      clock,
      random,
      input: baseInput(seeded.token, key, { proposals: [SAMPLE_PROPOSAL] }),
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.checkpointId).toBe(first.value.checkpointId);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const candidates = await listCandidatesByStatus(db.value, repo.repositoryId, "pending");
    expect(candidates.ok && candidates.value.length).toBe(1);
    await closeDatabase(db.value);
  }, 15000);

  it("redacts a secret in a free-text field and reports the redaction", async () => {
    repo = await setupMcpRepo(random);
    const seedDb = await openDatabase(repo.dbPath);
    if (!seedDb.ok) return;
    const seeded = await seedSessionWithToken(seedDb.value, repo, clock, random);
    await closeDatabase(seedDb.value);

    const result = await mcpCreateCheckpoint({
      cwd: repo.repoDir,
      clock,
      random,
      input: baseInput(seeded.token, "idem-key-000000000003", { summary: SECRET_BLOCK }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.redactions.some((redaction) => redaction.field === "summary")).toBe(true);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) return;
    const checkpoint = await getCheckpointById(db.value, result.value.checkpointId);
    if (checkpoint.ok && checkpoint.value) {
      expect(checkpoint.value.summary).toContain("[redacted");
      expect(checkpoint.value.summary).not.toContain("PRIVATE KEY");
    }
    await closeDatabase(db.value);
  }, 15000);
});
