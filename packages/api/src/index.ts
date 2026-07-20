/**
 * @iroha/api — the dashboard's local Hono API (dashboard-api.md).
 */

// The response `data` shapes each endpoint returns, re-exported so the SPA's
// typed API client (apps/dashboard) depends only on `@iroha/api` (the
// "generated API client" contract, compatibility.md §4) rather than reaching
// into `@iroha/core`. These are type-only and erase at build.
export type {
  BootstrapData,
  CandidateDetailData,
  CandidateQueueItem,
  CandidateQueuePage,
  CandidateStatusChangeData,
  CandidateValidation,
  CheckpointDetailData,
  EditCandidateData,
  GraphData,
  GraphEdge,
  GraphNode,
  GraphPathData,
  KnowledgeDetailData,
  KnowledgeListItem,
  KnowledgeListPage,
  KnowledgeRelation,
  OverviewData,
  RepositoryConfig,
  RunDetailData,
  SessionDetailData,
  SessionListItem,
  SessionListPage,
  SettingsData,
  SyncStatusData,
} from "@iroha/core";
export { type AppConfig, type AppType, createApp } from "./app.js";
export { type Auth, createAuth, SESSION_COOKIE } from "./auth.js";
export type {
  ApiError,
  FailureEnvelope,
  SuccessEnvelope,
} from "./envelope.js";
export {
  type DashboardServer,
  type StartDashboardOptions,
  startDashboardServer,
} from "./server.js";
