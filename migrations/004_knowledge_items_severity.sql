-- Rule severity projection.
--
-- A canonical Rule carries a `severity` (`info`/`warning`/`error`) in its
-- frontmatter (schemas/canonical-v1.schema.json `$defs.rule`), but the
-- projection into `knowledge_items` (packages/core/src/sync-canonical.ts) had
-- nowhere to put it, so `get_active_rules` could not return the severity the
-- MCP contract (mcp-contract.md §6.3) lists. Add a nullable `severity` column
-- so a Rule's severity survives the projection; it stays NULL for every
-- non-rule knowledge type (audit issue #30).
--
-- Column-only and forward-only: `sync --rebuild` re-projects the same value
-- from canonical data.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE knowledge_items
  ADD COLUMN severity TEXT CHECK (severity IS NULL OR severity IN ('info', 'warning', 'error'));

PRAGMA user_version = 4;

COMMIT;
