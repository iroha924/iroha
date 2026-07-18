# iroha — Canonical Data Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Machine schema: `../schemas/canonical-v1.schema.json`

## 1. Purpose

This contract defines the Git-tracked, human-approved source of truth under `.iroha/`. The local database may be deleted at any time. Every approved item that must survive or be shared must be reconstructible from these files and Git metadata.

## 2. Canonical boundary

Canonical data contains:

- approved Session Summaries;
- approved Decisions, Rules, Concepts, Insights, Incidents, Patterns, and Review Learnings;
- labels and shared non-secret configuration;
- provenance and relations required to reconstruct the Engineering Memory Graph.

Canonical data does not contain:

- pending/rejected candidates;
- raw prompts, transcripts, assistant messages, or reasoning traces;
- complete tool inputs or outputs;
- embedding vectors or provider cursors;
- local paths, process IDs, session tokens, API keys, or credentials;
- local dashboard preferences.

## 3. Directory layout

```text
.iroha/
├── .gitignore
├── config.yaml
├── schema-version
├── sessions/
│   └── YYYY/MM/ses_<ULID>.md
├── decisions/
│   └── dec_<ULID>.md
├── rules/
│   └── rul_<ULID>.md
├── knowledge/
│   ├── concepts/con_<ULID>.md
│   ├── insights/ins_<ULID>.md
│   ├── incidents/inc_<ULID>.md
│   ├── patterns/pat_<ULID>.md
│   └── reviews/rev_<ULID>.md
└── taxonomy/
    └── labels.yaml
```

`schema-version` contains exactly:

```text
1
```

`.iroha/.gitignore` contains:

```gitignore
.*.tmp
```

## 4. ID and file naming

IDs are uppercase Crockford Base32 ULIDs with a type prefix.

| Type | Prefix | Location |
|---|---|---|
| Session Summary | `ses_` | `sessions/YYYY/MM/` based on `created_at` UTC |
| Decision | `dec_` | `decisions/` |
| Rule | `rul_` | `rules/` |
| Concept | `con_` | `knowledge/concepts/` |
| Insight | `ins_` | `knowledge/insights/` |
| Incident | `inc_` | `knowledge/incidents/` |
| Pattern | `pat_` | `knowledge/patterns/` |
| Review Learning | `rev_` | `knowledge/reviews/` |

The file basename must equal `<id>.md`. An entity ID never changes. Title changes do not rename files.

## 5. Serialized document format

Every document is UTF-8 without BOM, uses LF line endings, and consists of YAML frontmatter followed by Markdown.

```markdown
---
schema_version: 1
id: dec_01K...
type: decision
title: Use libSQL as the local index
status: approved
revision: 1
created_at: 2026-07-18T00:00:00.000Z
updated_at: 2026-07-18T00:00:00.000Z
created_by:
  provider: git
  display_name: Example Developer
approved_by:
  provider: git
  display_name: Example Reviewer
approved_at: 2026-07-18T00:00:00.000Z
labels:
  - architecture
scope:
  repository: repo_01K...
  paths: []
  symbols: []
sources:
  - type: session
    ref: ses_01K...
relations: []
decision:
  kind: architecture
---

# Use libSQL as the local index

## Context

...
```

The machine schema validates a parsed envelope:

```ts
interface CanonicalEnvelope {
  frontmatter: CanonicalFrontmatter;
  body: string;
}
```

The Markdown delimiters are a serialization concern and are not included in the JSON Schema instance.

## 6. Common frontmatter contract

Required for every document:

- `schema_version`: integer `1`;
- `id`: type-correct typed ULID;
- `type`: canonical type;
- `title`: 1–160 characters;
- `status`: `approved`, `superseded`, or `archived`;
- `revision`: positive integer;
- `created_at`, `updated_at`, `approved_at`: UTC RFC 3339 with milliseconds;
- `created_by`, `approved_by`: privacy-safe actor references;
- `labels`: normalized label slugs;
- `scope`: repository/path/symbol/language applicability;
- `sources`: at least one provenance reference;
- `relations`: zero or more typed graph edges;
- one type-specific object named after the type contract.

Unknown frontmatter fields are rejected. This prevents misspelled fields from silently disappearing during rebuild.

## 7. Body templates

The first H1 must equal `title`. Required H2 sections are validated by the canonical parser after JSON Schema validation.

### Session Summary

```markdown
# <title>

## Objective
## Outcome
## Changes
## Validation
## Decisions
## Unresolved
## References
```

`Changes`, `Validation`, `Decisions`, `Unresolved`, and `References` may contain `- None`, but the headings must exist.

### Decision

```markdown
# <title>

## Context
## Decision
## Rationale
## Consequences
## Alternatives considered
```

### Rule

```markdown
# <title>

## Rule
## Scope
## Rationale
## Examples
## Exceptions
```

