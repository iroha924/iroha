import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableNumber, nullableString } from "../row-helpers.js";

// --- work_items ---------------------------------------------------

export type WorkItemProvider = "github" | "gitlab" | "local";
export type WorkItemState = "open" | "closed" | "unknown";

export interface WorkItemRow {
  id: TypedId<"iss">;
  repositoryId: TypedId<"repo">;
  provider: WorkItemProvider;
  externalId: string | null;
  number: number | null;
  url: string | null;
  state: WorkItemState;
  authorActorId: TypedId<"act"> | null;
  bodySummary: string | null;
  labelsJson: string;
  openedAt: string | null;
  closedAt: string | null;
}

export interface UpsertWorkItemInput {
  id: TypedId<"iss">;
  repositoryId: TypedId<"repo">;
  provider: WorkItemProvider;
  externalId?: string;
  number?: number;
  url?: string;
  state: WorkItemState;
  authorActorId?: TypedId<"act">;
  bodySummary?: string;
  labelsJson?: string;
  openedAt?: string;
  closedAt?: string;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItemRow {
  return {
    id: row.id as TypedId<"iss">,
    repositoryId: row.repository_id as TypedId<"repo">,
    provider: row.provider as WorkItemProvider,
    externalId: nullableString(row.external_id),
    number: nullableNumber(row.number),
    url: nullableString(row.url),
    state: row.state as WorkItemState,
    authorActorId: row.author_actor_id === null ? null : (row.author_actor_id as TypedId<"act">),
    bodySummary: nullableString(row.body_summary),
    labelsJson: String(row.labels_json),
    openedAt: nullableString(row.opened_at),
    closedAt: nullableString(row.closed_at),
  };
}

/** Keyed on `(repository_id, provider, external_id)` so incremental sync re-runs are idempotent. */
export async function upsertWorkItem(
  db: Executor,
  input: UpsertWorkItemInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO work_items
        (id, repository_id, provider, external_id, number, url, state, author_actor_id, body_summary, labels_json, opened_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (repository_id, provider, external_id) DO UPDATE SET
          number = excluded.number,
          url = excluded.url,
          state = excluded.state,
          author_actor_id = excluded.author_actor_id,
          body_summary = excluded.body_summary,
          labels_json = excluded.labels_json,
          opened_at = excluded.opened_at,
          closed_at = excluded.closed_at`,
      args: [
        input.id,
        input.repositoryId,
        input.provider,
        input.externalId ?? null,
        input.number ?? null,
        input.url ?? null,
        input.state,
        input.authorActorId ?? null,
        input.bodySummary ?? null,
        input.labelsJson ?? "[]",
        input.openedAt ?? null,
        input.closedAt ?? null,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert work item"));
  }
}

export async function getWorkItemById(
  db: Executor,
  id: TypedId<"iss">,
): Promise<Result<WorkItemRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM work_items WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToWorkItem(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read work item"));
  }
}

export async function getWorkItemByExternalId(
  db: Executor,
  repositoryId: TypedId<"repo">,
  provider: WorkItemProvider,
  externalId: string,
): Promise<Result<WorkItemRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM work_items WHERE repository_id = ? AND provider = ? AND external_id = ?",
      args: [repositoryId, provider, externalId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToWorkItem(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read work item"));
  }
}

// --- commits ---------------------------------------------------

export interface CommitRow {
  id: TypedId<"com">;
  repositoryId: TypedId<"repo">;
  sha: string;
  authorActorId: TypedId<"act"> | null;
  message: string;
  committedAt: string;
}

export interface UpsertCommitInput {
  id: TypedId<"com">;
  repositoryId: TypedId<"repo">;
  sha: string;
  authorActorId?: TypedId<"act">;
  message: string;
  committedAt: string;
}

function rowToCommit(row: Record<string, unknown>): CommitRow {
  return {
    id: row.id as TypedId<"com">,
    repositoryId: row.repository_id as TypedId<"repo">,
    sha: String(row.sha),
    authorActorId: row.author_actor_id === null ? null : (row.author_actor_id as TypedId<"act">),
    message: String(row.message),
    committedAt: String(row.committed_at),
  };
}

/** Keyed on `(repository_id, sha)` so re-scanning Git history is idempotent. */
export async function upsertCommit(
  db: Executor,
  input: UpsertCommitInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO commits (id, repository_id, sha, author_actor_id, message, committed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (repository_id, sha) DO UPDATE SET
          author_actor_id = excluded.author_actor_id,
          message = excluded.message,
          committed_at = excluded.committed_at`,
      args: [
        input.id,
        input.repositoryId,
        input.sha,
        input.authorActorId ?? null,
        input.message,
        input.committedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert commit"));
  }
}

export async function getCommitById(
  db: Executor,
  id: TypedId<"com">,
): Promise<Result<CommitRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM commits WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCommit(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read commit"));
  }
}

export async function getCommitBySha(
  db: Executor,
  repositoryId: TypedId<"repo">,
  sha: string,
): Promise<Result<CommitRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM commits WHERE repository_id = ? AND sha = ?",
      args: [repositoryId, sha],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCommit(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read commit"));
  }
}

