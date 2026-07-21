import type {
  ForgeIssuesResult,
  ForgeProvider,
  ForgePullRequestsResult,
  ForgeRepositoryRef,
  IrohaError,
  NormalizedIssue,
  NormalizedPullRequest,
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
  issuesResponseSchema,
  mapIssue,
  mapPullRequest,
  pullRequestsResponseSchema,
} from "./normalize.js";

/** Safety bound on the number of pages fetched per resource per sync. */
const DEFAULT_MAX_PAGES = 50;

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

/**
 * Map any thrown transport/octokit error to `FORGE_UNAVAILABLE`. Only the numeric
 * HTTP status is read — the raw error (which can carry request context) is never
 * serialized into the message, `details`, or `cause`, so the token cannot leak.
 * 403/429/5xx are transient (retry next sync); 401/404/4xx are not.
 */
function mapForgeError(error: unknown): IrohaError {
  const status = readStatus(error);
  if (status === undefined) {
    return forgeUnavailable("GitHub request failed", { retryable: true });
  }
  const retryable = status === 403 || status === 429 || status >= 500;
  return forgeUnavailable(`GitHub request failed (HTTP ${status})`, { retryable });
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
      const issues: NormalizedIssue[] = [];
      let watermark: string | null = null;
      let pages = 0;
      try {
        for await (const chunk of octokit.graphql.paginate.iterator<IssuesQuery>(
          IssuesDocument.toString(),
          { owner: ref.owner, repo: ref.repo },
        )) {
          const parsed = issuesResponseSchema.safeParse(chunk);
          if (!parsed.success) {
            return err(
              forgeUnavailable("GitHub issues response had an unexpected shape", {
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
          let reachedWatermark = false;
          for (const node of repository.issues.nodes ?? []) {
            if (node === null) {
              continue;
            }
            if (since !== null && node.updatedAt <= since) {
              reachedWatermark = true;
              break;
            }
            if (watermark === null || node.updatedAt > watermark) {
              watermark = node.updatedAt;
            }
            issues.push(mapIssue(node));
          }
          if (reachedWatermark) {
            break;
          }
          pages += 1;
          if (pages >= maxPages) {
            break;
          }
        }
      } catch (error) {
        return err(mapForgeError(error));
      }
      return ok({ issues, watermark });
    },

    async listPullRequests(
      ref: ForgeRepositoryRef,
      since: string | null,
    ): Promise<Result<ForgePullRequestsResult, IrohaError>> {
      const pullRequests: NormalizedPullRequest[] = [];
      let watermark: string | null = null;
      let pages = 0;
      try {
        for await (const chunk of octokit.graphql.paginate.iterator<PullRequestsQuery>(
          PullRequestsDocument.toString(),
          { owner: ref.owner, repo: ref.repo },
        )) {
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
          let reachedWatermark = false;
          for (const node of repository.pullRequests.nodes ?? []) {
            if (node === null) {
              continue;
            }
            if (since !== null && node.updatedAt <= since) {
              reachedWatermark = true;
              break;
            }
            if (watermark === null || node.updatedAt > watermark) {
              watermark = node.updatedAt;
            }
            pullRequests.push(mapPullRequest(node));
          }
          if (reachedWatermark) {
            break;
          }
          pages += 1;
          if (pages >= maxPages) {
            break;
          }
        }
      } catch (error) {
        return err(mapForgeError(error));
      }
      return ok({ pullRequests, watermark });
    },
  };
}
