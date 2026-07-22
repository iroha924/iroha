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

/** Review-queue statuses the API's `status` filter accepts (mirrors `CandidateStatus`). */
export type CandidateStatusFilter = "pending" | "approved" | "rejected" | "superseded";
/** Knowledge entity statuses the API's `status` filter accepts (mirrors the canonical status enum). */
export type KnowledgeStatusFilter = "approved" | "superseded" | "archived";
/** Agent platforms the API's Session `platform` filter accepts. */
export type SessionPlatformFilter = "claude_code" | "codex";

export interface CandidateListParams {
  cursor?: string;
  status?: CandidateStatusFilter;
}
export interface KnowledgeListParams {
  cursor?: string;
  statuses?: KnowledgeStatusFilter[];
  types?: string[];
}
export interface SessionListParams {
  cursor?: string;
  platform?: SessionPlatformFilter;
  from?: string;
  to?: string;
}

/** Builds a query string, appending array values as repeated params; returns "" when empty. */
function queryString(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(key, v);
    } else {
      search.append(key, value);
    }
  }
  const s = search.toString();
  return s.length > 0 ? `?${s}` : "";
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

  candidates: (params: CandidateListParams = {}) =>
    request<CandidateQueuePage>(
      "GET",
      `/v1/candidates${queryString({ cursor: params.cursor, status: params.status })}`,
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

  knowledge: (params: KnowledgeListParams = {}) =>
    request<KnowledgeListPage>(
      "GET",
      `/v1/knowledge${queryString({ cursor: params.cursor, status: params.statuses, type: params.types })}`,
    ),
  knowledgeDetail: (id: string) => request<KnowledgeDetailData>("GET", `/v1/knowledge/${id}`),

  search: (query: string, options: SearchOptions = {}) =>
    request<McpSearchData>("POST", "/v1/search", { query, ...options }),

  sessions: (params: SessionListParams = {}) =>
    request<SessionListPage>(
      "GET",
      `/v1/sessions${queryString({
        cursor: params.cursor,
        platform: params.platform,
        from: params.from,
        to: params.to,
      })}`,
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
