PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum GLOB 'sha256:[0-9a-f]*'),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY CHECK (id GLOB 'repo_*'),
  vcs TEXT NOT NULL CHECK (vcs = 'git'),
  root_fingerprint TEXT NOT NULL UNIQUE,
  remote_url_normalized TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE actors (
  id TEXT PRIMARY KEY CHECK (id GLOB 'act_*'),
  provider TEXT NOT NULL CHECK (provider IN ('git', 'github', 'gitlab', 'local')),
  external_id TEXT,
  display_name TEXT NOT NULL,
  email_hash TEXT CHECK (email_hash IS NULL OR email_hash GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_id)
) STRICT;

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'session', 'checkpoint', 'issue', 'commit', 'pull_request', 'review',
    'file', 'symbol', 'decision', 'rule', 'concept', 'insight', 'incident',
    'pattern', 'review_learning', 'validation'
  )),
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  authority INTEGER NOT NULL DEFAULT 20 CHECK (authority BETWEEN 0 AND 100),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'canonical', 'hook', 'mcp', 'git', 'github', 'gitlab', 'import', 'inferred', 'human'
  )),
  source_ref TEXT,
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_entities_repository_type
  ON entities(repository_id, entity_type, status);
CREATE INDEX idx_entities_updated
  ON entities(repository_id, updated_at DESC);
CREATE INDEX idx_entities_source
  ON entities(repository_id, source_kind, source_ref);

CREATE TABLE canonical_documents (
  entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  frontmatter_json TEXT NOT NULL CHECK (json_valid(frontmatter_json)),
  body TEXT NOT NULL,
  file_hash TEXT NOT NULL CHECK (file_hash GLOB 'sha256:*'),
  approved_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'ses_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('claude_code', 'codex')),
  platform_session_id TEXT,
  parent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  model_last_seen TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  summary_status TEXT NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none', 'draft', 'approved'))
) STRICT;

CREATE UNIQUE INDEX idx_agent_sessions_platform_identity
  ON agent_sessions(repository_id, platform, platform_session_id)
  WHERE platform_session_id IS NOT NULL;

CREATE TABLE session_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'run_*'),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  start_source TEXT NOT NULL CHECK (start_source IN ('startup', 'resume', 'clear')),
  cwd_fingerprint TEXT NOT NULL,
  git_branch TEXT,
  head_sha_start TEXT,
  head_sha_end TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN (
    'normal', 'clear', 'logout', 'prompt_input_exit', 'other', 'interrupted', 'abandoned'
  )),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted', 'abandoned')),
  CHECK ((status = 'active' AND ended_at IS NULL) OR status <> 'active')
) STRICT;

CREATE INDEX idx_session_runs_session_time
  ON session_runs(session_id, started_at DESC);
CREATE INDEX idx_session_runs_active
  ON session_runs(status, started_at)
  WHERE status = 'active';

CREATE TABLE turns (
  id TEXT PRIMARY KEY CHECK (id GLOB 'trn_*'),
  run_id TEXT NOT NULL REFERENCES session_runs(id) ON DELETE CASCADE,
  external_turn_id TEXT,
  external_prompt_id TEXT,
  prompt_digest TEXT CHECK (prompt_digest IS NULL OR prompt_digest GLOB 'hmac-sha256:*'),
  intent_summary TEXT,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'interrupted')),
  checkpoint_state TEXT NOT NULL DEFAULT 'not_required' CHECK (
    checkpoint_state IN ('not_required', 'pending', 'saved')
  )
) STRICT;

CREATE UNIQUE INDEX idx_turns_external
  ON turns(run_id, external_turn_id)
  WHERE external_turn_id IS NOT NULL;
CREATE INDEX idx_turns_run_time ON turns(run_id, started_at DESC);

CREATE TABLE tool_events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'evt_*'),
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  external_tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pre', 'post', 'failure', 'denied')),
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('file', 'path', 'command', 'mcp', 'other')),
  target_summary TEXT,
  input_digest TEXT CHECK (input_digest IS NULL OR input_digest GLOB 'hmac-sha256:*'),
  response_digest TEXT CHECK (response_digest IS NULL OR response_digest GLOB 'hmac-sha256:*'),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'denied')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_tool_events_turn_time ON tool_events(turn_id, occurred_at);
