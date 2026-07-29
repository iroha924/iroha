-- Removes the review candidates the old `iroha init --scan` created from
-- `CLAUDE.md`/`AGENTS.md`/`.claude/rules/**/*.md`.
--
-- contracts/canonical.md §14 / ADR-017 moved those documents out of the
-- candidate→approve path entirely: they are now `source_kind = 'import'`
-- entities, because a committed instruction document has no approval decision
-- left for a human to make. The rows this deletes belong to a flow that no
-- longer exists, and they cannot reach an end state on their own — no code path
-- approves or rejects them any more, so left alone they would sit in the review
-- queue forever.
--
-- They are also actively broken. Their `payload_json` was written in a shape no
-- reader understands (a `detected_scope` key where every consumer expects
-- `scope`), so opening one in the dashboard threw rather than rendering. Nothing
-- is lost by deleting them: every one is re-derivable from the source file it
-- was read out of, which is Git-tracked, and `iroha sync` re-derives it.
--
-- `detected_scope` is the discriminator because only that writer ever produced
-- it — a proposal from `propose_knowledge`/`create_checkpoint` is Zod-validated
-- against `proposalSchema`, a `strictObject` that rejects the key outright.
-- Scoped to `pending` so a candidate a human already acted on keeps its
-- decision record.
PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

DELETE FROM candidates
WHERE status = 'pending'
  AND json_extract(payload_json, '$.detected_scope') IS NOT NULL;

-- The same import used `local_settings` rows to remember each document's content
-- hash. The hash now lives on the entity (`entities.content_hash`), so these
-- keys are inert; dropping them keeps a re-import from consulting a guard that
-- nothing writes.
DELETE FROM local_settings
WHERE key LIKE 'docs_scan:%';

PRAGMA user_version = 7;

COMMIT;