// --- pull_requests ---------------------------------------------------

export type PullRequestProvider = "github" | "gitlab";
export type PullRequestState = "open" | "closed" | "merged" | "draft" | "unknown";

export interface PullRequestRow {
  id: TypedId<"pr">;
  repositoryId: TypedId<"repo">;
  provider: PullRequestProvider;
  externalId: string;
  number: number;
  url: string;
  state: PullRequestState;
  baseRef: string | null;
  headRef: string | null;
  authorActorId: TypedId<"act"> | null;
  openedAt: string | null;
  mergedAt: string | null;
}

export interface UpsertPullRequestInput {
  id: TypedId<"pr">;
  repositoryId: TypedId<"repo">;
  provider: PullRequestProvider;
  externalId: string;
  number: number;
  url: string;
  state: PullRequestState;
  baseRef?: string;
  headRef?: string;
  authorActorId?: TypedId<"act">;
  openedAt?: string;
  mergedAt?: string;
}

function rowToPullRequest(row: Record<string, unknown>): PullRequestRow {
  return {
    id: row.id as TypedId<"pr">,
    repositoryId: row.repository_id as TypedId<"repo">,
    provider: row.provider as PullRequestProvider,
    externalId: String(row.external_id),
    number: Number(row.number),
    url: String(row.url),
    state: row.state as PullRequestState,
    baseRef: nullableString(row.base_ref),
    headRef: nullableString(row.head_ref),
    authorActorId: row.author_actor_id === null ? null : (row.author_actor_id as TypedId<"act">),
    openedAt: nullableString(row.opened_at),
    mergedAt: nullableString(row.merged_at),
  };
}

/** Keyed on `(repository_id, provider, external_id)` so incremental sync re-runs are idempotent. */
export async function upsertPullRequest(
  db: Executor,
  input: UpsertPullRequestInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO pull_requests
        (id, repository_id, provider, external_id, number, url, state, base_ref, head_ref, author_actor_id, opened_at, merged_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (repository_id, provider, external_id) DO UPDATE SET
          number = excluded.number,
          url = excluded.url,
          state = excluded.state,
          base_ref = excluded.base_ref,
          head_ref = excluded.head_ref,
          author_actor_id = excluded.author_actor_id,
          opened_at = excluded.opened_at,
          merged_at = excluded.merged_at`,
      args: [
        input.id,
        input.repositoryId,
        input.provider,
        input.externalId,
        input.number,
        input.url,
        input.state,
        input.baseRef ?? null,
        input.headRef ?? null,
        input.authorActorId ?? null,
        input.openedAt ?? null,
        input.mergedAt ?? null,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert pull request"));
  }
}

export async function getPullRequestById(
  db: Executor,
  id: TypedId<"pr">,
): Promise<Result<PullRequestRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM pull_requests WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToPullRequest(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read pull request"));
  }
}

export async function getPullRequestByExternalId(
  db: Executor,
  repositoryId: TypedId<"repo">,
  provider: PullRequestProvider,
  externalId: string,
): Promise<Result<PullRequestRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM pull_requests WHERE repository_id = ? AND provider = ? AND external_id = ?",
      args: [repositoryId, provider, externalId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToPullRequest(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read pull request"));
  }
}

// --- review_comments ---------------------------------------------------

export type ReviewCommentProvider = "github" | "gitlab";
export type ReviewCommentResolutionState = "open" | "resolved" | "outdated" | "unknown";

export interface ReviewCommentRow {
  id: TypedId<"cmt">;
  pullRequestId: TypedId<"pr">;
  provider: ReviewCommentProvider;
  externalId: string;
  url: string | null;
  authorActorId: TypedId<"act"> | null;
  path: string | null;
  line: number | null;
  bodySummary: string;
  resolutionState: ReviewCommentResolutionState;
  createdAt: string;
}

export interface UpsertReviewCommentInput {
  id: TypedId<"cmt">;
  pullRequestId: TypedId<"pr">;
  provider: ReviewCommentProvider;
  externalId: string;
  url?: string;
  authorActorId?: TypedId<"act">;
  path?: string;
  line?: number;
  bodySummary: string;
  resolutionState: ReviewCommentResolutionState;
  createdAt: string;
}

function rowToReviewComment(row: Record<string, unknown>): ReviewCommentRow {
  return {
    id: row.id as TypedId<"cmt">,
    pullRequestId: row.pull_request_id as TypedId<"pr">,
    provider: row.provider as ReviewCommentProvider,
    externalId: String(row.external_id),
    url: nullableString(row.url),
    authorActorId: row.author_actor_id === null ? null : (row.author_actor_id as TypedId<"act">),
    path: nullableString(row.path),
    line: nullableNumber(row.line),
    bodySummary: String(row.body_summary),
    resolutionState: row.resolution_state as ReviewCommentResolutionState,
    createdAt: String(row.created_at),
  };
}

/** Keyed on `(provider, external_id)` so incremental sync re-runs are idempotent. */
export async function upsertReviewComment(
  db: Executor,
  input: UpsertReviewCommentInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO review_comments
        (id, pull_request_id, provider, external_id, url, author_actor_id, path, line, body_summary, resolution_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, external_id) DO UPDATE SET
          url = excluded.url,
          author_actor_id = excluded.author_actor_id,
          path = excluded.path,
          line = excluded.line,
          body_summary = excluded.body_summary,
          resolution_state = excluded.resolution_state`,
      args: [
        input.id,
        input.pullRequestId,
        input.provider,
        input.externalId,
        input.url ?? null,
        input.authorActorId ?? null,
        input.path ?? null,
        input.line ?? null,
        input.bodySummary,
        input.resolutionState,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert review comment"));
  }
}

export async function getReviewCommentById(
  db: Executor,
  id: TypedId<"cmt">,
): Promise<Result<ReviewCommentRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM review_comments WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToReviewComment(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read review comment"));
  }
}

