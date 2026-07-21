import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { decisionDraft, seedCandidate, VALID_DECISION_BODY } from "../test-helpers/candidate.js";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
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
