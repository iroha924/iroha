# iroha — Claude Code Implementation Plan

> Status: Ready for Implementation  
> Updated: 2026-07-18  
> Execution rule: complete work packages in order unless dependencies explicitly permit parallel work.

## 1. Objective

Build iroha from an empty repository to the offline-first Vertical Slice, then package both plugins. This plan deliberately separates pure contracts, persistence, platform adapters, and UI so each boundary can be tested before integration.

Claude Code may begin implementation after reading `../CLAUDE.md` and every referenced specification. It must not redesign accepted decisions.

## 2. Target repository tree

```text
iroha/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .changeset/config.json
├── .github/workflows/
├── .agents/skills/
├── skills/
├── hooks/
│   ├── claude.json
│   └── codex.json
├── apps/dashboard/
├── packages/
│   ├── domain/
│   ├── config/
│   ├── canonical/
│   ├── storage/
│   ├── search/
│   ├── git/
│   ├── forge/
│   ├── forge-github/
│   ├── platform/
│   ├── adapter-claude/
│   ├── adapter-codex/
│   ├── core/
│   ├── mcp/
│   ├── api/
│   ├── cli/
│   └── plugin/
├── migrations/
├── schemas/
├── tests/
│   ├── contracts/
│   ├── fixtures/
│   ├── integration/
│   ├── e2e/
│   └── package/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── turbo.json
└── tsconfig.base.json
```

The current documentation bundle is copied to `docs/product/`; root `CLAUDE.md` and `AGENTS.md` remain at repository root.

## 3. Work packages

### WP-00 — Repository foundation

Deliverables:

- initialize Git and pnpm/Turbo workspace;
- root configs, strict TS config, lint/format/test/build scripts;
- package skeletons with dependency boundaries;
- Changesets fixed group;
- CI matrix skeleton for Tier 1 OS;
- copy schemas/migration/docs without modifying contracts.

Acceptance:

