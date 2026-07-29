-- Removes the composed-prose store for the Digest front page.
--
-- The Digest was a per-period editorial page: iroha computed the numbers and the
-- developer's own agent session narrated them through `get_digest_data` /
-- `save_digest_prose`. It has been replaced by the Overview page, which reports
-- the same facts that changed a reader's next action — how enforceable the
-- approved Guardrail set is, which Rules denied what, and where those denials
-- clustered — and drops the activity volumes (sessions, checkpoints, period
-- totals) that were counted but never acted on.
--
-- Nothing is lost that was not already declared disposable. `digest_issues` is
-- local index state by contract (database.md §16): its rows are dropped by
-- `sync --rebuild` and deliberately kept out of canonical, so they were never
-- reconstructible and never shared. The two MCP tools that wrote here are gone in
-- the same change, so no writer remains — left in place the table could only
-- accumulate rows nothing reads and nothing prunes.
--
-- Also drops the per-developer window preference the page's period selector
-- wrote. Overview reports a fixed recent window and has no selector, so the key
-- is inert; a stale one would otherwise be read by nothing and cleared by no one.
PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

DROP TABLE IF EXISTS digest_issues;

DELETE FROM local_settings
WHERE key = 'digest.period';

PRAGMA user_version = 8;

COMMIT;
