-- Session tokens for the Hook -> MCP boundary.
--
-- A 256-bit token (`ist_<base64url>`) is issued by the SessionStart hook and
-- returned to the agent in its context; the MCP server (a later work package)
-- verifies it before accepting a local mutation. Only the salt-keyed
-- HMAC-SHA-256 of the token is stored, so a leaked database never reveals a
-- usable token (implementation/design.md §9, implementation/mcp-contract.md §5).
--
-- This is disposable local operational state: it is bound to one repository /
-- Agent Session / Session Run / platform, and `sync --rebuild` reconstructs the
-- database from canonical data only, so this table starts empty after a rebuild.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE session_tokens (
  token_hmac TEXT PRIMARY KEY CHECK (token_hmac GLOB 'hmac-sha256:*'),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES session_runs(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('claude_code', 'codex')),
  issued_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_session_tokens_run ON session_tokens(run_id);
CREATE INDEX idx_session_tokens_expiry ON session_tokens(expires_at);

PRAGMA user_version = 2;

COMMIT;