For `enforcement: guardrail`, the frontmatter must include a machine-evaluable `guard` object approved with the text.

### Concept

```markdown
# <title>

## Definition
## Domain context
## Examples
## Related concepts
```

### Insight

```markdown
# <title>

## Observation
## Evidence
## Implication
## Recommended action
```

### Incident

```markdown
# <title>

## Summary
## Impact
## Timeline
## Root cause
## Resolution
## Prevention
```

### Pattern

```markdown
# <title>

## Problem
## Pattern
## When to use
## When not to use
## Examples
```

### Review Learning

```markdown
# <title>

## Review finding
## Why it matters
## Resolution
## Generalized learning
```

## 8. Session Summary publication unit

- One canonical Session Summary represents one Agent Session.
- Resumed executions are appended as additional runs in the same draft summary.
- A summary may link multiple Issues/PRs, but a run should declare its primary work item when known.
- The first approval creates revision 1.
- New runs or corrections create a new candidate based on the approved document.
- A subsequent approval atomically replaces the same file and increments `revision`.
- Git history is the durable revision history; the local approval table is the operational audit log.
- A Session Summary is never auto-published in v0.1.

## 9. Shared config

`.iroha/config.yaml` schema:

```yaml
schema_version: 1
repository_id: repo_01K...
default_language: ja
canonical:
  require_human_approval: true
  session_auto_publish: false
search:
  embedding:
    enabled: false
    provider: voyage
    model: voyage-4
    dimension: 1024
    api_key_env: VOYAGE_API_KEY
forge:
  provider: github
  enabled: false
privacy:
  canonical_prompt_content: false
  canonical_transcript_content: false
```

Rules:

- Secret values are forbidden; only environment-variable names may appear.
- `repository_id` is generated once and committed.
- Local overrides are stored under the Git internal iroha directory, not in this file.
- Unknown configuration keys are rejected for schema v1.

## 10. Labels

`taxonomy/labels.yaml` contains a sorted list:

```yaml
schema_version: 1
labels:
  - id: architecture
    title: Architecture
    description: Architecture decisions and constraints
    color: "#5B5BD6"
```

Label IDs match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Deleting a label that remains referenced is an error. Renames require creating the new label and migrating documents in one commit.

## 11. Deterministic serialization

The writer must:

1. validate the parsed candidate with Zod;
2. apply redaction and secret scanning;
3. sort frontmatter fields in the contract order;
4. sort labels lexicographically;
5. sort sources by `(type, ref, path, line_start)`;
6. sort relations by `(type, target)`;
7. serialize timestamps as UTC with milliseconds;
8. trim trailing spaces and ensure exactly one final newline;
9. parse the serialized output again and assert semantic equality;
10. validate against `canonical-v1.schema.json`.

Hashing uses SHA-256 over the complete normalized serialized file. The hash is stored in the local DB, not in the document itself.

## 12. Approval transaction

Approval order is fixed:

1. acquire a per-repository canonical write lock;
2. reload the candidate and verify its optimistic concurrency token;
3. run Zod, body-template, secret, and path validation;
4. serialize to a sibling temporary file named `.<id>.<random>.tmp`;
5. flush and close the file;
6. atomically rename it to the final path;
7. fsync the parent directory where supported;
8. commit the local DB entity/relation/search update in one transaction;
9. append the approval audit record;
10. release the lock.

If step 8 or 9 fails after the rename, create a dirty marker under the Git-internal iroha state and return a recoverable error. The canonical file remains authoritative and the next sync repairs the DB.

## 13. Conflict and deletion policy

- Git content conflicts are never semantically auto-merged.
- The dashboard shows both conflict sides and source commits when available.
- Meaning conflicts use `contradicts`, `duplicates`, or `supersedes` relations.
- Approved knowledge is not hard-deleted by normal UI actions.
- Deprecation sets `status: archived`; replacement sets the old item to `superseded` and adds `SUPERSEDES` from the new item.
- A Git deletion is imported as a local tombstone and requires explicit reconciliation if another document still references the ID.

## 14. Importing existing documentation

`iroha init --scan` creates local candidates from `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**/*.md`, and user-selected docs. It does not copy them into `.iroha/` automatically.

Each imported candidate must retain:

- source repository-relative path;
- source content hash;
- line range when stable;
- import timestamp;
- detected scope;
- a link back to the original document.

Approving an imported candidate creates an iroha knowledge document; it does not delete or edit the source document.

## 15. Schema evolution

- `schema-version` is the canonical format major version.
- Readers reject versions greater than supported.
- Writers only emit the current version.
- Canonical migrations operate on a clean Git worktree or require explicit `--allow-dirty`.
- Migrations create a branch-friendly, reviewable diff and never auto-commit.
- Every migration provides dry-run output, backup guidance, and a round-trip test fixture.

