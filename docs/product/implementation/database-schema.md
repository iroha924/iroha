# iroha — Database Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Executable migration: `../migrations/001_initial.sql`

## 1. Role of the database

The libSQL database is the local operational store and search index. It stores local session activity, candidates, derived graph/search data, external provider caches, and embeddings. It is not the source of truth for approved shared knowledge.

Deletion of the DB may lose unapproved/local-only operational data. It must not lose approved canonical data.

## 2. Location and worktree behavior

Resolve locations with Git commands; never derive `.git` paths by string concatenation.

```bash
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git rev-parse --git-dir
git rev-parse --git-path iroha
```

Database path:

```text
<result of git rev-parse --git-path iroha>/index.db
```

Sibling local state:

```text
<git-path iroha>/
├── index.db
├── index.db-wal
├── index.db-shm
├── local-config.json
├── locks/
├── dirty/
├── logs/
└── hook-outputs/
```

Each linked worktree receives operational state through its resolved Git path. `.iroha/` in the worktree remains the shared canonical source.

## 3. Connection initialization

Every new connection executes:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 2500;
PRAGMA temp_store = MEMORY;
```

Rules:

- one connection pool abstraction per process;
- maximum one concurrent writer transaction per repository process;
- retry `SQLITE_BUSY` with bounded jitter for at most 2 seconds;
- Hook handlers do not run migrations unless explicitly invoked by `init`, `sync`, or `doctor --repair`;
- a schema mismatch makes writes unavailable but permits read-only diagnostics;
- application timestamps are UTC RFC 3339 strings with milliseconds.

## 4. Migration policy

- Raw forward-only SQL files named `<four-digit>_<name>.sql`.
- `schema_migrations` and `PRAGMA user_version` must agree.
- A migration runs inside `BEGIN IMMEDIATE` when the engine permits it.
- Migration checksum is recorded; an applied file whose checksum changes is a hard error.
- Migration runner records version, name, checksum, and application time in `schema_migrations` only after the SQL file commits successfully.
- The DB is backed up before an in-place migration unless it is being rebuilt from scratch.
- Migration tests run against empty DB, previous fixture DB, and rebuild output.
- No down migrations. Recovery is restore or full rebuild.

## 5. Table groups

### Repository and identity

- `repositories`: stable shared repository identity plus sanitized remote metadata.
- `actors`: local/Git/Forge identities; raw email is not required.
- `entities`: common graph/search identity for every domain object.
- `canonical_documents`: parsed approved document and canonical path.

### Session operations

- `agent_sessions`: local platform thread mapping.
- `session_runs`: startup/resume execution interval.
- `turns`: user-prompt-driven turn without raw prompt content.
- `tool_events`: allowlisted tool metadata and digests.
- `checkpoints`: structured durable local summaries.

### Development artifacts

- `work_items`, `commits`, `pull_requests`, `review_comments`.
- `files`, `symbols`.

### Knowledge and approval

- `knowledge_items`: normalized candidate/approved knowledge.
- `candidates`: mutable review queue item.
- `approvals`: append-only review audit.

### Graph and retrieval

- `relations`: typed directed edges.
- `search_documents`: normalized retrieval text.
- `search_fts_unicode`, `search_fts_trigram`: FTS5 external-content indexes.
- `embeddings_1024`: v1 Voyage vector table.
- `embedding_jobs`: asynchronous/retry state.

### Operations

- `sync_cursors`, `dirty_markers`, `local_settings`, `event_log`.
- `idempotency_keys`: MCP/HTTP mutationの再試行結果をrepository・operation・key単位で保持する。

## 6. Authority values

`entities.authority` is an integer from 0 to 100.

| Source/state | Value |
|---|---:|
| approved canonical | 100 |
| verified Git/Forge artifact | 80 |
| local structured Checkpoint | 60 |
| pending candidate | 30 |
| inferred relation-only entity | 20 |
| rejected | 0 and excluded |

Authority is stored for reproducibility but recalculated during sync when canonical state changes.

## 7. State transitions

### Candidate

```text
pending -> approved
pending -> rejected
pending -> superseded
approved -> superseded
```

Rejected candidates are retained locally for audit until retention cleanup. They do not become `canonical_documents`.

### Session Run

```text
active -> completed
active -> interrupted
active -> abandoned
interrupted -> abandoned
```

Resume creates a new Run; it does not reactivate the previous Run.

### Turn

```text
active -> completed
active -> failed
active -> interrupted
```

## 8. Search index design

`search_documents` owns the normalized text. FTS tables are external-content indexes maintained by triggers.

Unicode index:

- tokenizer: `unicode61`;
- remove diacritics mode 2;
- hyphen and underscore are token characters;
- used for English, words, and code identifiers.

Trigram index:

- case-insensitive trigram;
- used for Japanese/CJK and substring matching;
- queries shorter than three Unicode characters fall back to escaped `LIKE` over a bounded candidate set.

Vector index:

- `F32_BLOB(1024)`;
- `libsql_vector_idx(embedding, 'metric=cosine')`;
- queried through `vector_top_k`;
- one embedding per search document for the configured provider/model/content hash;
- v1 does not mix models or dimensions inside the same vector index.

## 9. Hybrid retrieval algorithm

Candidate generation:

1. top 30 Unicode FTS rows;
2. top 30 trigram FTS rows;
3. top 30 vector rows when provider is configured and the query embedding succeeds;
4. directly scoped entities for active Issue, file, symbol, and approved Guardrail.

Reciprocal Rank Fusion:

```text
rrf = 1.0/(60+unicodeRank)
    + 0.9/(60+trigramRank)
    + 1.1/(60+vectorRank)
