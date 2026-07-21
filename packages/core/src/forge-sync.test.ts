import {
  CryptoRandomSource,
  err,
  FixedClock,
  IrohaError,
  makeTypedId,
  ok,
  type Result,
} from "@iroha/domain";
import type {
  ForgeIssuesResult,
  ForgeProvider,
  ForgePullRequestsResult,
  NormalizedIssue,
  NormalizedPullRequest,
} from "@iroha/forge";
import {
  type CandidateRow,
  closeDatabase,
  type Database,
  getActorByProviderExternalId,
  getEntityById,
  getNeighbors,
  getPullRequestByExternalId,
  getSyncCursor,
  getWorkItemByExternalId,
  insertRepository,
  listCandidatesByStatus,
  listReviewCommentsByPullRequest,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ForgeSyncOutcome,
  parseGitHubRef,
  resolveForgeProvider,
  runForgeSync,
} from "./forge-sync.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const RANDOM = new CryptoRandomSource();
const REPOSITORY_ID = makeTypedId("repo", CLOCK, RANDOM);
const REF = { owner: "octo", repo: "demo" };

function issue(over: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    externalId: "I_1",
    number: 1,
    title: "Login fails",
    url: "https://github.com/octo/demo/issues/1",
    state: "open",
    author: { externalId: "U_alice", login: "alice", displayName: "alice" },
    labels: ["bug"],
    openedAt: "2026-03-01T00:00:00Z",
    closedAt: null,
    updatedAt: "2026-03-02T00:00:00Z",
    ...over,
  };
}

function pullRequest(over: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    externalId: "PR_1",
    number: 10,
    title: "Fix login",
    url: "https://github.com/octo/demo/pull/10",
    state: "open",
    baseRef: "main",
    headRef: "fix-login",
    author: { externalId: "U_alice", login: "alice", displayName: "alice" },
    openedAt: "2026-03-03T00:00:00Z",
    mergedAt: null,
    updatedAt: "2026-03-05T00:00:00Z",
    closesIssueExternalIds: ["I_1"],
    reviewThreads: [
      {
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            externalId: "C_1",
            url: "https://github.com/octo/demo/pull/10#r1",
            author: { externalId: "U_bob", login: "bob", displayName: "bob" },
            path: "src/login.ts",
            line: 12,
            bodySummary: "extract a helper here",
            resolutionState: "open",
            createdAt: "2026-03-04T00:00:00Z",
          },
        ],
      },
    ],
    ...over,
  };
}

/** A PR carrying a single review comment with a chosen body — for recurrence tests. */
function prWithComment(
  prExternalId: string,
  prNumber: number,
  commentExternalId: string,
  bodySummary: string,
): NormalizedPullRequest {
  return pullRequest({
    externalId: prExternalId,
    number: prNumber,
    url: `https://github.com/octo/demo/pull/${prNumber}`,
    closesIssueExternalIds: [],
    reviewThreads: [
      {
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            externalId: commentExternalId,
            url: `https://github.com/octo/demo/pull/${prNumber}#${commentExternalId}`,
            author: { externalId: "U_bob", login: "bob", displayName: "bob" },
            path: "src/login.ts",
            line: 12,
            bodySummary,
            resolutionState: "open",
            createdAt: "2026-03-04T00:00:00Z",
          },
        ],
      },
    ],
  });
}

interface FakeConfig {
  issues?: NormalizedIssue[];
  pullRequests?: NormalizedPullRequest[];
  issuesWatermark?: string | null;
  pullRequestsWatermark?: string | null;
  issuesError?: boolean;
  truncated?: boolean;
}

interface FakeProvider extends ForgeProvider {
  issuesSince: (string | null)[];
  pullRequestsSince: (string | null)[];
}

function fakeProvider(config: FakeConfig = {}): FakeProvider {
  const issuesSince: (string | null)[] = [];
  const pullRequestsSince: (string | null)[] = [];
  return {
    kind: "github",
    issuesSince,
    pullRequestsSince,
    listIssues(_ref, since): Promise<Result<ForgeIssuesResult, IrohaError>> {
      issuesSince.push(since);
      if (config.issuesError === true) {
        return Promise.resolve(
          err(new IrohaError("FORGE_UNAVAILABLE", "boom", { retryable: true })),
        );
      }
      return Promise.resolve(
        ok({
          issues: config.issues ?? [],
          watermark: config.issuesWatermark ?? null,
          truncated: config.truncated ?? false,
        }),
      );
    },
    listPullRequests(_ref, since): Promise<Result<ForgePullRequestsResult, IrohaError>> {
      pullRequestsSince.push(since);
      return Promise.resolve(
        ok({
          pullRequests: config.pullRequests ?? [],
          watermark: config.pullRequestsWatermark ?? null,
          truncated: config.truncated ?? false,
        }),
      );
    },
  };
}

