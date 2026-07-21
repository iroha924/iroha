import type { RepositoryConfig } from "@iroha/config";
import {
  type Clock,
  IrohaError,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import type {
  ForgeProvider,
  ForgeRepositoryRef,
  NormalizedActor,
  NormalizedIssue,
  NormalizedPullRequest,
  NormalizedReviewComment,
} from "@iroha/forge";
import { createGitHubProvider } from "@iroha/forge-github";
import { getSanitizedRemoteUrl } from "@iroha/git";
import {
  type Database,
  type Executor,
  getActorByProviderExternalId,
  getPullRequestByExternalId,
  getReviewCommentByExternalId,
  getSyncCursor,
  getWorkItemByExternalId,
  insertActor,
  insertDirtyMarker,
  insertRelation,
  type SyncCursorRow,
  upsertEntity,
  upsertPullRequest,
  upsertReviewComment,
  upsertSyncCursor,
  upsertWorkItem,
  withTransaction,
} from "@iroha/storage";
import { z } from "zod";

type ForgeConfig = RepositoryConfig["forge"];

/** Only GitHub is implemented in v0.1 (OQ-004); GitLab has a port + fixtures only. */
const FORGE_PROVIDER = "github";
/** design.md §7: verified Git/Forge artifacts rank below approved canonical (100). */
const FORGE_AUTHORITY = 80;
/** Forge-API-derived relations are high-confidence (an explicit `closes` link). */
const RELATION_CONFIDENCE = 1;

/**
 * Build a GitHub provider from config + env, or `null` when forge is disabled,
 * the provider is not GitHub, or the token env var is unset. Mirrors
 * `resolveEmbeddingProvider`: the token value lives only in the provider's auth
 * layer and is never stored in config, the DB, or logs.
 */
export function resolveForgeProvider(
  config: ForgeConfig,
  env: NodeJS.ProcessEnv,
): ForgeProvider | null {
  if (!config.enabled || config.provider !== "github") {
    return null;
  }
  const token = env[config.api_token_env];
  if (token === undefined || token.length === 0) {
    return null;
  }
  return createGitHubProvider({ token });
}

const GITHUB_REMOTE_PATTERNS = [
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
];

export function parseGitHubRef(remoteUrl: string): ForgeRepositoryRef | null {
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = pattern.exec(remoteUrl);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

/**
 * Derive the `owner/repo` from the sanitized `origin` remote, or `null` when the
 * repository has no remote or its remote is not a github.com URL. The remote is
 * already credential-stripped by `getSanitizedRemoteUrl`.
 */
export async function resolveGitHubRef(
  cwd: string,
): Promise<Result<ForgeRepositoryRef | null, IrohaError>> {
  const remote = await getSanitizedRemoteUrl(cwd);
  if (!remote.ok) {
    return remote;
  }
  if (remote.value === null) {
    return ok(null);
  }
  return ok(parseGitHubRef(remote.value));
}

export type ForgeSyncOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | {
      status: "synced";
      issues: number;
      pullRequests: number;
      reviewComments: number;
      relations: number;
      truncated: boolean;
    }
  | { status: "error"; errorCode: string };

const forgeCursorStateSchema = z.object({
  issues: z.string().nullable().optional(),
  pullRequests: z.string().nullable().optional(),
});

interface ForgeWatermarks {
  issues: string | null;
  pullRequests: string | null;
}

function readForgeWatermarks(row: SyncCursorRow | null): ForgeWatermarks {
  if (row === null) {
    return { issues: null, pullRequests: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.stateJson);
  } catch {
    return { issues: null, pullRequests: null };
  }
  const parsed = forgeCursorStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { issues: null, pullRequests: null };
  }
  return { issues: parsed.data.issues ?? null, pullRequests: parsed.data.pullRequests ?? null };
}

async function recordError(
  db: Database,
  repositoryId: TypedId<"repo">,
  attemptAt: string,
  errorCode: string,
): Promise<void> {
  await upsertSyncCursor(db, {
    repositoryId,
    provider: FORGE_PROVIDER,
    lastAttemptAt: attemptAt,
    lastErrorCode: errorCode,
  });
}

async function resolveActorId(
  tx: Executor,
  cache: Map<string, TypedId<"act">>,
  actor: NormalizedActor | null,
  clock: Clock,
  random: RandomSource,
): Promise<Result<TypedId<"act"> | undefined, IrohaError>> {
  if (actor === null) {
    return ok(undefined);
  }
  const cached = cache.get(actor.externalId);
  if (cached !== undefined) {
    return ok(cached);
  }
  const existing = await getActorByProviderExternalId(tx, FORGE_PROVIDER, actor.externalId);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== null) {
    cache.set(actor.externalId, existing.value.id);
    return ok(existing.value.id);
  }
  const id = makeTypedId("act", clock, random);
  const now = clock.now().toISOString();
  const inserted = await insertActor(tx, {
    id,
    provider: FORGE_PROVIDER,
    externalId: actor.externalId,
    displayName: actor.displayName,
    createdAt: now,
    updatedAt: now,
  });
  if (!inserted.ok) {
    return inserted;
  }
  cache.set(actor.externalId, id);
  return ok(id);
}

