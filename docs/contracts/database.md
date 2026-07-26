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
- `tool_events`: allowlisted tool metadata and digests. A Guardrail denial also records the Rule
  that produced it in `denied_by_rule_id` (`migrations/005_tool_events_denied_rule.sql`), on the
  same insert the hook already performs — see §16 for why it may not be a second write.
- `checkpoints`: structured durable local summaries.

### Development artifacts

- `work_items`, `commits`, `pull_requests`, `review_comments`.
- `files`, `symbols`.

### Knowledge and approval

- `knowledge_items`: normalized candidate/approved knowledge. A Rule's `severity` (`info`/`warning`/`error`) is projected here from canonical frontmatter (`migrations/004_knowledge_items_severity.sql`); it is `NULL` for every non-rule type.
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
- `digest_issues`: 期間ごとのDigest prose（§16）。`migrations/006_digest_issues.sql`で追加。disposableなlocal viewであり、`sync --rebuild`後は空になる（proseは`/iroha:digest`で再生成する）。
- `idempotency_keys`: MCP/HTTP mutationの再試行結果をrepository・operation・key単位で保持する。
- `session_tokens`: SessionStart Hookが発行した256-bit session tokenの**salt-keyed HMAC-SHA-256 digestだけ**を保持する（平文tokenは保存しない、design.md §9 / contracts/mcp.md §5）。repository・Agent Session・Session Run・platformにbindし、`issued_at`/`last_used_at`/`expires_at`を持つ。MCP server（後続WP）が検証に読む。disposableなlocal運用状態であり、`sync --rebuild`はcanonicalのみ取り込むためrebuild後は空で再構築される。`migrations/002_session_tokens.sql`で追加。

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

## 15. Local event-data retention

The local index otherwise grows without bound: `agent_sessions`, `session_runs`, `turns`,
`tool_events`, and `event_log` are append-only. Retention (FR-111) bounds them.

- **Configured per developer, not shared.** The window lives in `local_settings` under
  `retention.local_events` as `{"days": <1-3650>}`, or `{"days": null}` to keep everything.
  It is deliberately *not* in `.iroha/config.yaml`: that file is Git-tracked, and a retention
  window there would impose one developer's disk and privacy preference on the whole team,
  while the data being bounded is local-only and rebuildable.
- **Off unless set.** An absent row and `{"days": null}` are the same state. An upgrade never
  starts deleting history on its own.
- **Runs during `iroha sync`**, after canonical and forge work, and is non-fatal — a pruning
  failure reports an outcome rather than failing a sync that already succeeded. There is no
  daemon and no scheduler. `iroha sync` reports what it deleted; `iroha doctor` reports the
  window, the current row counts, and how many sessions the next sync would prune.
- **Survives `sync --rebuild`.** The rebuild copies `local_settings` onto the fresh sibling
  (`carryLocalSettings`). Everything else in this index is reconstructible from `.iroha/`; a
  retention window is not, and losing it would silently reset pruning to "keep forever".

Pruning deletes an aged session through `entities` (the session row is the *child* of its
entity, so deleting `agent_sessions` directly would orphan the entity), which cascades to its
runs, turns, tool events, relations, and search documents. Its checkpoint entities are deleted
first, for the same reason.

**One write transaction per session**, not one for the whole sweep, and both the session's
eligibility *and* the retention policy itself are re-checked inside that transaction. Three
things matter here:

- Selection and deletion must be atomic, because hooks and MCP tools write concurrently — a
  session selected as eligible could otherwise gain a checkpoint, a pending candidate, or an
  imported canonical row before its delete ran, and be deleted anyway.
- The transaction must stay short, because §10 of `hooks.md` records that a hook's write waits
  on libSQL's 2500 ms `busy_timeout` while another process holds the write lock (7932 ms
  measured on a PreToolUse denial against a 0.5 s budget, after which the platform kills the
  hook and an applicable Guardrail deny is lost). A sweep-wide transaction would hold that lock
  across a whole backlog.

- Diagnostics rows are deleted in bounded batches for the same reason: one unbounded `DELETE`
  over an accumulated backlog has no lock bound at all.

The policy is re-read inside each delete transaction and compared against what the sweep was
authorized under, so a change committed on another connection cannot land between the check and
the delete. Once it stops matching, the sweep stops — including the diagnostics prune, which
would otherwise still run with the superseded cutoff. Whatever was already deleted was deleted
under the window in force at the time.

A session is eligible only when all of the following hold. Each exclusion exists because the
cascade would otherwise reach data this contract protects:

