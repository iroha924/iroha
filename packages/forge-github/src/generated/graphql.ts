/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
/** The possible states of an issue. */
export type IssueState =
  /** An issue that has been closed */
  | 'CLOSED'
  /** An issue that is still open */
  | 'OPEN';

/** The possible states of a pull request. */
export type PullRequestState =
  /** A pull request that has been closed without being merged. */
  | 'CLOSED'
  /** A pull request that has been closed by being merged. */
  | 'MERGED'
  /** A pull request that is still open. */
  | 'OPEN';

export type IssuesQueryVariables = Exact<{
  owner: string;
  repo: string;
  cursor?: string | null | undefined;
}>;


export type IssuesQuery = { repository: { issues: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, number: number, title: string, url: string, state: IssueState, createdAt: string, updatedAt: string, closedAt: string | null, author:
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
         | null, labels: { nodes: Array<{ name: string } | null> | null } | null } | null> | null } } | null };

export type PullRequestsQueryVariables = Exact<{
  owner: string;
  repo: string;
  cursor?: string | null | undefined;
}>;


export type PullRequestsQuery = { repository: { pullRequests: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, number: number, title: string, url: string, state: PullRequestState, isDraft: boolean, baseRefName: string, headRefName: string, createdAt: string, updatedAt: string, mergedAt: string | null, author:
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
          | { id: string, login: string }
         | null, closingIssuesReferences: { nodes: Array<{ id: string } | null> | null } | null, reviewThreads: { nodes: Array<{ isResolved: boolean, isOutdated: boolean, comments: { nodes: Array<{ id: string, url: string, path: string, line: number | null, body: string, createdAt: string, author:
                  | { id: string, login: string }
                  | { id: string, login: string }
                  | { id: string, login: string }
                  | { id: string, login: string }
                  | { id: string, login: string }
                 | null } | null> | null } } | null> | null } } | null> | null } } | null };

export class TypedDocumentString<TResult, TVariables>
  extends String
  implements DocumentTypeDecoration<TResult, TVariables>
{
  __apiType?: NonNullable<DocumentTypeDecoration<TResult, TVariables>['__apiType']>;
  private value: string;
  public __meta__?: Record<string, any> | undefined;

  constructor(value: string, __meta__?: Record<string, any> | undefined) {
    super(value);
    this.value = value;
    this.__meta__ = __meta__;
  }

  override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
    return this.value;
  }
}

export const IssuesDocument = new TypedDocumentString(`
    query Issues($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        state
        createdAt
        updatedAt
        closedAt
        author {
          login
          ... on Node {
            id
          }
        }
        labels(first: 20) {
          nodes {
            name
          }
        }
      }
    }
  }
}
    `) as unknown as TypedDocumentString<IssuesQuery, IssuesQueryVariables>;
export const PullRequestsDocument = new TypedDocumentString(`
    query PullRequests($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      first: 25
      after: $cursor
      orderBy: {field: UPDATED_AT, direction: DESC}
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        state
        isDraft
        baseRefName
        headRefName
        createdAt
        updatedAt
        mergedAt
        author {
          login
          ... on Node {
            id
          }
        }
        closingIssuesReferences(first: 20) {
          nodes {
            id
          }
        }
        reviewThreads(first: 50) {
          nodes {
            isResolved
            isOutdated
            comments(first: 20) {
              nodes {
                id
                url
                path
                line
                body
                createdAt
                author {
                  login
                  ... on Node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
    `) as unknown as TypedDocumentString<PullRequestsQuery, PullRequestsQueryVariables>;