export async function listReviewCommentsByPullRequest(
  db: Executor,
  pullRequestId: TypedId<"pr">,
): Promise<Result<ReviewCommentRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM review_comments WHERE pull_request_id = ? ORDER BY created_at",
      args: [pullRequestId],
    });
    return ok(result.rows.map(rowToReviewComment));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list review comments"));
  }
}

// --- files ---------------------------------------------------

export interface FileRow {
  id: TypedId<"fil">;
  repositoryId: TypedId<"repo">;
  path: string;
  language: string | null;
  lastBlobSha: string | null;
}

export interface UpsertFileInput {
  id: TypedId<"fil">;
  repositoryId: TypedId<"repo">;
  path: string;
  language?: string;
  lastBlobSha?: string;
}

function rowToFile(row: Record<string, unknown>): FileRow {
  return {
    id: row.id as TypedId<"fil">,
    repositoryId: row.repository_id as TypedId<"repo">,
    path: String(row.path),
    language: nullableString(row.language),
    lastBlobSha: nullableString(row.last_blob_sha),
  };
}

/** Keyed on `(repository_id, path)` so re-scanning the worktree is idempotent. */
export async function upsertFile(
  db: Executor,
  input: UpsertFileInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO files (id, repository_id, path, language, last_blob_sha)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (repository_id, path) DO UPDATE SET
          language = excluded.language,
          last_blob_sha = excluded.last_blob_sha`,
      args: [
        input.id,
        input.repositoryId,
        input.path,
        input.language ?? null,
        input.lastBlobSha ?? null,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert file"));
  }
}

export async function getFileById(
  db: Executor,
  id: TypedId<"fil">,
): Promise<Result<FileRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM files WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToFile(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read file"));
  }
}

export async function getFileByPath(
  db: Executor,
  repositoryId: TypedId<"repo">,
  path: string,
): Promise<Result<FileRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM files WHERE repository_id = ? AND path = ?",
      args: [repositoryId, path],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToFile(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read file"));
  }
}

// --- symbols ---------------------------------------------------

export interface SymbolRow {
  id: TypedId<"sym">;
  fileId: TypedId<"fil">;
  symbolKind: string;
  qualifiedName: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface UpsertSymbolInput {
  id: TypedId<"sym">;
  fileId: TypedId<"fil">;
  symbolKind: string;
  qualifiedName: string;
  lineStart?: number;
  lineEnd?: number;
}

function rowToSymbol(row: Record<string, unknown>): SymbolRow {
  return {
    id: row.id as TypedId<"sym">,
    fileId: row.file_id as TypedId<"fil">,
    symbolKind: String(row.symbol_kind),
    qualifiedName: String(row.qualified_name),
    lineStart: nullableNumber(row.line_start),
    lineEnd: nullableNumber(row.line_end),
  };
}

/** Keyed on `(file_id, symbol_kind, qualified_name)` so re-scanning a file is idempotent. */
export async function upsertSymbol(
  db: Executor,
  input: UpsertSymbolInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO symbols (id, file_id, symbol_kind, qualified_name, line_start, line_end)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (file_id, symbol_kind, qualified_name) DO UPDATE SET
          line_start = excluded.line_start,
          line_end = excluded.line_end`,
      args: [
        input.id,
        input.fileId,
        input.symbolKind,
        input.qualifiedName,
        input.lineStart ?? null,
        input.lineEnd ?? null,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert symbol"));
  }
}

export async function getSymbolById(
  db: Executor,
  id: TypedId<"sym">,
): Promise<Result<SymbolRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM symbols WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSymbol(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read symbol"));
  }
}

export async function listSymbolsByFile(
  db: Executor,
  fileId: TypedId<"fil">,
): Promise<Result<SymbolRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM symbols WHERE file_id = ? ORDER BY qualified_name",
      args: [fileId],
    });
    return ok(result.rows.map(rowToSymbol));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list symbols"));
  }
}
