import { describe, expect, it, vi } from "vitest";
import { createGitHubProvider } from "./github-provider.js";

const REF = { owner: "octo", repo: "demo" };

function gqlOk(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gqlHttpError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A GraphQL-level error envelope (HTTP 200 with an `errors` array). */
function gqlErrors(errors: unknown[], data: unknown = null): Response {
  return new Response(JSON.stringify({ data, errors }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readCursor(init: RequestInit | undefined): string | null {
  if (typeof init?.body !== "string") {
    return null;
  }
  const parsed = JSON.parse(init.body) as { variables?: { cursor?: string | null } };
  return parsed.variables?.cursor ?? null;
}

interface Overrides {
  [key: string]: unknown;
}

function issueNode(over: Overrides = {}): Record<string, unknown> {
  return {
    id: "I_kwPr1",
    number: 1,
    title: "Login fails",
    url: "https://github.com/octo/demo/issues/1",
    state: "OPEN",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    closedAt: null,
    author: { id: "U_alice", login: "alice" },
    labels: { nodes: [{ name: "bug" }, null] },
    ...over,
  };
}

function issuesPage(nodes: unknown[], hasNextPage: boolean, endCursor: string | null): unknown {
  return { repository: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

function prNode(over: Overrides = {}): Record<string, unknown> {
  return {
    id: "PR_1",
    number: 10,
    title: "Add feature",
    url: "https://github.com/octo/demo/pull/10",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-05T00:00:00Z",
    mergedAt: null,
    author: { id: "U_alice", login: "alice" },
    closingIssuesReferences: { nodes: [{ id: "I_9" }, null] },
    reviewThreads: {
      nodes: [
        {
          isResolved: true,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: "C_1",
                url: "https://github.com/octo/demo/pull/10#discussion_r1",
                path: "src/a.ts",
                line: 3,
                body: "nit: rename this",
                createdAt: "2026-03-02T00:00:00Z",
                author: { id: "U_bob", login: "bob" },
              },
            ],
          },
        },
        {
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              {
                id: "C_2",
                url: null,
                path: null,
                line: null,
                body: "why here?",
                createdAt: "2026-03-03T00:00:00Z",
                author: null,
              },
            ],
          },
        },
      ],
    },
    ...over,
  };
}

function prPage(nodes: unknown[], hasNextPage: boolean, endCursor: string | null): unknown {
  return { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

describe("createGitHubProvider.listIssues", () => {
  it("paginates across pages, maps fields, and reports the newest watermark", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (readCursor(init) === null) {
        return gqlOk(
          issuesPage(
            [issueNode({ id: "I_2", number: 2, updatedAt: "2026-03-04T00:00:00Z" })],
            true,
            "CURSOR1",
          ),
        );
      }
      return gqlOk(
        issuesPage(
          [issueNode({ id: "I_1", number: 1, updatedAt: "2026-03-02T00:00:00Z" })],
          false,
          null,
        ),
      );
    });
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.issues).toHaveLength(2);
    expect(result.value.issues[0]).toMatchObject({
      externalId: "I_2",
      number: 2,
      state: "open",
      author: { login: "alice", displayName: "alice" },
      labels: ["bug"],
      openedAt: "2026-03-01T00:00:00Z",
    });
    expect(result.value.watermark).toBe("2026-03-04T00:00:00Z");
    expect(result.value.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops early at the since watermark and does not fetch further pages", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlOk(
        issuesPage(
          [
            issueNode({ id: "I_new", number: 3, updatedAt: "2026-03-10T00:00:00Z" }),
            issueNode({ id: "I_old", number: 2, updatedAt: "2026-03-01T00:00:00Z" }),
          ],
          true,
          "CURSOR1",
        ),
      ),
    );
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, "2026-03-05T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.issues).toHaveLength(1);
    expect(result.value.issues[0]?.externalId).toBe("I_new");
    expect(result.value.watermark).toBe("2026-03-10T00:00:00Z");
    // Early stop: the second page (hasNextPage=true) is never requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result with a null watermark when there are no issues", async () => {
    const fetchImpl = vi.fn(async () => gqlOk(issuesPage([], false, null)));
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.issues).toEqual([]);
    expect(result.value.watermark).toBeNull();
  });

  it("rejects a malformed node shape as a non-retryable FORGE_UNAVAILABLE", async () => {
    // `number` is missing → Zod rejects the page.
    const fetchImpl = vi.fn(async () =>
      gqlOk(issuesPage([{ id: "I_1", title: "x", state: "OPEN" }], false, null)),
    );
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("FORGE_UNAVAILABLE");
    expect(result.error.retryable).toBe(false);
  });

  it("maps HTTP 401 to a non-retryable error and 503 to a retryable one", async () => {
    const unauthorized = createGitHubProvider({
      token: "t",
      resilience: false,
      fetchImpl: vi.fn(async () => gqlHttpError(401, { message: "Bad credentials" })),
    });
    const unavailable = createGitHubProvider({
      token: "t",
      resilience: false,
      fetchImpl: vi.fn(async () => gqlHttpError(503, { message: "Service unavailable" })),
    });

    const authResult = await unauthorized.listIssues(REF, null);
    const svcResult = await unavailable.listIssues(REF, null);

    expect(authResult.ok).toBe(false);
    expect(svcResult.ok).toBe(false);
    if (authResult.ok || svcResult.ok) {
      return;
    }
    expect(authResult.error.retryable).toBe(false);
    expect(svcResult.error.retryable).toBe(true);
  });

  it("never leaks the token into the error even when the response body echoes it", async () => {
    // Built at runtime so no literal token pattern sits in source for secret
    // scanners to flag; this is a synthetic value, not a real credential.
    const TOKEN = `ghp_${"SyntheticTokenForLeakTestOnly".padEnd(36, "0")}`;
    const fetchImpl = vi.fn(async () =>
      gqlHttpError(401, { message: `Bad credentials for ${TOKEN}` }),
    );
    const provider = createGitHubProvider({ token: TOKEN, fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const serialized = [
      result.error.message,
      JSON.stringify(result.error),
      String(result.error.cause),
      result.error.stack ?? "",
    ].join(" | ");
    expect(serialized).not.toContain(TOKEN);
  });

  it("classifies a GraphQL NOT_FOUND as non-retryable and does not leak the token from the error envelope", async () => {
    const TOKEN = `ghp_${"NotFoundLeakProbeTokenValue".padEnd(36, "0")}`;
    const fetchImpl = vi.fn(async () =>
      gqlErrors(
        [{ type: "NOT_FOUND", message: `Could not resolve to a Repository. token=${TOKEN}` }],
        { repository: null },
      ),
    );
    const provider = createGitHubProvider({ token: TOKEN, fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // A missing/forbidden repo is permanent: it must not be retried forever.
    expect(result.error.code).toBe("FORGE_UNAVAILABLE");
    expect(result.error.retryable).toBe(false);
    // The GraphqlResponseError message embeds the echoed token; it must not surface.
    const serialized = [
      result.error.message,
      JSON.stringify(result.error),
      String(result.error.cause),
      result.error.stack ?? "",
    ].join(" | ");
    expect(serialized).not.toContain(TOKEN);
  });

  it("includes an item updated at the exact since second (strict early-stop, not <=)", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlOk(
        issuesPage(
          [
            issueNode({ id: "I_boundary", number: 5, updatedAt: "2026-03-05T00:00:00Z" }),
            issueNode({ id: "I_old", number: 4, updatedAt: "2026-03-04T23:59:59Z" }),
          ],
          true,
          "CURSOR1",
        ),
      ),
    );
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listIssues(REF, "2026-03-05T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The boundary item (== since) is kept; only the strictly-older one stops the scan.
    expect(result.value.issues.map((issue) => issue.externalId)).toEqual(["I_boundary"]);
  });

  it("flags truncated when the page bound is reached before draining", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlOk(issuesPage([issueNode({ id: "I_1", number: 1 })], true, "CURSOR1")),
    );
    const provider = createGitHubProvider({
      token: "t",
      fetchImpl,
      resilience: false,
      maxPages: 1,
    });

    const result = await provider.listIssues(REF, null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.truncated).toBe(true);
    expect(result.value.issues).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createGitHubProvider.listPullRequests", () => {
  it("maps PRs with review threads, resolution state, closed issues, and draft state", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlOk(
        prPage(
          [prNode({ isDraft: true, closingIssuesReferences: { nodes: [{ id: "I_9" }] } })],
          false,
          null,
        ),
      ),
    );
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listPullRequests(REF, null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.pullRequests).toHaveLength(1);
    const pr = result.value.pullRequests[0];
    expect(pr?.state).toBe("draft");
    expect(pr?.closesIssueExternalIds).toEqual(["I_9"]);
    expect(pr?.reviewThreads).toHaveLength(2);
    expect(pr?.reviewThreads[0]?.comments[0]).toMatchObject({
      externalId: "C_1",
      resolutionState: "resolved",
      path: "src/a.ts",
      bodySummary: "nit: rename this",
      author: { login: "bob" },
    });
    // Unresolved + outdated thread → "outdated"; author absent → null.
    expect(pr?.reviewThreads[1]?.comments[0]).toMatchObject({
      externalId: "C_2",
      resolutionState: "outdated",
      author: null,
    });
    expect(result.value.watermark).toBe("2026-03-05T00:00:00Z");
  });

  it("reflects an edited comment body in the mapped summary", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlOk(
        prPage(
          [
            prNode({
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    isOutdated: false,
                    comments: {
                      nodes: [
                        {
                          id: "C_1",
                          url: null,
                          path: null,
                          line: null,
                          body: "edited: please extract a helper",
                          createdAt: "2026-03-02T00:00:00Z",
                          author: { id: "U_bob", login: "bob" },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ],
          false,
          null,
        ),
      ),
    );
    const provider = createGitHubProvider({ token: "t", fetchImpl, resilience: false });

    const result = await provider.listPullRequests(REF, null);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.pullRequests[0]?.reviewThreads[0]?.comments[0]).toMatchObject({
      bodySummary: "edited: please extract a helper",
      resolutionState: "open",
    });
  });
});