/**
 * Stable id for a forge item: reuse the existing row's id (so the shared
 * `entities` row is updated, not duplicated, across syncs) or mint a new one on
 * first sight. `upsert*` keeps the row id on conflict, so the freshly-minted id
 * is only used when the row is genuinely new.
 */
async function resolveIssueId(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  externalId: string,
  clock: Clock,
  random: RandomSource,
): Promise<Result<TypedId<"iss">, IrohaError>> {
  const existing = await getWorkItemByExternalId(tx, repositoryId, FORGE_PROVIDER, externalId);
  if (!existing.ok) {
    return existing;
  }
  return ok(existing.value !== null ? existing.value.id : makeTypedId("iss", clock, random));
}

async function resolvePullRequestId(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  externalId: string,
  clock: Clock,
  random: RandomSource,
): Promise<Result<TypedId<"pr">, IrohaError>> {
  const existing = await getPullRequestByExternalId(tx, repositoryId, FORGE_PROVIDER, externalId);
  if (!existing.ok) {
    return existing;
  }
  return ok(existing.value !== null ? existing.value.id : makeTypedId("pr", clock, random));
}

async function resolveReviewCommentId(
  tx: Executor,
  externalId: string,
  clock: Clock,
  random: RandomSource,
): Promise<Result<TypedId<"cmt">, IrohaError>> {
  const existing = await getReviewCommentByExternalId(tx, FORGE_PROVIDER, externalId);
  if (!existing.ok) {
    return existing;
  }
  return ok(existing.value !== null ? existing.value.id : makeTypedId("cmt", clock, random));
}

/** Title for a `review` entity: a concise slice of the comment, never empty. */
function reviewTitle(comment: NormalizedReviewComment): string {
  const trimmed = comment.bodySummary.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : "Review comment";
}

interface PersistCounts {
  reviewComments: number;
  relations: number;
}

async function persistIssue(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  issue: NormalizedIssue,
  actorCache: Map<string, TypedId<"act">>,
  clock: Clock,
  random: RandomSource,
): Promise<Result<void, IrohaError>> {
  const actorId = await resolveActorId(tx, actorCache, issue.author, clock, random);
  if (!actorId.ok) {
    return actorId;
  }
  const idResult = await resolveIssueId(tx, repositoryId, issue.externalId, clock, random);
  if (!idResult.ok) {
    return idResult;
  }
  const id = idResult.value;
  // Entity first: every typed table's `id` REFERENCES `entities(id)`.
  const entity = await upsertEntity(tx, {
    id,
    repositoryId,
    entityType: "issue",
    title: issue.title,
    status: "active",
    authority: FORGE_AUTHORITY,
    sourceKind: FORGE_PROVIDER,
    sourceRef: issue.url,
    createdAt: issue.openedAt ?? issue.updatedAt,
    updatedAt: issue.updatedAt,
  });
  if (!entity.ok) {
    return entity;
  }
  return upsertWorkItem(tx, {
    id,
    repositoryId,
    provider: FORGE_PROVIDER,
    externalId: issue.externalId,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    labelsJson: JSON.stringify(issue.labels),
    ...(actorId.value !== undefined ? { authorActorId: actorId.value } : {}),
    ...(issue.openedAt !== null ? { openedAt: issue.openedAt } : {}),
    ...(issue.closedAt !== null ? { closedAt: issue.closedAt } : {}),
  });
}