1. `last_seen_at` is before the cutoff, **and** no run, turn, tool event, or checkpoint under
   the session is newer than it. `last_seen_at` alone is not sufficient: it advances only on
   `SESSION_STARTED` (the dispatcher touches it in `handleSessionStart`, not in
   `resolveSessionId`), so a session running longer than the window carries a stale value, and
   trusting it would delete a live session's activity on the first sync after it closes;
2. it has no `session_runs` row with `status = 'active'`;
3. neither the session nor any of its checkpoints has a `canonical_documents` row —
   `canonical_documents.entity_id` cascades from `entities`, so pruning an approved session
   would delete the index row for Git-tracked team knowledge;
4. no other session names it in `parent_session_id` — that column is `ON DELETE SET NULL`, so
   pruning a parent would leave its children alive but permanently parentless; the child ages
   out first and the parent becomes eligible on a later sweep;
5. no `candidates` row with `status = 'pending'` reaches it by either route — directly through
   `source_session_id`, or through `source_checkpoint_id` pointing at one of its checkpoints
   (`propose_knowledge` accepts any existing checkpoint id, so a pending candidate can
   reference this session's checkpoint while its own `source_session_id` is null). Both columns
   are `ON DELETE SET NULL`, so pruning would not delete the candidate — it would silently
   strip the provenance of something awaiting review.

`event_log` is pruned by its own `occurred_at`, not with its session: `event_log.session_id`
is `ON DELETE SET NULL`, so those rows survive a session delete and would otherwise be the
one table retention never bounds.

**Not yet in scope**, both recorded rather than left implied:

- §7's "rejected candidates are retained locally for audit until retention cleanup" is not
  implemented here. `candidates` rows are never deleted by retention, only protected from
  provenance loss while pending. Pruning them needs its own eligibility rules (a rejection is
  an audit record).
- A retention change committed *during* a `sync --rebuild` can be lost: the rebuild snapshots
  `local_settings`, and a write that lands against the old database after that snapshot but
  before the swap goes to the file that then becomes the backup. Closing this needs the
  repository-level rebuild serialization §12 calls for, or a final merge before the swap —
  either is a change to the rebuild sequence, not to retention.

## 16. Digest period facts and composed prose

The Digest is the dashboard's front page: a per-period read model over facts already recorded,
plus optional narration. Nothing here is canonical and nothing is committed to Git.

- **The numbers are computed on request, never snapshotted.** `getDigestWindowFacts` runs six
  aggregates over one half-open window `[start, end)` and is called twice per page — for the
  period and for the one before it, which is where the prior-period comparison comes from. There
  is no snapshot table, so a trend resets on `sync --rebuild`; that is surfaced rather than
  hidden.
- **Periods are anchored calendar periods, not a rolling window.** A back issue needs a stable
  identity: "the week of 2026-07-20" must mean the same seven days whenever it is opened, or
  prose composed for it stops matching its numbers. Boundaries are calendar boundaries in the
  host's local timezone, converted to UTC instants for querying (§8 of `dashboard-api.md`:
  values UTC, display local). The window preference lives in `local_settings` under
  `digest.period` as `{"unit": "week" | "month"}`, and a malformed value falls back to the
  default rather than erroring — unlike `retention.local_events`, which governs deletion and so
  must not guess at intent.

### Two scopes

A fact belongs to the **team** scope if and only if it is identical for every teammate who
regenerates it from the same `.iroha/**` at the same Git HEAD; otherwise it is **local**.

- **Local** — denials (`tool_events`), checkpoint outcomes, session counts, denial clusters, and
  the count of pending `review_learning` candidates. These come from disposable index state that
  is per-clone by construction.
- **Team** — knowledge approved in the window, Guardrails added or changed, and promoted review
  learnings, all windowed by `knowledge_items.approved_at`. That timestamp travels in the
  canonical frontmatter and is restored by `syncCanonicalToDatabase`, so every clone's rebuild
  yields the same numbers for the same period. `status = 'approved'` is also required, so a
  tombstoned document whose `approved_at` is still set does not count.

A **team-wide raw denial tally is not collectable** in this design: denials live only in each
developer's local index and there is no shared telemetry store, which would require the
forbidden daemon or upload. "Where the agent stumbles across the team" is therefore answerable
only through the systemic lens — review recurrence and ruleset adequacy, both canonical.

The window preference being per-developer does not break the team scope's identical-for-all
property: that property is about the facts for a *given* window, not about everyone choosing the
same window.

