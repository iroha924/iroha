import type {
  ForgeIssuesResult,
  ForgeProvider,
  ForgePullRequestsResult,
  ForgeRepositoryRef,
  IrohaError,
  Result,
} from "@iroha/forge";
import { err, forgeUnavailable, ok } from "@iroha/forge";
import type { ForgeOctokit } from "./client.js";
import { createOctokit } from "./client.js";
import {
  IssuesDocument,
  type IssuesQuery,
  PullRequestsDocument,
  type PullRequestsQuery,
} from "./generated/graphql.js";
import {
  type IssueNode,
  issuesResponseSchema,
  mapIssue,
  mapPullRequest,
  type PullRequestNode,
  pullRequestsResponseSchema,
} from "./normalize.js";

/**
 * Safety bound on pages fetched per resource per sync. High enough that a normal
 * repository's first backfill and every incremental delta drain fully; when it
 * is hit the result is flagged `truncated` (the oldest tail was not fetched).
 */
const DEFAULT_MAX_PAGES = 200;

export interface CreateGitHubProviderOptions {
  /** GitHub token; held only inside Octokit's auth layer. */
  token: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  maxPages?: number;
  /** Retry + throttling resilience; defaults to `true`. Tests set `false`. */
  resilience?: boolean;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

/** Read only the discrete GraphQL error-type enums (never a message/body). */
function readGraphqlErrorTypes(error: unknown): readonly string[] | undefined {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return undefined;
  }
  const errors = (error as { errors: unknown }).errors;
  if (!Array.isArray(errors)) {
    return undefined;
  }
  const types: string[] = [];
  for (const entry of errors) {
    if (typeof entry === "object" && entry !== null && "type" in entry) {
      const type = (entry as { type: unknown }).type;
      if (typeof type === "string") {
        types.push(type);
      }
    }
  }
  return types;
}

/**
 * Map any thrown transport/octokit error to `FORGE_UNAVAILABLE`. Only the numeric
 * HTTP status and the discrete GraphQL error-type enums are read — the raw error
 * (which can carry request URL/headers/body) is never serialized into the
 * message, `details`, or `cause`, so the token cannot leak. 403/429/5xx are
 * transient; a GraphQL `NOT_FOUND`/`FORBIDDEN` (missing repo or a token lacking
 * scope) is permanent; a lone GraphQL `RATE_LIMITED` is transient.
 */
function mapForgeError(error: unknown): IrohaError {
  const status = readStatus(error);
  if (status !== undefined) {
    const retryable = status === 403 || status === 429 || status >= 500;
    return forgeUnavailable(`GitHub request failed (HTTP ${status})`, { retryable });
  }
  const graphqlErrorTypes = readGraphqlErrorTypes(error);
  if (graphqlErrorTypes !== undefined) {
    // Permanent unless every reported error is a transient rate limit.
    const transient =
      graphqlErrorTypes.length > 0 && graphqlErrorTypes.every((type) => type === "RATE_LIMITED");
    return forgeUnavailable("GitHub GraphQL request failed", { retryable: transient });
  }
  // Statusless, non-GraphQL throw (network failure, etc.) → transient.
  return forgeUnavailable("GitHub request failed", { retryable: true });
}

interface PageView<TNode> {
  nodes: readonly (TNode | null)[];
  hasNextPage: boolean;
}

/**
 * Drive a GraphQL cursor iterator newest-first, collecting nodes updated at or
 * after `since` and stopping at the first strictly-older node. Timestamps are
 * compared as epoch millis (`Date.parse`), so the ordering is correct even if
 * the provider returns fractional seconds. The early-stop is strict (`<`), so an
 * item sharing the watermark's exact second is re-fetched next sync rather than
 * skipped forever (idempotent upsert dedupes it). `watermark` advances only for
 * accepted items, so a no-op sync keeps the caller's prior cursor.
 */