describe("parseGitHubRef", () => {
  it("parses https, ssh, and scp github.com remotes", () => {
    expect(parseGitHubRef("https://github.com/octo/demo")).toEqual({ owner: "octo", repo: "demo" });
    expect(parseGitHubRef("https://github.com/octo/demo.git")).toEqual({
      owner: "octo",
      repo: "demo",
    });
    expect(parseGitHubRef("ssh://git@github.com/octo/demo.git")).toEqual({
      owner: "octo",
      repo: "demo",
    });
    expect(parseGitHubRef("git@github.com:octo/demo.git")).toEqual({ owner: "octo", repo: "demo" });
  });

  it("returns null for non-github or local remotes", () => {
    expect(parseGitHubRef("https://gitlab.com/octo/demo.git")).toBeNull();
    expect(parseGitHubRef("https://github.example.com/octo/demo.git")).toBeNull();
    expect(parseGitHubRef("/Users/alice/repos/demo")).toBeNull();
  });
});

describe("resolveForgeProvider", () => {
  const config = {
    provider: "github" as const,
    enabled: true,
    api_token_env: "GITHUB_TOKEN",
    review_learning_threshold: 3,
  };

  it("builds a provider when enabled and the token env var is set", () => {
    expect(resolveForgeProvider(config, { GITHUB_TOKEN: "t" })).not.toBeNull();
  });

  it("returns null when disabled, tokenless, or non-github", () => {
    expect(resolveForgeProvider({ ...config, enabled: false }, { GITHUB_TOKEN: "t" })).toBeNull();
    expect(resolveForgeProvider(config, {})).toBeNull();
    expect(resolveForgeProvider(config, { GITHUB_TOKEN: "" })).toBeNull();
    expect(
      resolveForgeProvider({ ...config, provider: "gitlab" }, { GITHUB_TOKEN: "t" }),
    ).toBeNull();
  });
});