```

Missing ranks contribute zero.

Multipliers:

| Signal | Multiplier |
|---|---:|
| authority 100 | 1.25 |
| authority 80–99 | 1.10 |
| same symbol | 1.35 |
| same file/path scope | 1.25 |
| same active Issue/PR | 1.30 |
| graph distance 1 | 1.15 |
| graph distance 2 | 1.08 |
| graph distance 3 | 1.03 |

Recency is a tie-breaker capped at a 5% contribution with a 180-day half-life. It must not outrank directly applicable approved rules because they are old.

Pending candidates and rejected items are excluded from agent retrieval. Dashboard review search may include pending candidates with an explicit filter.

## 10. Context pack limits

- Hook context pack: maximum 8,000 characters and 12 items.
- MCP search response default: 10 results; maximum 50.
- Each context item includes ID, type, title, 500-character summary maximum, relevance explanation, authority, and provenance.
- Full bodies are fetched only through an explicit get/search tool.
- Never include raw source text merely because it contributed to a score.

## 11. Relation traversal

Default graph exploration is breadth-first up to depth 3, maximum 200 edges, and excludes `DUPLICATES` cycles already visited.

The repository layer provides:

```ts
getNeighbors(entityId, relationTypes?, direction?, limit?)
getPath(fromId, toId, maxDepth = 4)
getSubgraph(rootIds, maxDepth = 2, maxEdges = 200)
```

Recursive CTE queries must track visited IDs in the path and enforce both depth and edge limits.

## 12. Rebuild algorithm

`iroha sync --rebuild`:

1. acquire the repository rebuild lock;
2. create a sibling DB with a random temporary name;
3. apply all migrations;
4. import `.iroha/config.yaml`, taxonomy, and every canonical document;
5. import local Git commit/ref metadata;
6. validate every canonical reference and collect non-fatal unresolved external refs;
7. build search documents and FTS indexes;
8. reuse compatible embeddings from the old DB by content hash when available;
9. queue missing embeddings;
10. run integrity checks;
11. close connections and atomically replace the DB;
12. retain the old DB as a timestamped backup until the next successful start.

Canonical parse or schema errors fail the rebuild without replacing the current DB.

## 13. Integrity checks

Release and doctor repair checks:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

Application checks:

- every subtype row has a matching `entities` row;
- every canonical document path exists and ID matches the filename;
- every approved knowledge item has a canonical document;
- every active Guardrail has a valid guard spec;
- FTS row counts match searchable `search_documents`;
- embeddings have dimension/model/content-hash agreement;
- no canonical ID is represented by multiple paths;
- no active relation points to a rejected entity.

## 14. Search evaluation gate

Create a checked-in evaluation fixture with at least 60 queries:

- 20 Japanese natural-language queries;
- 15 English natural-language queries;
- 15 code/path/symbol queries;
- 10 relationship/provenance queries.

Each query declares relevant entity IDs and optional graded relevance.

Initial release thresholds:

- Recall@10 >= 0.85;
- nDCG@10 >= 0.70;
- MRR@10 >= 0.70;
- approved applicable Rule Recall@10 = 1.00 for the Guardrail fixture set.

Ranking changes require before/after metrics. Do not tune solely on anecdotal examples.