CREATE INDEX idx_tool_events_tool ON tool_events(tool_name, status, occurred_at DESC);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'chk_*'),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'partial', 'blocked', 'no_change')),
  objective TEXT NOT NULL,
  summary TEXT NOT NULL,
  implementation_json TEXT NOT NULL CHECK (json_valid(implementation_json)),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  unresolved_json TEXT NOT NULL CHECK (json_valid(unresolved_json)),
  references_json TEXT NOT NULL CHECK (json_valid(references_json)),
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_checkpoints_session_time ON checkpoints(session_id, created_at DESC);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'iss_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'local')),
  external_id TEXT,
  number INTEGER,
  url TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
  author_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  body_summary TEXT,
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
  opened_at TEXT,
  closed_at TEXT,
  UNIQUE (repository_id, provider, external_id)
) STRICT;

CREATE TABLE commits (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'com_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  author_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  UNIQUE (repository_id, sha)
) STRICT;

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'pr_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  external_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged', 'draft', 'unknown')),
  base_ref TEXT,
  head_ref TEXT,
  author_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  opened_at TEXT,
  merged_at TEXT,
  UNIQUE (repository_id, provider, external_id)
) STRICT;

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'cmt_*'),
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  external_id TEXT NOT NULL,
  url TEXT,
  author_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  path TEXT,
  line INTEGER,
  body_summary TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('open', 'resolved', 'outdated', 'unknown')),
  created_at TEXT NOT NULL,
  UNIQUE (provider, external_id)
) STRICT;

CREATE TABLE files (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'fil_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT,
  last_blob_sha TEXT,
  UNIQUE (repository_id, path)
) STRICT;

CREATE TABLE symbols (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE CHECK (id GLOB 'sym_*'),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_kind TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  UNIQUE (file_id, symbol_kind, qualified_name)
) STRICT;

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  knowledge_type TEXT NOT NULL CHECK (knowledge_type IN (
    'decision', 'rule', 'concept', 'insight', 'incident', 'pattern', 'review_learning'
  )),
  body TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  enforcement TEXT NOT NULL DEFAULT 'advisory' CHECK (enforcement IN ('advisory', 'guardrail')),
  guard_spec_json TEXT CHECK (guard_spec_json IS NULL OR json_valid(guard_spec_json)),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  approved_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  approved_at TEXT,
  canonical_path TEXT,
  CHECK (enforcement <> 'guardrail' OR guard_spec_json IS NOT NULL)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cand_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  target_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  candidate_type TEXT NOT NULL CHECK (candidate_type IN (
    'session_summary', 'decision', 'rule', 'concept', 'insight', 'incident', 'pattern', 'review_learning'
  )),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  source_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  revision_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_candidates_queue
  ON candidates(repository_id, status, created_at DESC);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK (id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'supersede', 'edit')),
  before_hash TEXT CHECK (before_hash IS NULL OR before_hash GLOB 'sha256:*'),
  after_hash TEXT CHECK (after_hash IS NULL OR after_hash GLOB 'sha256:*'),
  comment TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approvals_candidate_time ON approvals(candidate_id, created_at);

CREATE TABLE relations (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rel_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'ADDRESSES', 'IMPLEMENTED_IN', 'PRODUCED', 'AUTHORED_BY', 'REVIEWED_IN',
    'DERIVED_FROM', 'APPLIES_TO', 'AFFECTS', 'VALIDATED_BY', 'BLOCKED_BY',
    'SUPERSEDES', 'CONTRADICTS', 'DUPLICATES', 'RELATED_TO', 'PARENT_OF'
  )),
  to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('canonical', 'api', 'git', 'inferred', 'human', 'hook')),
  source_ref TEXT,
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  created_at TEXT NOT NULL,
  CHECK (from_entity_id <> to_entity_id OR relation_type = 'RELATED_TO'),
  UNIQUE (from_entity_id, relation_type, to_entity_id, source_kind)
) STRICT;