```bash
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All commands succeed from a clean checkout. No package cycle.

### WP-01 — Domain and machine contracts

Deliverables:

- typed ULID factories and runtime validators;
- Entity/Session/Run/Turn/Checkpoint/Candidate/Relation state types;
- canonical, checkpoint, normalized-event Zod schemas;
- JSON Schema equivalence tests;
- deterministic clock/random interfaces;
- error code/result types.

Acceptance:

- every prefix rejects the wrong entity type;
- illegal state transitions fail;
- JSON Schema fixtures and Zod fixtures agree;
- unknown canonical/MCP fields reject;
- raw platform adapters tolerate future unknown fields.

### WP-02 — Git identity and local paths

Deliverables:

- Git command runner using argument arrays;
- root/common-dir/git-dir/git-path resolution;
- sanitized remote identity and shared `repository_id` support;
- worktree and symlink-safe path utilities;
- HMAC repository salt stored locally.

Acceptance:

- normal repo, linked worktree, subdirectory launch, spaces, Japanese paths;
- no credential-bearing remote URL stored;
- path traversal/symlink escape rejected;
- Windows path fixture passes.

### WP-03 — Storage and migration v1

Deliverables:

- libSQL connection initialization;
- migration runner with checksum/audit;
- repositories for all v1 tables;
- transaction and busy retry helpers;
- DB integrity/rebuild primitives;
- FTS and vector capability probe.

Acceptance:

- empty migration;
- migration checksum mismatch fails;
- CRUD/state constraints;
- concurrent writer busy behavior;
- foreign-key/integrity checks;
- FTS Unicode/trigram smoke search;
- 1024 vector insert/top-k when supported.

### WP-04 — Canonical parser and publisher

Deliverables:

- YAML frontmatter + Markdown parser;
- deterministic serializer and body-template validator;
- shared config/taxonomy parsers;
- secret scanner/redaction report;
- approval write transaction;
- canonical import and changed-file sync;
- conflict/tombstone diagnostics.

Acceptance:

- all canonical type round trips;
- filename/ID/path validation;
- same semantic input produces byte-identical output;
- write-first/DB-failure dirty marker and repair;
- no raw prompt/secret fixture reaches canonical output;
- malformed canonical file fails rebuild safely.

### WP-05 — CLI init, sync, doctor

Deliverables:

- `iroha init`, `sync`, `sync --rebuild`, `doctor`, `search`, `dashboard` shells;
- non-destructive/idempotent init;
- docs scan into local Candidates;
- structured `--json` output;
- actionable platform/trust/provider diagnostics.

Acceptance:

- Scenarios A, C, E from `requirements.md`;
- init rerun diff is empty;
- FTS-only search works offline;
- doctor redacts environment values;
- unsupported schema blocks writes.

### WP-06 — Platform Hook adapters

Deliverables:

- shared Hook executable;
- Claude and Codex raw validators/adapters;
- normalized events and output renderers;
- SessionStart, UserPromptSubmit, Pre/PostToolUse, Compact, Stop;
- Claude SessionEnd enhancement;
- hook fixture corpus and timeout tests.

Acceptance:

- every P0 fixture in `hooks-contract.md`;
- same normalized semantics across platforms;
- future unknown raw fields tolerated;
- context output bounded;
- Guardrail deny format valid on both platforms;
- one-time Stop continuation;
- no transcript parser import exists in core package.

### WP-07 — MCP and Checkpoint loop

Deliverables:

- stdio MCP server and instructions;
- all tools in `mcp-contract.md`;
- session token issuance/validation;
- Checkpoint/Candidate transaction and idempotency;
- no human approval tool.

Acceptance:

- MCP initialize/list/call contract tests;
- checkpoint retry returns identical IDs;
- wrong repo/expired token rejected;
- candidate remains local pending;
- `tools/list` snapshot contains no approve/publish/delete operation;
- stdout contains protocol frames only.

### WP-08 — Search and context retrieval

Deliverables:

- Unicode/trigram retrieval;
- Voyage adapter and 1024 vector job queue;
- RRF ranking and authority/scope/graph boosts;
- context pack builder;
- 60-query evaluation fixture and metrics runner.

Acceptance:

- FTS-only Japanese/English/code queries;
- Embedding network failure degrades cleanly;
- pending candidates excluded;
- output/provenance limits;
- evaluation thresholds recorded and met before release.

### WP-09 — Local API and dashboard

Deliverables:

- Hono auth exchange/security headers/API;
- React routes and generated typed API client;
- Overview, Sessions, Review Queue, Knowledge, Search, Graph, Settings/Doctor;
- candidate edit/conflict/approve/reject;
- accessible graph list alternative;
- Japanese/English message catalogs.

Acceptance:

- API/UI/E2E tests in `dashboard-api.md`;
- approval creates canonical file;
- secret warning blocks approval;
- no raw transcript endpoint/view;
- no individual ranking;
- direct-route SPA reload works from packaged server.

### WP-10 — Vertical Slice and recovery

Deliverables:

- full fixture scenario from `vertical-slice.md`;
- interruption/recovery;
- teammate pull/rebuild simulation;
- Guardrail + CI fixture;
- 10k-entity performance fixture.

Acceptance:

- all Vertical Slice assertions;
- privacy scan across artifacts;
- Tier 1 CI;
- rebuild returns the same approved entity graph.

### WP-11 — Plugin packaging and release candidate

Deliverables:

- separate Claude/Codex manifests generated from shared metadata;
- shared Skills: init, sync, search, checkpoint, dashboard, doctor;
- bundled Hook/MCP/CLI/dashboard artifacts;
- repository marketplaces;
- package/archive smoke tests;
- checksums, SBOM, attestations workflow;
- install/update/uninstall docs.

Acceptance:

- platform manifest validators pass;
- archive works without install scripts or source workspace;
- Codex trust onboarding verified;
- Claude `/iroha:*`, Codex `$iroha:*`, and CLI fallbacks documented;
- version consistency and clean-checkout release build.

### WP-12 — GitHub Forge provider (P1)

Deliverables:

- GitHub provider using existing user authentication where possible;
- incremental Issue/PR/Review sync and cursors;
- rate-limit/error behavior;
- Work Graph enrichment and review-learning candidates.

Acceptance:

- provider fixtures, pagination, edited/deleted comments, rate limit;
- network failure does not fail canonical/Git sync;
- token never enters DB/log/canonical;
- review provenance links to stable URL/external ID.

## 4. Commit and review boundaries

- Prefer one work package per PR.
- WP-01 through WP-04 should not be combined; they establish reviewable boundaries.
- Machine schema and its implementation/tests are changed in the same PR.
- Generated files identify their generator and are reproducible.
- No migration file is edited after release; add the next migration.

## 5. Test commands

Root scripts must expose:

```json
{
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:contracts": "turbo run test:contracts",
    "test:integration": "turbo run test:integration",
    "test:e2e": "turbo run test:e2e",
    "test:package": "turbo run test:package"
  }
}
```

Tests do not require real user accounts or paid API keys. Live provider tests are opt-in and never release-blocking without recorded fixtures.

## 6. Implementation checkpoints

At the end of each WP, Claude Code must provide:

- files changed;
- behavior completed;
- commands executed and results;
- requirements/acceptance IDs satisfied;
- schema/API changes;
- known risks and next WP.

Do not claim the entire product is complete when only a package or mocked vertical segment is complete.

## 7. Human decision gates

Implementation should proceed autonomously except for:

- changing canonical v1 after code or user data exists;
- sending new categories of data to an external service;
- adding hosted/cloud state;
- exposing approval to an agent/API without human UI;
- choosing public license before first release;
- publishing npm/release/marketplace artifacts;
- broadening telemetry or individual analytics.

These gates do not block local implementation before release.

## 8. Release definition of done

v0.1 is releasable only when:

- all P0 requirements pass;
- WP-00 through WP-11 pass on Tier 1 CI;
- JSON schemas validate positive/negative fixtures;
- migration and rebuild tests pass;
- Claude/Codex Hook and MCP smoke tests pass;
- privacy artifact scan is clean;
- package contains no install lifecycle dependency;
- docs match the packaged version;
- public license is selected;
- release remains a human-authorized action.