async function collectIncremental<TNode>(
  pages: AsyncIterable<unknown>,
  parseChunk: (chunk: unknown) => Result<PageView<TNode>, IrohaError>,
  getUpdatedAt: (node: TNode) => string,
  since: string | null,
  maxPages: number,
): Promise<Result<{ nodes: TNode[]; watermark: string | null; truncated: boolean }, IrohaError>> {
  const collected: TNode[] = [];
  let watermark: string | null = null;
  let watermarkEpoch = Number.NEGATIVE_INFINITY;
  let truncated = false;
  let pageCount = 0;
  const sinceEpoch = since === null ? null : Date.parse(since);
  try {
    for await (const chunk of pages) {
      const parsed = parseChunk(chunk);
      if (!parsed.ok) {
        return parsed;
      }
      let reachedWatermark = false;
      for (const node of parsed.value.nodes) {
        if (node === null) {
          continue;
        }
        const epoch = Date.parse(getUpdatedAt(node));
        if (sinceEpoch !== null && epoch < sinceEpoch) {
          reachedWatermark = true;
          break;
        }
        if (epoch > watermarkEpoch) {
          watermark = getUpdatedAt(node);
          watermarkEpoch = epoch;
        }
        collected.push(node);
      }
      if (reachedWatermark) {
        break;
      }
      pageCount += 1;
      if (pageCount >= maxPages) {
        truncated = parsed.value.hasNextPage;
        break;
      }
    }
  } catch (error) {
    return err(mapForgeError(error));
  }
  return ok({ nodes: collected, watermark, truncated });
}

function parseIssuesChunk(chunk: unknown): Result<PageView<IssueNode>, IrohaError> {
  const parsed = issuesResponseSchema.safeParse(chunk);
  if (!parsed.success) {
    return err(
      forgeUnavailable("GitHub issues response had an unexpected shape", { retryable: false }),
    );
  }
  const repository = parsed.data.repository;
  if (repository === null) {
    return err(
      forgeUnavailable("GitHub repository not found or inaccessible", { retryable: false }),
    );
  }
  return ok({
    nodes: repository.issues.nodes ?? [],
    hasNextPage: repository.issues.pageInfo.hasNextPage,
  });
}

function parsePullRequestsChunk(chunk: unknown): Result<PageView<PullRequestNode>, IrohaError> {
  const parsed = pullRequestsResponseSchema.safeParse(chunk);
  if (!parsed.success) {
    return err(
      forgeUnavailable("GitHub pull requests response had an unexpected shape", {
        retryable: false,
      }),
    );
  }
  const repository = parsed.data.repository;
  if (repository === null) {
    return err(
      forgeUnavailable("GitHub repository not found or inaccessible", { retryable: false }),
    );
  }
  return ok({
    nodes: repository.pullRequests.nodes ?? [],
    hasNextPage: repository.pullRequests.pageInfo.hasNextPage,
  });
}

export function createGitHubProvider(options: CreateGitHubProviderOptions): ForgeProvider {
  const octokit: ForgeOctokit = createOctokit(options);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  return {
    kind: "github",

    async listIssues(
      ref: ForgeRepositoryRef,
      since: string | null,
    ): Promise<Result<ForgeIssuesResult, IrohaError>> {
      const result = await collectIncremental<IssueNode>(
        octokit.graphql.paginate.iterator<IssuesQuery>(IssuesDocument.toString(), {
          owner: ref.owner,
          repo: ref.repo,
        }),
        parseIssuesChunk,
        (node) => node.updatedAt,
        since,
        maxPages,
      );
      if (!result.ok) {
        return result;
      }
      return ok({
        issues: result.value.nodes.map(mapIssue),
        watermark: result.value.watermark,
        truncated: result.value.truncated,
      });
    },

    async listPullRequests(
      ref: ForgeRepositoryRef,
      since: string | null,
    ): Promise<Result<ForgePullRequestsResult, IrohaError>> {
      const result = await collectIncremental<PullRequestNode>(
        octokit.graphql.paginate.iterator<PullRequestsQuery>(PullRequestsDocument.toString(), {
          owner: ref.owner,
          repo: ref.repo,
        }),
        parsePullRequestsChunk,
        (node) => node.updatedAt,
        since,
        maxPages,
      );
      if (!result.ok) {
        return result;
      }
      return ok({
        pullRequests: result.value.nodes.map(mapPullRequest),
        watermark: result.value.watermark,
        truncated: result.value.truncated,
      });
    },
  };
}
