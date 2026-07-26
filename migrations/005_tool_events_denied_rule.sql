-- Guardrail-denial rule attribution.
--
-- A denied tool use is already recorded as `tool_events.phase = 'denied'` /
-- `status = 'denied'` with the offending path in `target_summary`, but the Rule
-- that denied it was only returned to the agent, never stored — so a denial
-- count carried no lesson. This column keeps it, and the Digest read model
-- (packages/storage/src/repositories/digest.ts) groups a period's denials by it.
--
-- It is written on the row `handleToolStarted` already inserts for the denied
-- tool use, so it costs the hook no additional write. That matters: the hook
-- path may not add a write of its own, because a second INSERT waits on
-- libSQL's 2500ms `busy_timeout` and was measured killing a PreToolUse denial
-- at 7932ms against a 0.5s budget (packages/core/src/hooks/dispatch.ts).
--
-- Deliberately no `REFERENCES knowledge_items(id)`. The value always comes from
-- a row `listApprovedRulesForRepository` just read from this same database, so a
-- foreign key would police a constraint that cannot be violated; a Rule removed
-- from canonical is tombstoned in place, not deleted (sync-canonical.ts), so
-- `ON DELETE SET NULL` would never fire either. What it would add is a way for
-- the INSERT to fail and lose the whole audit row on the one path that must not
-- lose it. The read model resolves the title with a LEFT JOIN, so an id whose
-- Rule is gone reads as an unattributed denial rather than a dangling link.
--
-- Column-only and forward-only. `tool_events` is disposable local index state
-- that `sync --rebuild` drops entirely, so there is nothing to backfill.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE tool_events
  ADD COLUMN denied_by_rule_id TEXT;

-- Denials are rare, so a partial index over just them makes the Digest's
-- period window a short scan instead of a full table scan. `denied_by_rule_id`
-- is carried so the attribution GROUP BY is satisfied from the index.
CREATE INDEX idx_tool_events_denied
  ON tool_events(occurred_at, denied_by_rule_id) WHERE status = 'denied';

PRAGMA user_version = 5;

COMMIT;
