import type { IrohaError, Result } from "@iroha/domain";
import type {
  ForgeProviderKind,
  ForgeRepositoryRef,
  NormalizedIssue,
  NormalizedPullRequest,
} from "./types.js";

/**
 * Result of an incremental issue fetch. `issues` is the set of items updated
 * since the watermark (the adapter follows cursors internally and stops early);
 * `watermark` is the newest `updatedAt` observed this run (ISO 8601, UTC `Z`),
 * which the caller persists and passes back as `since` next time — null when
 * nothing new was fetched, so the caller keeps its prior cursor. `truncated` is
 * true when the adapter hit its page bound before draining the delta: the
 * newest items were returned but an older tail was left unfetched, so the caller
 * should surface an incomplete sync (the descending watermark alone cannot
 * resume the gap).
 */
export interface ForgeIssuesResult {
  issues: readonly NormalizedIssue[];
  watermark: string | null;
  truncated: boolean;
}

export interface ForgePullRequestsResult {
  pullRequests: readonly NormalizedPullRequest[];
  watermark: string | null;
  truncated: boolean;
}

/**
 * A read-only forge provider. Every method returns a `Result` and never throws:
 * any transport, auth, rate-limit, or shape failure degrades to a
 * `FORGE_UNAVAILABLE` error so `@iroha/core` can keep the failure non-fatal
 * (Forge failure must not fail canonical/Git sync). The provider holds the
 * credential internally and never places it in an error's message, `details`,
 * or `cause`.
 */
export interface ForgeProvider {
  readonly kind: ForgeProviderKind;

  /**
   * Issues updated since `since` (null = full backfill), newest-inclusive. The
   * adapter paginates and stops when it reaches the watermark.
   */
  listIssues(
    ref: ForgeRepositoryRef,
    since: string | null,
  ): Promise<Result<ForgeIssuesResult, IrohaError>>;

  /**
   * Pull requests updated since `since`, each with nested review threads and
   * comments and the issues it closes.
   */
  listPullRequests(
    ref: ForgeRepositoryRef,
    since: string | null,
  ): Promise<Result<ForgePullRequestsResult, IrohaError>>;
}
