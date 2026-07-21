/**
 * Normalized, provider-agnostic forge domain types. The GitHub adapter
 * (`@iroha/forge-github`) maps raw provider responses onto these; `@iroha/core`
 * projects them into the Work Graph (`work_items`, `pull_requests`,
 * `review_comments`, `actors`, `entities`, `relations`). No provider SDK type
 * leaks past this boundary.
 */

export type ForgeProviderKind = "github" | "gitlab";

/** A repository coordinate parsed from the sanitized `origin` remote. */
export interface ForgeRepositoryRef {
  owner: string;
  repo: string;
}

/**
 * A forge actor (issue/PR/comment author). Provenance only — no email is
 * fetched (GitHub's GraphQL `Actor` does not expose it), so `emailHash` is
 * intentionally absent and `actors.email_hash` stays null on this path.
 */
export interface NormalizedActor {
  /** Provider-stable identifier (GraphQL node id). */
  externalId: string;
  login: string;
  displayName: string;
}

export type IssueState = "open" | "closed" | "unknown";

export interface NormalizedIssue {
  /** Provider-stable identifier (GraphQL node id); the `work_items.external_id`. */
  externalId: string;
  number: number;
  title: string;
  url: string;
  state: IssueState;
  author: NormalizedActor | null;
  labels: readonly string[];
  openedAt: string | null;
  closedAt: string | null;
  /** ISO 8601 (UTC `Z`). Drives the incremental sync watermark. */
  updatedAt: string;
}

export type PullRequestState = "open" | "closed" | "merged" | "draft" | "unknown";

export type ReviewResolutionState = "open" | "resolved" | "outdated" | "unknown";

export interface NormalizedReviewComment {
  /** Provider-stable identifier (GraphQL node id); the `review_comments.external_id`. */
  externalId: string;
  url: string | null;
  author: NormalizedActor | null;
  path: string | null;
  line: number | null;
  bodySummary: string;
  /** Derived from the enclosing thread's resolved/outdated flags. */
  resolutionState: ReviewResolutionState;
  createdAt: string;
}

export interface NormalizedReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: readonly NormalizedReviewComment[];
}

export interface NormalizedPullRequest {
  /** Provider-stable identifier (GraphQL node id); the `pull_requests.external_id`. */
  externalId: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  baseRef: string | null;
  headRef: string | null;
  author: NormalizedActor | null;
  openedAt: string | null;
  mergedAt: string | null;
  /** ISO 8601 (UTC `Z`). Drives the incremental sync watermark. */
  updatedAt: string;
  /** GraphQL node ids of issues this PR closes (`closingIssuesReferences`) → `ADDRESSES` edges. */
  closesIssueExternalIds: readonly string[];
  reviewThreads: readonly NormalizedReviewThread[];
}
