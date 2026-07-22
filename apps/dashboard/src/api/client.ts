import type {
  ApproveCandidateData,
  BootstrapData,
  CandidateDetailData,
  CandidateQueuePage,
  CandidateStatusChangeData,
  CheckpointDetailData,
  DoctorRepairData,
  DoctorReport,
  EditCandidateData,
  GraphData,
  GraphPathData,
  KnowledgeDetailData,
  KnowledgeListPage,
  McpSearchData,
  OverviewData,
  RepositoryConfig,
  RunDetailData,
  SessionDetailData,
  SessionListPage,
  SettingsData,
  SyncCanonicalResult,
  SyncStatusData,
} from "@iroha/api";

export type SearchMode = "hybrid" | "lexical" | "vector" | "graph";

/** Hybrid-retrieval filters accepted by `POST /v1/search` (mirrors the API's `searchSchema.filters`). */
export interface SearchFilters {
  entityTypes?: string[];
  statuses?: string[];
  labels?: string[];
  minimumAuthority?: number;
  from?: string;
  to?: string;
  paths?: string[];
  symbols?: string[];
  issueRefs?: string[];
}

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  filters?: SearchFilters;
}

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

  search: (query: string, options: SearchOptions = {}) =>
    request<McpSearchData>("POST", "/v1/search", { query, ...options }),

  sessions: (cursor?: string) =>
    request<SessionListPage>(
      "GET",
      `/v1/sessions${cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  sessionDetail: (id: string) => request<SessionDetailData>("GET", `/v1/sessions/${id}`),
  runDetail: (sessionId: string, runId: string) =>
    request<RunDetailData>("GET", `/v1/sessions/${sessionId}/runs/${runId}`),
  checkpoint: (id: string) => request<CheckpointDetailData>("GET", `/v1/checkpoints/${id}`),

  settings: () => request<SettingsData>("GET", "/v1/settings"),
  updateSharedConfig: (config: RepositoryConfig) =>
    request<RepositoryConfig>("PATCH", "/v1/settings/shared", config),

  doctor: () => request<DoctorReport>("GET", "/v1/doctor"),
  doctorRepair: (operation: string) =>
    request<DoctorRepairData>("POST", "/v1/doctor/repair", { operation }),

  syncStatus: () => request<SyncStatusData>("GET", "/v1/sync/status"),
  sync: () => request<SyncCanonicalResult>("POST", "/v1/sync"),

  graphQuery: (roots: string[], depth?: number) =>
    request<GraphData>("POST", "/v1/graph/query", {
      roots,
      ...(depth !== undefined ? { depth } : {}),
    }),
  entityRelations: (id: string) => request<GraphData>("GET", `/v1/entities/${id}/relations`),
  graphPath: (from: string, to: string) =>
    request<GraphPathData>(
      "GET",
      `/v1/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
};