### Denial attribution

A denied tool use is already recorded as `tool_events.phase = 'denied'` / `status = 'denied'`
with the offending path in `target_summary`, but the Rule that denied it was only returned to the
agent. `denied_by_rule_id` keeps it, so a denial count carries a lesson instead of being an
unattributed number.

It is written on the row `handleToolStarted` already inserts. That is a requirement, not a
convenience: §10 of `hooks.md` records a hook write waiting on libSQL's 2500 ms `busy_timeout`
for 7932 ms on a PreToolUse denial against a 0.5 s budget, after which the platform kills the
hook and the Guardrail deny is lost. This is also why the same denial is *not* recorded in
`event_log` — the hook path writes no diagnostics row at all.

The column deliberately has **no foreign key**. The value always comes from a row
`listApprovedRulesForRepository` just read from this same database, so a constraint could not be
violated; a Rule removed from canonical is tombstoned in place rather than deleted, so
`ON DELETE SET NULL` would never fire either. What a foreign key would add is a way for the
insert to fail and lose the whole audit row on the one path that must not lose it. The read model
resolves the title with a `LEFT JOIN`, so an id whose Rule is gone reads as an unattributed
denial rather than a dangling link.

### Composed prose (`digest_issues`)

One row per `(repository_id, period_unit, period_key)`, holding `prose_json` and `composed_at`.
Recomposing overwrites: the numbers are recomputed on every read, so an older narration of the
same period is stale by construction, not history worth versioning.

The row is local index state. A Digest's headline facts come from `tool_events`/`checkpoints`,
which §2 of `canonical.md` excludes from canonical and `sync --rebuild` drops — so prose
narrating them is not reconstructible from the committed files, and writing it into `.iroha/`
would put a non-reconstructable artifact into a store whose §1 charter is that everything there
is rebuildable. It also needs no approval gate: a Digest asserts no new team truth, so it sits
outside the candidate→approve→canonical boundary rather than bypassing it. No `dispatch`/`digest`
candidate or entity type was added for the same reason — it would have cost three CHECK-constraint
migrations, a canonical directory, a body template, a `$defs` entry, a Zod mirror, and contract
fixtures, for a newsletter.

Prose is stored **redacted**: every free-text field (`headline`, `standfirst`, and each section's
`heading` and `body` — `slot` is an enum and cannot carry a value) is secret-scanned before the
write. The input is aggregates and approved-canonical titles and should hold no secret, but this
is an at-rest store and a scan after the fact cannot strip what it never saw.

### The fact-ID seam

`computeDigest` issues a flat `facts` list: a stable id, iroha's value, and an English label. The
same list is used by the read path and by `save_digest_prose`, so validation cannot accept a
reference the page will not render.

The composing agent may reference a fact as `{{factId}}` and **has no field to write a number
into**; the renderer substitutes iroha's value. A fabricated figure is therefore not expressible.
Referencing an id the period did not issue is rejected with the offending ids named. An id that
later disappears — a Rule deleted after composition takes its `byRule` fact with it — renders as
an em dash, never a stale number.

What the seam does not prevent is prose that *contradicts* a correct number ("a quiet week" over
a denial spike). That is inherent to narration, so numbers render as authoritative and prose
carries an "unreviewed" label.

**No blended adherence score.** The majority of `.claude/rules/*.md` are advisory prose with no
machine-observable footprint, so there is no honest total. The Digest presents three separately
sourced facts — enforceable stumbles, ruleset adequacy, review recurrence — and states that
advisory rules are not measured.

### Anti-surveillance, structurally

`DigestData` has no field named or typed as actor, author, email, or session owner anywhere in
it, and `get_digest_data` hands that payload to the agent verbatim. Per-person narration is
therefore not something the composer could produce even if instructed to — the person data never
arrives. Any free text quoted into a fact comes from an already-approved canonical entity's title
or summary, never from a prompt, a transcript, or raw tool input.

**Not yet in scope:**

- The correlation set contains only `denial_cluster` (denied paths grouped by their leading two
  segments). Intersecting a cluster with a review recurrence on the same paths — the
  candidate-rule link — would need each pending `review_learning` candidate's payload parsed for
  `scope.paths`; it is left out until there is data showing the intersection produces anything.
- There is no `hasOlder`. Any calendar period exists, so navigating back always resolves; a period
  before the data simply renders as zeros, which is honest but unbounded. Bounding it needs the
  earliest-activity timestamp, a query the page does not otherwise want.
