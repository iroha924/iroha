-- Composed Digest prose, one row per period.
--
-- Local index state, not canonical, and deliberately so. A Digest's headline
-- facts come from `tool_events`/`checkpoints`, which `sync --rebuild` drops and
-- which canonical.md §2 keeps out of canonical (it excludes complete tool inputs
-- and outputs) — so prose narrating them could not be reconstructed from the
-- committed files, and putting it in `.iroha/` would
-- smuggle a non-reconstructable artifact into a store whose §1 charter is that
-- everything there is rebuildable. It also needs no approval gate: a Digest
-- asserts no new team truth, it narrates already-recorded activity and
-- already-approved knowledge, so it sits outside the candidate→approve boundary
-- rather than bypassing it.
--
-- Losing these rows on a rebuild is therefore correct, not a gap: the numbers
-- are recomputed on every read and a period with no prose renders from templated
-- copy. Regenerate an issue by running the `/iroha:digest` skill again.
--
-- `period_end` is stored even though `(period_unit, period_key)` already
-- identifies the period, because retention prunes on it. Pruning by
-- `composed_at` does not work: prose written today for a ten-week-old back issue
-- is recent, so it survives a 30-day window while the sessions it narrates are
-- deleted — leaving an unreviewed claim rendering against zeroed facts. The
-- period's own end is the timestamp that has to age out. It is stable to store
-- because period boundaries are UTC, so the value does not depend on which host
-- wrote it.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE digest_issues (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  period_unit TEXT NOT NULL CHECK (period_unit IN ('week', 'month')),
  period_key TEXT NOT NULL,
  period_end TEXT NOT NULL,
  prose_json TEXT NOT NULL CHECK (json_valid(prose_json)),
  composed_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, period_unit, period_key)
) STRICT;

PRAGMA user_version = 6;

COMMIT;