async function persistPullRequest(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  pr: NormalizedPullRequest,
  actorCache: Map<string, TypedId<"act">>,
  clock: Clock,
  random: RandomSource,
): Promise<Result<PersistCounts, IrohaError>> {
  const authorId = await resolveActorId(tx, actorCache, pr.author, clock, random);
  if (!authorId.ok) {
    return authorId;
  }
  const idResult = await resolvePullRequestId(tx, repositoryId, pr.externalId, clock, random);
  if (!idResult.ok) {
    return idResult;
  }
  const prId = idResult.value;
  // Entity first (pull_requests.id REFERENCES entities(id)).
  const prEntity = await upsertEntity(tx, {
    id: prId,
    repositoryId,
    entityType: "pull_request",
    title: pr.title,
    status: "active",
    authority: FORGE_AUTHORITY,
    sourceKind: FORGE_PROVIDER,
    sourceRef: pr.url,
    createdAt: pr.openedAt ?? pr.updatedAt,
    updatedAt: pr.updatedAt,
  });
  if (!prEntity.ok) {
    return prEntity;
  }
  const pullRequest = await upsertPullRequest(tx, {
    id: prId,
    repositoryId,
    provider: FORGE_PROVIDER,
    externalId: pr.externalId,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    ...(pr.baseRef !== null ? { baseRef: pr.baseRef } : {}),
    ...(pr.headRef !== null ? { headRef: pr.headRef } : {}),
    ...(authorId.value !== undefined ? { authorActorId: authorId.value } : {}),
    ...(pr.openedAt !== null ? { openedAt: pr.openedAt } : {}),
    ...(pr.mergedAt !== null ? { mergedAt: pr.mergedAt } : {}),
  });
  if (!pullRequest.ok) {
    return pullRequest;
  }

  const now = clock.now().toISOString();
  let reviewComments = 0;
  let relations = 0;
  for (const thread of pr.reviewThreads) {
    for (const comment of thread.comments) {
      const commentActor = await resolveActorId(tx, actorCache, comment.author, clock, random);
      if (!commentActor.ok) {
        return commentActor;
      }
      const cmtIdResult = await resolveReviewCommentId(tx, comment.externalId, clock, random);
      if (!cmtIdResult.ok) {
        return cmtIdResult;
      }
      const cmtId = cmtIdResult.value;
      // A review comment is a `review` entity (review_comments.id REFERENCES entities(id)).
      const reviewEntity = await upsertEntity(tx, {
        id: cmtId,
        repositoryId,
        entityType: "review",
        title: reviewTitle(comment),
        status: "active",
        authority: FORGE_AUTHORITY,
        sourceKind: FORGE_PROVIDER,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
        ...(comment.url !== null ? { sourceRef: comment.url } : {}),
      });
      if (!reviewEntity.ok) {
        return reviewEntity;
      }
      const written = await upsertReviewComment(tx, {
        id: cmtId,
        pullRequestId: prId,
        provider: FORGE_PROVIDER,
        externalId: comment.externalId,
        bodySummary: comment.bodySummary,
        resolutionState: comment.resolutionState,
        createdAt: comment.createdAt,
        ...(comment.url !== null ? { url: comment.url } : {}),
        ...(commentActor.value !== undefined ? { authorActorId: commentActor.value } : {}),
        ...(comment.path !== null ? { path: comment.path } : {}),
        ...(comment.line !== null ? { line: comment.line } : {}),
      });
      if (!written.ok) {
        return written;
      }
      reviewComments += 1;
      // PR REVIEWED_IN review — connects the review node to its PR in the graph.
      const reviewRelation = await insertRelation(tx, {
        id: makeTypedId("rel", clock, random),
        repositoryId,
        fromEntityId: prId,
        relationType: "REVIEWED_IN",
        toEntityId: cmtId,
        sourceKind: "api",
        confidence: RELATION_CONFIDENCE,
        createdAt: now,
        ...(comment.url !== null ? { sourceRef: comment.url } : {}),
      });
      if (!reviewRelation.ok) {
        return reviewRelation;
      }
      relations += 1;
    }
  }

  // PR ADDRESSES Issue — only when the referenced issue's entity already exists
  // (relations FK-reference `entities(id)`; a cross-repo or unsynced issue is skipped).
  for (const issueExternalId of pr.closesIssueExternalIds) {
    const target = await getWorkItemByExternalId(tx, repositoryId, FORGE_PROVIDER, issueExternalId);
    if (!target.ok) {
      return target;
    }
    if (target.value === null) {
      continue;
    }
    const relation = await insertRelation(tx, {
      id: makeTypedId("rel", clock, random),
      repositoryId,
      fromEntityId: prId,
      relationType: "ADDRESSES",
      toEntityId: target.value.id,
      sourceKind: "api",
      sourceRef: pr.url,
      confidence: RELATION_CONFIDENCE,
      createdAt: now,
    });
    if (!relation.ok) {
      return relation;
    }
    relations += 1;
  }

  return ok({ reviewComments, relations });
}

async function persistForgeGraph(
  tx: Executor,
  repositoryId: TypedId<"repo">,
  issues: readonly NormalizedIssue[],
  pullRequests: readonly NormalizedPullRequest[],
  clock: Clock,
  random: RandomSource,
): Promise<Result<PersistCounts, IrohaError>> {
  const actorCache = new Map<string, TypedId<"act">>();
  // Issues first: a PR's `ADDRESSES` edge needs the issue entity to already exist.
  for (const issue of issues) {
    const persisted = await persistIssue(tx, repositoryId, issue, actorCache, clock, random);
    if (!persisted.ok) {
      return persisted;
    }
  }
  let reviewComments = 0;
  let relations = 0;
  for (const pr of pullRequests) {
    const persisted = await persistPullRequest(tx, repositoryId, pr, actorCache, clock, random);
    if (!persisted.ok) {
      return persisted;
    }
    reviewComments += persisted.value.reviewComments;
    relations += persisted.value.relations;
  }
  return ok({ reviewComments, relations });
}

