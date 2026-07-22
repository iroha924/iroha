-- Reverse-direction index for graph traversal.
--
-- `getNeighbors` (packages/storage/src/repositories/graph-search.ts) reads the
-- `relations` table by `from_entity_id` and/or `to_entity_id` and never
-- constrains `repository_id`. Both indexes migration 001 declared
-- (`idx_relations_from`, `idx_relations_to`) lead with `repository_id`, so only
-- the `from`-side seek is actually served — and by the UNIQUE autoindex on
-- `(from_entity_id, ...)`, not by `idx_relations_from`. Verified with
-- `EXPLAIN QUERY PLAN` that `direction: "incoming"` and `direction: "both"`
-- (every BFS hop: graphDistances/getSubgraph/getPath/buildRelations and the
-- dashboard graph reads) fell back to a full table scan.
--
-- Add a `(to_entity_id, relation_type)` index so `incoming` seeks and `both`
-- becomes a two-index MULTI-INDEX OR. Drop `idx_relations_to`
-- (`repository_id, to_entity_id, relation_type`): no read query constrains
-- `repository_id`, so it never served a read, and the only writer that needs a
-- `repository_id`-led index — the `repositories` ON DELETE CASCADE — is still
-- served by `idx_relations_from`, which is retained for exactly that cascade.
--
-- Index-only and forward-only: `sync --rebuild` reconstructs the same shape
-- from canonical data.

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

DROP INDEX idx_relations_to;
CREATE INDEX idx_relations_to_entity ON relations(to_entity_id, relation_type);

PRAGMA user_version = 3;

COMMIT;
