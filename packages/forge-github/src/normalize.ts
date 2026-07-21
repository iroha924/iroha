import type {
  IssueState,
  NormalizedActor,
  NormalizedIssue,
  NormalizedPullRequest,
  NormalizedReviewComment,
  NormalizedReviewThread,
  PullRequestState,
  ReviewResolutionState,
} from "@iroha/forge";
import { z } from "zod";

/**
 * Runtime validation of the GraphQL response boundary (CLAUDE.md: "Validate
 * every external boundary with Zod"). Schemas are lenient (`z.object` strips
 * unknown keys) and treat enum-like fields as free strings so a future GitHub
 * enum value degrades to "unknown" instead of rejecting the whole page. The
 * generated types (`./generated/graphql.js`) give the compile-time contract;
 * these schemas are the runtime guard the mapper consumes.
 */

/** Review comment bodies are stored as a bounded summary, never in full. */
const BODY_SUMMARY_MAX = 500;

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

const actorSchema = z.object({ id: z.string(), login: z.string() }).nullable();

const issueNodeSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  author: actorSchema,
  labels: z
    .object({ nodes: z.array(z.object({ name: z.string() }).nullable()).nullable() })
    .nullable(),
});

const reviewCommentNodeSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  body: z.string(),
  createdAt: z.string(),
  author: actorSchema,
});

const reviewThreadNodeSchema = z.object({
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.object({ nodes: z.array(reviewCommentNodeSchema.nullable()).nullable() }).nullable(),
});

const pullRequestNodeSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  baseRefName: z.string().nullable(),
  headRefName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  author: actorSchema,
  closingIssuesReferences: z
    .object({ nodes: z.array(z.object({ id: z.string() }).nullable()).nullable() })
    .nullable(),
  reviewThreads: z
    .object({ nodes: z.array(reviewThreadNodeSchema.nullable()).nullable() })
    .nullable(),
});

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

export const issuesResponseSchema = z.object({
  repository: z
    .object({
      issues: z.object({
        pageInfo: pageInfoSchema,
        nodes: z.array(issueNodeSchema.nullable()).nullable(),
      }),
    })
    .nullable(),
});

export const pullRequestsResponseSchema = z.object({
  repository: z
    .object({
      pullRequests: z.object({
        pageInfo: pageInfoSchema,
        nodes: z.array(pullRequestNodeSchema.nullable()).nullable(),
      }),
    })
    .nullable(),
});

type IssueNode = z.infer<typeof issueNodeSchema>;
type PullRequestNode = z.infer<typeof pullRequestNodeSchema>;
type ReviewThreadNode = z.infer<typeof reviewThreadNodeSchema>;
type ReviewCommentNode = z.infer<typeof reviewCommentNodeSchema>;

function mapActor(actor: z.infer<typeof actorSchema>): NormalizedActor | null {
  if (actor === null) {
    return null;
  }
  return { externalId: actor.id, login: actor.login, displayName: actor.login };
}

function mapIssueState(state: string): IssueState {
  if (state === "OPEN") {
    return "open";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "unknown";
}

function mapPullRequestState(state: string, isDraft: boolean): PullRequestState {
  if (state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  if (state === "OPEN") {
    return isDraft ? "draft" : "open";
  }
  return "unknown";
}

export function mapIssue(node: IssueNode): NormalizedIssue {
  const labels = (node.labels?.nodes ?? []).filter(isPresent).map((label) => label.name);
  return {
    externalId: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    state: mapIssueState(node.state),
    author: mapActor(node.author),
    labels,
    openedAt: node.createdAt,
    closedAt: node.closedAt,
    updatedAt: node.updatedAt,
  };
}

function mapReviewComment(
  node: ReviewCommentNode,
  resolutionState: ReviewResolutionState,
): NormalizedReviewComment {
  return {
    externalId: node.id,
    url: node.url,
    author: mapActor(node.author),
    path: node.path,
    line: node.line,
    bodySummary: node.body.slice(0, BODY_SUMMARY_MAX),
    resolutionState,
    createdAt: node.createdAt,
  };
}

function mapReviewThread(node: ReviewThreadNode): NormalizedReviewThread {
  const resolutionState: ReviewResolutionState = node.isResolved
    ? "resolved"
    : node.isOutdated
      ? "outdated"
      : "open";
  const comments = (node.comments?.nodes ?? [])
    .filter(isPresent)
    .map((comment) => mapReviewComment(comment, resolutionState));
  return { isResolved: node.isResolved, isOutdated: node.isOutdated, comments };
}

export function mapPullRequest(node: PullRequestNode): NormalizedPullRequest {
  const closesIssueExternalIds = (node.closingIssuesReferences?.nodes ?? [])
    .filter(isPresent)
    .map((issue) => issue.id);
  const reviewThreads = (node.reviewThreads?.nodes ?? []).filter(isPresent).map(mapReviewThread);
  return {
    externalId: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    state: mapPullRequestState(node.state, node.isDraft),
    baseRef: node.baseRefName,
    headRef: node.headRefName,
    author: mapActor(node.author),
    openedAt: node.createdAt,
    mergedAt: node.mergedAt,
    updatedAt: node.updatedAt,
    closesIssueExternalIds,
    reviewThreads,
  };
}
