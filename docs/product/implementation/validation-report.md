# iroha — Specification Validation Report

> Status: Passed  
> Validated: 2026-07-18

## Scope

この記録は、実装開始前の仕様bundle自体に対して行った検証を示す。製品コードのtest結果ではない。

## Machine contracts

| Check | Result |
|---|---|
| 3 JSON files are syntactically valid | Passed |
| JSON Schema 2020-12 compilation with AJV 8 strict mode + formats | Passed |
| All 8 canonical document type positive fixtures | Passed |
| Canonical Guardrail missing `guard` negative fixture | Rejected as required |
| Checkpoint positive fixture | Passed |
| Checkpoint Guardrail proposal missing `guard` negative fixture | Rejected as required |
| Normalized `TOOL_STARTED` positive fixture | Passed |
| All 16 normalized event kind positive fixtures | Passed |
| Event `kind` / `payload` mismatch negative fixture | Rejected as required |

Validated schemas:

- `schemas/canonical-v1.schema.json`
- `schemas/checkpoint-v1.schema.json`
- `schemas/normalized-event-v1.schema.json`

## libSQL migration

`migrations/001_initial.sql` was applied to an empty local database with `@libsql/client` 0.17.4.

| Check | Result |
|---|---|
| Migration applies on empty DB | Passed |
| `PRAGMA user_version` | `1` |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 violations |
| `embeddings_1024` vector table/index creation | Passed |
| `idempotency_keys` creation | Passed |
| Unicode FTS insert/update/delete | Passed |
| Japanese trigram FTS insert/update/delete | Passed |

The migration runner still must add its own release tests for checksum recording, previous-version migration, backup, writer contention, and `vector_top_k`, as required by WP-03.

## Documentation consistency gates

The final bundle check must keep these conditions true:

- no obsolete product alias remains;
- no unresolved OQ-001 through OQ-010 remains;
- all relative Markdown links resolve;
- all machine files parse;
- root handoff instructions reference every implementation contract;
- archive contains no temporary DB, credential, API key, or absolute local path.