CREATE INDEX idx_relations_from ON relations(repository_id, from_entity_id, relation_type);
CREATE INDEX idx_relations_to ON relations(repository_id, to_entity_id, relation_type);

CREATE TABLE search_documents (
  id TEXT PRIMARY KEY CHECK (id GLOB 'sdoc_*'),
  entity_id TEXT NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  document_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  code_terms TEXT NOT NULL DEFAULT '',
  language_hint TEXT,
  authority INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 100),
  content_hash TEXT NOT NULL CHECK (content_hash GLOB 'sha256:*'),
  indexed_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE search_fts_unicode USING fts5(
  title,
  body,
  code_terms,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '-_'"
);

CREATE VIRTUAL TABLE search_fts_trigram USING fts5(
  title,
  body,
  code_terms,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = 'trigram case_sensitive 0'
);

CREATE TRIGGER search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_fts_unicode(rowid, title, body, code_terms)
    VALUES (new.rowid, new.title, new.body, new.code_terms);
  INSERT INTO search_fts_trigram(rowid, title, body, code_terms)
    VALUES (new.rowid, new.title, new.body, new.code_terms);
END;

CREATE TRIGGER search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_fts_unicode(search_fts_unicode, rowid, title, body, code_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.code_terms);
  INSERT INTO search_fts_trigram(search_fts_trigram, rowid, title, body, code_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.code_terms);
END;

CREATE TRIGGER search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_fts_unicode(search_fts_unicode, rowid, title, body, code_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.code_terms);
  INSERT INTO search_fts_unicode(rowid, title, body, code_terms)
    VALUES (new.rowid, new.title, new.body, new.code_terms);
  INSERT INTO search_fts_trigram(search_fts_trigram, rowid, title, body, code_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.code_terms);
  INSERT INTO search_fts_trigram(rowid, title, body, code_terms)
    VALUES (new.rowid, new.title, new.body, new.code_terms);
END;

CREATE TABLE embeddings_1024 (
  row_id INTEGER PRIMARY KEY,
  search_document_id TEXT NOT NULL UNIQUE REFERENCES search_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'voyage'),
  model TEXT NOT NULL CHECK (model = 'voyage-4-large'),
  dimension INTEGER NOT NULL CHECK (dimension = 1024),
  content_hash TEXT NOT NULL CHECK (content_hash GLOB 'sha256:*'),
  embedding F32_BLOB(1024) NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX embeddings_1024_vector_idx
  ON embeddings_1024(libsql_vector_idx(embedding, 'metric=cosine'));

CREATE TABLE embedding_jobs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'job_*'),
  search_document_id TEXT NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (search_document_id, provider, model)
) STRICT;

CREATE INDEX idx_embedding_jobs_work
  ON embedding_jobs(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE sync_cursors (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  cursor TEXT,
  state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state_json)),
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error_code TEXT,
  PRIMARY KEY (repository_id, provider)
) STRICT;

CREATE TABLE dirty_markers (
  id TEXT PRIMARY KEY CHECK (id GLOB 'dirty_*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  marker_type TEXT NOT NULL CHECK (marker_type IN (
    'canonical_db_divergence', 'interrupted_run', 'embedding_retry', 'sync_required'
  )),
  entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE INDEX idx_dirty_markers_open
  ON dirty_markers(repository_id, marker_type, created_at)
  WHERE resolved_at IS NULL;

CREATE TABLE local_settings (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, key)
) STRICT;

CREATE TABLE event_log (
  id TEXT PRIMARY KEY CHECK (id GLOB 'log_*'),
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  adapter TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'warning', 'failure', 'denied')),
  error_code TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_event_log_repository_time ON event_log(repository_id, occurred_at DESC);

CREATE TABLE idempotency_keys (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 100),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  result_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, operation, idempotency_key)
) STRICT;

CREATE INDEX idx_idempotency_keys_expiry ON idempotency_keys(expires_at);

PRAGMA user_version = 1;

COMMIT;
