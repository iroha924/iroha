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

## Change protocol

Accepted decisions require:

1. a new ADR in `../design.md`;
2. affected machine schema/migration change;
3. backward-compatibility and migration statement;
4. updated acceptance tests;
5. explicit product-owner approval when canonical data, privacy, public API, or distribution changes.

Implementation convenience alone is not sufficient reason to replace an accepted decision.

