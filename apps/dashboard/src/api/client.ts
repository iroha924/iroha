import type {
  ApproveCandidateData,
  BootstrapData,
  CandidateDetailData,
  CandidateQueuePage,
  CandidateStatusChangeData,
  EditCandidateData,
  KnowledgeDetailData,
  KnowledgeListPage,
  McpSearchData,
  OverviewData,
} from "@iroha/api";

/** A failed API envelope surfaced as a throwable, preserving the stable code and field errors. */
export class ApiClientError extends Error {
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  constructor(code: string, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

interface SuccessBody<T> {
  ok: true;
  data: T;
  meta: { requestId: string };
}
interface FailureBody {
  ok: false;
  error: { code: string; message: string; retryable: boolean; fieldErrors: Record<string, string> };
  meta: { requestId: string };
}

const MUTATION_HEADERS = { "Content-Type": "application/json", "X-Iroha-Request": "1" };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    ...(method === "GET" ? {} : { headers: MUTATION_HEADERS }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as SuccessBody<T> | FailureBody;
  if (!json.ok) {
    throw new ApiClientError(json.error.code, json.error.message, json.error.fieldErrors);
  }
  return json.data;
}

export interface ReviewActor {
  provider: "git" | "github" | "gitlab" | "local";
  displayName: string;
}

/** The typed dashboard API client — the SPA's only channel to the local server. */
export const api = {
  exchange: (token: string) =>
    request<{ authenticated: boolean }>("POST", "/auth/exchange", { token }),
  logout: () => request<{ authenticated: boolean }>("POST", "/auth/logout"),
  bootstrap: () => request<BootstrapData>("GET", "/v1/bootstrap"),
  overview: () => request<OverviewData>("GET", "/v1/overview"),

  candidates: (cursor?: string) =>
    request<CandidateQueuePage>(
      "GET",
      `/v1/candidates${cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  candidate: (id: string) => request<CandidateDetailData>("GET", `/v1/candidates/${id}`),
  editCandidate: (id: string, revisionToken: string, draft: unknown) =>
    request<EditCandidateData>("PATCH", `/v1/candidates/${id}`, { revisionToken, draft }),
  approve: (id: string, revisionToken: string, actor: ReviewActor, comment?: string) =>
    request<ApproveCandidateData>("POST", `/v1/candidates/${id}/approve`, {
      revisionToken,
      actor,
      ...(comment !== undefined ? { comment } : {}),
    }),
  reject: (id: string, revisionToken: string, reason?: string) =>
    request<CandidateStatusChangeData>("POST", `/v1/candidates/${id}/reject`, {
      revisionToken,
      ...(reason !== undefined ? { reason } : {}),
    }),
  supersede: (id: string, revisionToken: string) =>
    request<CandidateStatusChangeData>("POST", `/v1/candidates/${id}/supersede`, { revisionToken }),

  knowledge: (cursor?: string) =>
    request<KnowledgeListPage>(
      "GET",
      `/v1/knowledge${cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  knowledgeDetail: (id: string) => request<KnowledgeDetailData>("GET", `/v1/knowledge/${id}`),

  search: (query: string) => request<McpSearchData>("POST", "/v1/search", { query }),
};