describe("runForgeSync", () => {
  let db: Database | undefined;
  let tempDir: string | undefined;

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

  async function setup(): Promise<Database> {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const inserted = await insertRepository(db, {
      id: REPOSITORY_ID,
      rootFingerprint: "fp-forge",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!inserted.ok) {
      throw new Error(`failed to seed repository: ${inserted.error.message}`);
    }
    return db;
  }

  // Default the recurrence threshold high so the review-comment-agnostic tests
  // below never trip review-learning detection; the dedicated tests pass 3.
  async function run(
    provider: ForgeProvider,
    reviewLearningThreshold = 100,
  ): Promise<ForgeSyncOutcome> {
    if (db === undefined) {
      throw new Error("db not set up");
    }
    return runForgeSync(db, REPOSITORY_ID, REF, provider, CLOCK, RANDOM, reviewLearningThreshold);
  }

  it("persists issues, PRs, review comments, entities, deduped actors, and the ADDRESSES relation", async () => {
    const database = await setup();
    const provider = fakeProvider({
      issues: [issue()],
      pullRequests: [pullRequest()],
      issuesWatermark: "2026-03-02T00:00:00Z",
      pullRequestsWatermark: "2026-03-05T00:00:00Z",
    });

    const outcome = await run(provider);

    // 2 relations: PR REVIEWED_IN its review comment, and PR ADDRESSES the issue.
    expect(outcome).toMatchObject({
      status: "synced",
      issues: 1,
      pullRequests: 1,
      reviewComments: 1,
      relations: 2,
      truncated: false,
    });

    const workItem = await getWorkItemByExternalId(database, REPOSITORY_ID, "github", "I_1");
    expect(workItem.ok && workItem.value?.state).toBe("open");
    const pr = await getPullRequestByExternalId(database, REPOSITORY_ID, "github", "PR_1");
    if (!pr.ok || pr.value === null) {
      throw new Error("PR not persisted");
    }
    expect(pr.value.number).toBe(10);

    // The PR/issue entities exist with forge authority and source.
    const prEntity = await getEntityById(database, pr.value.id);
    expect(prEntity.ok && prEntity.value?.entityType).toBe("pull_request");
    expect(prEntity.ok && prEntity.value?.authority).toBe(80);
    expect(prEntity.ok && prEntity.value?.sourceKind).toBe("github");

    // Review comment stored under the PR, and its `review` entity exists.
    const comments = await listReviewCommentsByPullRequest(database, pr.value.id);
    if (!comments.ok || comments.value[0] === undefined) {
      throw new Error("review comment not persisted");
    }
    expect(comments.value).toHaveLength(1);
    expect(comments.value[0].bodySummary).toBe("extract a helper here");
    const reviewEntity = await getEntityById(database, comments.value[0].id);
    expect(reviewEntity.ok && reviewEntity.value?.entityType).toBe("review");

    // Author actor deduped (alice authored both the issue and the PR → one row).
    const alice = await getActorByProviderExternalId(database, "github", "U_alice");
    expect(alice.ok && alice.value).not.toBeNull();
    expect(workItem.ok && workItem.value?.authorActorId).toBe(alice.ok ? alice.value?.id : "x");

    // Outgoing edges: PR REVIEWED_IN its review comment, and PR ADDRESSES the issue.
    if (!workItem.ok || workItem.value === null) {
      throw new Error("issue not persisted");
    }
    const neighbors = await getNeighbors(database, pr.value.id, { direction: "outgoing" });
    if (!neighbors.ok) {
      throw new Error("neighbors read failed");
    }
    expect(neighbors.value.map((relation) => relation.relationType).sort()).toEqual([
      "ADDRESSES",
      "REVIEWED_IN",
    ]);
    const addresses = neighbors.value.find((relation) => relation.relationType === "ADDRESSES");
    expect(addresses?.toEntityId).toBe(workItem.value.id);

    // Watermarks persisted on the github cursor.
    const cursor = await getSyncCursor(database, REPOSITORY_ID, "github");
    if (!cursor.ok || cursor.value === null) {
      throw new Error("cursor not written");
    }
    expect(cursor.value.lastSuccessAt).not.toBeNull();
    expect(JSON.parse(cursor.value.stateJson)).toEqual({
      issues: "2026-03-02T00:00:00Z",
      pullRequests: "2026-03-05T00:00:00Z",
    });
  });

  it("is idempotent: a second sync reuses entity ids and creates no duplicates", async () => {
    const database = await setup();
    await run(fakeProvider({ issues: [issue()], pullRequests: [pullRequest()] }));
    const firstPr = await getPullRequestByExternalId(database, REPOSITORY_ID, "github", "PR_1");
    const firstId = firstPr.ok ? firstPr.value?.id : undefined;

    const outcome = await run(fakeProvider({ issues: [issue()], pullRequests: [pullRequest()] }));

    expect(outcome.status).toBe("synced");
    const secondPr = await getPullRequestByExternalId(database, REPOSITORY_ID, "github", "PR_1");
    expect(secondPr.ok && secondPr.value?.id).toBe(firstId);
    // Still exactly one PR and the same two relations (REVIEWED_IN + ADDRESSES), not duplicated.
    const count = await database.execute({
      sql: "SELECT (SELECT COUNT(*) FROM pull_requests) AS prs, (SELECT COUNT(*) FROM relations) AS rels",
    });
    expect(count.rows[0]).toMatchObject({ prs: 1, rels: 2 });
  });

  it("skips the ADDRESSES relation when the referenced issue was not synced", async () => {
    const database = await setup();
    // PR closes I_1 but no issues are synced → no issue entity to link to.
    const outcome = await run(fakeProvider({ pullRequests: [pullRequest()] }));

    expect(outcome.status).toBe("synced");
    const addressRels = await database.execute({
      sql: "SELECT COUNT(*) AS n FROM relations WHERE relation_type = 'ADDRESSES'",
    });
    expect(addressRels.rows[0]?.n).toBe(0);
  });

  it("passes the stored watermark as `since` on the next sync", async () => {
    await setup();
    await run(
      fakeProvider({
        issues: [issue()],
        issuesWatermark: "2026-03-02T00:00:00Z",
        pullRequestsWatermark: "2026-03-05T00:00:00Z",
      }),
    );
    const second = fakeProvider({});
    await run(second);

    expect(second.issuesSince).toEqual(["2026-03-02T00:00:00Z"]);
    expect(second.pullRequestsSince).toEqual(["2026-03-05T00:00:00Z"]);
  });

  it("does not advance a truncated resource's watermark and records a dirty marker", async () => {
    const database = await setup();
    const outcome = await run(
      fakeProvider({ issues: [issue()], issuesWatermark: "2026-03-02T00:00:00Z", truncated: true }),
    );

    expect(outcome).toMatchObject({ status: "synced", truncated: true });
    const cursor = await getSyncCursor(database, REPOSITORY_ID, "github");
    if (!cursor.ok || cursor.value === null) {
      throw new Error("cursor not written");
    }
    // Truncated → the issues watermark is NOT advanced (stays at the prior null),
    // so the unfetched older tail remains recoverable on a re-run.
    expect(JSON.parse(cursor.value.stateJson).issues).toBeNull();
    const markers = await database.execute({
      sql: "SELECT COUNT(*) AS n FROM dirty_markers WHERE marker_type = 'sync_required'",
    });
    expect(markers.rows[0]?.n).toBe(1);
  });

  it("is non-fatal on a provider failure: records the error, writes nothing, never throws", async () => {
    const database = await setup();
    const outcome = await run(fakeProvider({ issuesError: true }));

    expect(outcome).toEqual({ status: "error", errorCode: "FORGE_UNAVAILABLE" });
    const cursor = await getSyncCursor(database, REPOSITORY_ID, "github");
    expect(cursor.ok && cursor.value?.lastErrorCode).toBe("FORGE_UNAVAILABLE");
    expect(cursor.ok && cursor.value?.lastSuccessAt).toBeNull();
    const entities = await database.execute({ sql: "SELECT COUNT(*) AS n FROM entities" });
    expect(entities.rows[0]?.n).toBe(0);
  });

  describe("review learnings", () => {
    const BODY = "please add a unit test covering this branch";

    async function pendingReviewLearnings(database: Database): Promise<CandidateRow[]> {
      const pending = await listCandidatesByStatus(database, REPOSITORY_ID, "pending");
      if (!pending.ok) {
        throw new Error(`failed to list candidates: ${pending.error.message}`);
      }
      return pending.value.filter((candidate) => candidate.candidateType === "review_learning");
    }

    it("proposes one candidate when a comment recurs across >= threshold distinct PRs", async () => {
      const database = await setup();
      const outcome = await run(
        fakeProvider({
          pullRequests: [
            prWithComment("PR_1", 10, "C_1", BODY),
            prWithComment("PR_2", 20, "C_2", BODY),
            prWithComment("PR_3", 30, "C_3", BODY),
          ],
        }),
        3,
      );
      expect(outcome).toMatchObject({ status: "synced", reviewLearnings: 1 });

      const learnings = await pendingReviewLearnings(database);
      expect(learnings).toHaveLength(1);
      const learning = learnings[0];
      if (learning === undefined) {
        throw new Error("no review_learning candidate");
      }
      const payload = JSON.parse(learning.payloadJson) as {
        type: string;
        sources: { type: string; ref: string; url?: string }[];
        labels: string[];
      };
      expect(payload.type).toBe("review_learning");
      // Provenance: every synced occurrence links back by stable external id + URL.
      expect(payload.sources).toHaveLength(3);
      expect(payload.sources.every((source) => source.type === "review")).toBe(true);
      expect(payload.sources.map((source) => source.ref).sort()).toEqual(["C_1", "C_2", "C_3"]);
      expect(payload.labels.some((label) => label.startsWith("forge-recurrence-"))).toBe(true);
    });

    it("does not re-propose the same learning on a later sync (fingerprint dedup)", async () => {
      const database = await setup();
      const prs = [
        prWithComment("PR_1", 10, "C_1", BODY),
        prWithComment("PR_2", 20, "C_2", BODY),
        prWithComment("PR_3", 30, "C_3", BODY),
      ];
      const first = await run(fakeProvider({ pullRequests: prs }), 3);
      expect(first).toMatchObject({ reviewLearnings: 1 });
      const second = await run(fakeProvider({ pullRequests: prs }), 3);
      expect(second).toMatchObject({ reviewLearnings: 0 });
      expect(await pendingReviewLearnings(database)).toHaveLength(1);
    });

    it("ignores a comment that recurs in fewer than threshold distinct PRs", async () => {
      const database = await setup();
      const outcome = await run(
        fakeProvider({
          pullRequests: [
            prWithComment("PR_1", 10, "C_1", BODY),
            prWithComment("PR_2", 20, "C_2", BODY),
          ],
        }),
        3,
      );
      expect(outcome).toMatchObject({ reviewLearnings: 0 });
      expect(await pendingReviewLearnings(database)).toHaveLength(0);
    });

    it("skips comments that normalize to nothing (e.g. URL-only) even when they recur", async () => {
      const database = await setup();
      const outcome = await run(
        fakeProvider({
          pullRequests: [
            prWithComment("PR_1", 10, "C_1", "https://ci.example.com/run/1"),
            prWithComment("PR_2", 20, "C_2", "https://ci.example.com/run/2"),
            prWithComment("PR_3", 30, "C_3", "https://ci.example.com/run/3"),
          ],
        }),
        3,
      );
      expect(outcome).toMatchObject({ reviewLearnings: 0 });
      expect(await pendingReviewLearnings(database)).toHaveLength(0);
    });

    it("proposes short non-Latin (Japanese) recurring feedback (no length-based floor)", async () => {
      const database = await setup();
      // 12 UTF-16 units — an ASCII-calibrated length floor would have dropped it.
      const body = "テストを追加してください";
      const outcome = await run(
        fakeProvider({
          pullRequests: [
            prWithComment("PR_1", 10, "C_1", body),
            prWithComment("PR_2", 20, "C_2", body),
            prWithComment("PR_3", 30, "C_3", body),
          ],
        }),
        3,
      );
      expect(outcome).toMatchObject({ reviewLearnings: 1 });
      expect(await pendingReviewLearnings(database)).toHaveLength(1);
    });
  });
});
