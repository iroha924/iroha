# iroha — Implementation Decision Log

> Status: Implementation Baseline v1  
> Updated: 2026-07-18

## Confirmed Open Questions

| ID | Decision | Status |
|---|---|---|
| OQ-001 | pnpm 11 workspaces + Turborepo; one lockfile; `workspace:*` | Accepted |
| OQ-002 | Claude Code >=2.1.198; Codex baseline/minimum 0.144.5; feature detection required | Accepted |
| OQ-003 | Tier 1: macOS 14 arm64/x64, Ubuntu 22.04 arm64/x64, Windows 11 x64, WSL2 | Accepted |
| OQ-004 | GitHub first; GitLab provider contract/fixtures only in v0.1 | Accepted |
| OQ-005 | Optional Voyage `voyage-4`, 1024 dimensions; FTS-only is zero-config default | Accepted |
| OQ-006 | Checkpoint input fixed by `schemas/checkpoint-v1.schema.json` | Accepted |
| OQ-007 | One human-approved canonical Session Summary per Agent Session; revisions through new approval | Accepted |
| OQ-008 | RRF-based hybrid ranking and 60-query evaluation gate | Accepted |
| OQ-009 | Canonical layout/body/frontmatter fixed by Canonical Data Contract and JSON Schema | Accepted |
| OQ-010 | GitHub Releases + scoped npm + dual repository marketplaces; bundled artifacts and attestations | Accepted |

## Additional decisions

| ID | Decision | Status |
|---|---|---|
| ID-011 | Published npm package is `@iroha-labs/iroha`; binary and plugins remain `iroha` | Accepted |
| ID-012 | ESM-only TypeScript packages and tsdown Node bundles | Accepted |
| ID-013 | No background daemon in v0.1; Hooks use bounded local DB operations | Accepted |
| ID-014 | No remote Embedding or Forge call inside Hooks | Accepted |
| ID-015 | Dashboard auth uses one-time URL fragment exchange and process-lifetime HttpOnly cookie | Accepted |
| ID-016 | No WebSocket/SSE in v0.1; local UI polling only | Accepted |
| ID-017 | React Router + TanStack Query + Tailwind + React Flow + Recharts | Accepted |
| ID-018 | GitHub Forge integration is P1 and may follow the offline vertical slice | Accepted |
| ID-019 | Public license selection is deferred until before first public release | Proposed; release-blocking only |
| ID-020 | Fixed a cross-contract inconsistency found during WP-01: `schemas/canonical-v1.schema.json` used frontmatter `type: review` (and inner object key `review`) for Review Learning documents, while `schemas/checkpoint-v1.schema.json` (`proposal.type`), `migrations/001_initial.sql` (`knowledge_items.knowledge_type`, `candidates.candidate_type`), and `implementation/mcp-contract.md` §7 all used `review_learning`. `entities.entity_type` already reserves `review` for `review_comments` rows (individual PR review comments) separately from `review_learning` for the knowledge item, so canonical frontmatter `type: review` would have collided with that. Canonical `type` is now `review_learning`, the `$defs` key is `reviewLearning`, and the type-specific frontmatter object is `review_learning: { category: ... }`. `rev_` ID prefix and `knowledge/reviews/` path are unchanged. Verified via Draft 2020-12 positive/negative/regression fixtures (`jsonschema` 4.25.1) against both `schemas/` and `docs/product/schemas/` copies. Confirmed with the product owner before applying (pre-implementation, no canonical data exists yet). | Accepted |
| ID-021 | Dropped macOS x64 (`macos-14-large`) from the Tier 1 CI matrix in `.github/workflows/ci.yml`. GitHub-hosted x64 macOS is only available via paid "-large" runners; the job failed to start on this account with "recent account payments have failed or your spending limit needs to be increased." macOS 14 arm64 (`macos-14`) remains covered. `compatibility.md` §6's Tier 1 definition (macOS 14 arm64/x64) is unchanged — this is a CI-workflow gap, not a support-scope change; re-add the matrix entry once billing is configured. Confirmed with the product owner (chose to drop x64 CI coverage for now rather than configure billing or self-host a runner). | Accepted |
| ID-022 | WP-02 (`@iroha/git`) implementation choices for details left open by prose: (1) the HMAC repository salt (32 random bytes, base64url-encoded) is stored as a `repositorySalt` field inside `<git rev-parse --git-path iroha>/local-config.json`, the local-only file design.md §6 already reserves for this purpose; reads/writes preserve unrelated fields so later work packages can add their own keys to the same file. Writes go through a temp-file-then-`rename` for atomicity; a concurrent-first-write race (two processes both seeing no salt and generating different values, last writer wins) is accepted as a rare, self-correcting condition rather than adding cross-process file locking, since no WP in `implementation-plan.md` scopes a locking primitive yet. (2) `sanitizeRemoteUrl` only strips the userinfo component of `scheme://` remote URLs (where a PAT/token can appear as the "username"); SCP-like `user@host:path` remotes are returned unchanged, since that syntax has no password field and treating a single-letter `host` before `:` as an SCP host would otherwise mis-parse Windows drive-letter local paths (`C:\...`, `C:/...`). (3) `toRepoRelativePath` returns POSIX-style (forward-slash) relative paths on every OS, matching Git's own path convention, since `database-schema.md`'s `files.path` column has no stated format. None of these affect canonical data, security boundaries, or the public MCP/CLI surface; recorded here per the decision rule rather than blocking on human input. | Accepted |

## Change protocol

Accepted decisions require:

1. a new ADR in `../design.md`;
2. affected machine schema/migration change;
3. backward-compatibility and migration statement;
4. updated acceptance tests;
5. explicit product-owner approval when canonical data, privacy, public API, or distribution changes.

Implementation convenience alone is not sufficient reason to replace an accepted decision.