/**
 * Incremental GitHub sync into the Work Graph. Fully non-fatal by design (the
 * "Forge failure must not fail canonical/Git sync" invariant): it never throws
 * and never returns an error — provider outages, rate limits, and even DB write
 * errors are captured in the returned `ForgeSyncOutcome` and recorded on the
 * `github` sync cursor, so the caller keeps its canonical sync result. Per-
 * resource watermarks live in the cursor's `state_json`; a provider failure
 * records the attempt/error without advancing them (COALESCE upsert).
 */
export async function runForgeSync(
  db: Database,
  repositoryId: TypedId<"repo">,
  ref: ForgeRepositoryRef,
  provider: ForgeProvider,
  clock: Clock,
  random: RandomSource,
): Promise<ForgeSyncOutcome> {
  const attemptAt = clock.now().toISOString();
  try {
    await upsertSyncCursor(db, {
      repositoryId,
      provider: FORGE_PROVIDER,
      lastAttemptAt: attemptAt,
    });

    const cursorResult = await getSyncCursor(db, repositoryId, FORGE_PROVIDER);
    if (!cursorResult.ok) {
      return { status: "error", errorCode: cursorResult.error.code };
    }
    const watermarks = readForgeWatermarks(cursorResult.value);

    const issuesResult = await provider.listIssues(ref, watermarks.issues);
    if (!issuesResult.ok) {
      await recordError(db, repositoryId, attemptAt, issuesResult.error.code);
      return { status: "error", errorCode: issuesResult.error.code };
    }
    const pullRequestsResult = await provider.listPullRequests(ref, watermarks.pullRequests);
    if (!pullRequestsResult.ok) {
      await recordError(db, repositoryId, attemptAt, pullRequestsResult.error.code);
      return { status: "error", errorCode: pullRequestsResult.error.code };
    }

    const issues = issuesResult.value.issues;
    const pullRequests = pullRequestsResult.value.pullRequests;

    const written = await withTransaction(db, "write", (tx) =>
      persistForgeGraph(tx, repositoryId, issues, pullRequests, clock, random),
    );
    if (!written.ok) {
      await recordError(db, repositoryId, attemptAt, written.error.code);
      return { status: "error", errorCode: written.error.code };
    }

    const truncated = issuesResult.value.truncated || pullRequestsResult.value.truncated;
    // Advance watermarks; null (nothing new) keeps the prior value so a no-op
    // sync never regresses the cursor. On truncation, do NOT advance that
    // resource's watermark either: the descending watermark cannot resume the
    // unfetched older tail, so advancing it would drop that tail permanently.
    // Keeping the prior watermark leaves the gap recoverable (raise maxPages and
    // re-run) and the dirty marker below surfaces the incompleteness.
    const stateJson = JSON.stringify({
      issues: issuesResult.value.truncated
        ? watermarks.issues
        : (issuesResult.value.watermark ?? watermarks.issues),
      pullRequests: pullRequestsResult.value.truncated
        ? watermarks.pullRequests
        : (pullRequestsResult.value.watermark ?? watermarks.pullRequests),
    });
    const cursorWrite = await upsertSyncCursor(db, {
      repositoryId,
      provider: FORGE_PROVIDER,
      stateJson,
      lastSuccessAt: attemptAt,
    });
    if (!cursorWrite.ok) {
      return { status: "error", errorCode: cursorWrite.error.code };
    }
    if (truncated) {
      // Best-effort: record that an older tail was left unfetched.
      await insertDirtyMarker(db, {
        id: makeTypedId("dirty", clock, random),
        repositoryId,
        markerType: "sync_required",
        detailsJson: JSON.stringify({
          reason: "forge_incremental_truncated",
          issues: issuesResult.value.truncated,
          pullRequests: pullRequestsResult.value.truncated,
        }),
        createdAt: attemptAt,
      });
    }

    return {
      status: "synced",
      issues: issues.length,
      pullRequests: pullRequests.length,
      reviewComments: written.value.reviewComments,
      relations: written.value.relations,
      truncated,
    };
  } catch (error) {
    const errorCode = error instanceof IrohaError ? error.code : "INTERNAL_ERROR";
    return { status: "error", errorCode };
  }
}
