# iroha — Compatibility Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Applies to: iroha `0.1.x`

## 1. Purpose

This document fixes the runtime, package, operating-system, plugin-surface, and compatibility policy for the first implementation. An implementation is not allowed to silently choose different foundations. A change requires an ADR update in `../design.md` and a migration/compatibility assessment.

## 2. Required runtime and toolchain

| Component | Baseline | Version policy |
|---|---:|---|
| Node.js | 24 LTS | `>=24.0.0 <25` |
| pnpm | 11.14.0 | exact via `packageManager` and Corepack |
| Turborepo | 2.10.5 | exact in root devDependencies |
| TypeScript | 7.0.2 | exact through pnpm catalog |
| React | 19.2.7 | exact through pnpm catalog |
| Vite | 8.1.5 | exact through pnpm catalog |
| Hono | 4.12.30 | exact through pnpm catalog |
| Zod | 4.4.3 | exact through pnpm catalog |
| `@libsql/client` | 0.17.4 | exact through pnpm catalog |
| MCP TypeScript SDK | 1.29.0 | exact through pnpm catalog |
| Vitest | 4.1.10 | exact through pnpm catalog |
| Playwright | 1.61.1 | exact through pnpm catalog |
| tsdown | 0.22.9 | exact through pnpm catalog |
| Changesets | 2.31.1 | exact through pnpm catalog |

The numbers above are the researched implementation baseline, not an instruction to auto-upgrade. `pnpm-lock.yaml` is committed. Dependency upgrades require CI, schema round-trip, plugin contract, and package smoke tests.

## 3. Package manager and monorepo

### Decision

Use pnpm workspaces with Turborepo. Use a single lockfile and the `workspace:*` protocol for every internal dependency.

Required root files:

```text
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
turbo.json
tsconfig.base.json
.changeset/config.json
```

Required `package.json` fields:

```json
{
  "private": true,
  "packageManager": "pnpm@11.14.0",
  "engines": {
    "node": ">=24.0.0 <25"
  }
}
```

Required workspace settings:

```yaml
packages:
  - apps/*
  - packages/*

catalogMode: strict
sharedWorkspaceLockfile: true
disallowWorkspaceCycles: true
saveWorkspaceProtocol: rolling
```

The dependency graph must be acyclic. Domain packages must not depend on platform adapters, storage, CLI, API, or UI.

### Release model

- All public packages, the CLI, and both plugin manifests use one product version.
- Changesets uses a fixed group for every published package.
- Git tag format is `v<semver>`.
- Plugin archives contain compiled artifacts and must not require an install lifecycle script.
- npm package name is `@iroha-labs/iroha`; the executable remains `iroha`.
- The unscoped npm name `iroha` is already occupied and must not be used.

## 4. Logical package boundaries

| Package | Responsibility | May depend on |
|---|---|---|
| `@iroha/domain` | IDs, entities, states, pure policies | Zod only |
| `@iroha/config` | shared/local config schemas | domain |
| `@iroha/canonical` | Markdown/frontmatter parse, validate, publish | domain, config |
| `@iroha/storage` | libSQL connection, migrations, repositories | domain, config |
| `@iroha/search` | FTS, vector provider, hybrid ranking | domain, storage |
| `@iroha/git` | repository identity, refs, diff metadata | domain |
| `@iroha/forge` | provider interface | domain |
| `@iroha/forge-github` | GitHub implementation | forge |
| `@iroha/platform` | normalized hook event/output contracts | domain |
| `@iroha/adapter-claude` | Claude input/output mapping | platform |
| `@iroha/adapter-codex` | Codex input/output mapping | platform |
| `@iroha/core` | application use cases and transactions | above ports |
| `@iroha/mcp` | stdio MCP transport and tools | core |
| `@iroha/api` | Hono local API | core |
| `@iroha/cli` | `iroha` command | core, api |
| `@iroha/plugin` | manifests, hooks, skills, packaged dist | cli, mcp, adapters |
| `apps/dashboard` | React SPA | generated API client only |

`@iroha/*` is the internal workspace namespace. Only `@iroha-labs/iroha` is published initially; other packages remain private until there is a concrete external API need.

## 5. Module and build rules

- ESM only: package files use `"type": "module"`.
- TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`.
- Source imports include explicit `.js` extensions where Node ESM output requires them.
- Node entrypoints are bundled by tsdown into `dist/*.mjs`.
- Dashboard is built by Vite and embedded in the published package as static assets.
- Type declarations are emitted for internal package contract testing.
- Plugin bundles must contain no source-map paths that expose a developer home directory.
- Runtime code must not import from `apps/dashboard`.

## 6. Supported operating systems

### Tier 1: release-blocking

| OS | Architecture | Minimum | Notes |
|---|---|---|---|
| macOS | arm64, x64 | macOS 14 | Node 24, Git 2.40+ |
| Ubuntu | x64, arm64 | 22.04 LTS | glibc build |
| Windows | x64 | Windows 11 | native PowerShell path |
| WSL | x64, arm64 | WSL2 + Ubuntu 22.04 | treated as Linux |

### Tier 2: best effort

- Debian 12+
- Fedora 40+
- other glibc-based Linux distributions supported by Node 24 and the libSQL package
- Windows 10 22H2

### Not supported in 0.1

- WSL1
- musl/Alpine release artifacts
- Windows on ARM
- network filesystems for the local DB
- repositories without Git

Tier 1 CI must cover path spaces, non-ASCII paths, multiple worktrees, interrupted writes, and CRLF checkouts.

## 7. Agent platform baseline

| Platform | Minimum supported | Baseline tested | Primary surface |
|---|---:|---:|---|
| Claude Code | 2.1.198 | 2.1.214 | Terminal CLI |
| Codex | 0.144.5 | 0.144.5 | Codex CLI |

Why Claude Code 2.1.198:

- it includes the modern plugin/hook contract used by iroha;
- `prompt_id` is available from 2.1.196;
- PowerShell placeholder rewriting is available from 2.1.198;
- exec-form Node hooks work across Tier 1 platforms.

Codex remains pre-1.0. `0.144.5` is therefore both the minimum and the first tested baseline. Support for a newer Codex release is granted only after contract fixtures pass. `doctor` may allow an older version in development mode when all required capabilities are positively detected, but release support is not implied.

## 8. Supported surfaces

| Surface | 0.1 status | Contract |
|---|---|---|
| Claude Code terminal | Supported | full Plugin + Skill + Hook + MCP |
| Codex CLI | Supported | full Plugin + Skill + Hook + MCP after hook trust |
| Codex IDE extension | Preview | MCP/config may be shared; Hook E2E not release-blocking |
| ChatGPT desktop Codex surface | Preview | local MCP/config behavior tested separately |
| Claude Code VS Code/JetBrains | Preview | CLI-hosted local session only |
| Claude Code web/cloud | Unsupported | no assumption of local DB/plugin process |
| ChatGPT web | Unsupported | local stdio MCP is unavailable |

Documentation must never claim full support for a Preview surface.

## 9. Feature detection and version handling

`iroha doctor` performs both semver checks and capability checks.

Required checks:

1. locate `node`, `git`, `claude`, and `codex` without invoking a shell-built command string;
2. parse versions with tolerant semver normalization;
3. validate both plugin manifests using platform-native validators when available;
4. verify plugin paths and bundled entrypoints;
5. verify Codex hook feature is enabled and whether iroha hooks are trusted;
6. verify the MCP server can complete initialize/list-tools;
7. verify libSQL supports FTS5 `unicode61`, FTS5 `trigram`, `F32_BLOB(1024)`, `libsql_vector_idx`, and `vector_top_k`;
8. verify Git root, common dir, worktree git dir, and write access;
9. report Embedding and Forge providers without printing secret values.

Status levels:

- `ok`: supported and tested contract is present;
- `warning`: optional feature absent or version is newer and unverified;
- `error`: required capability absent;
- `blocked`: policy or trust explicitly prevents operation.

Unknown newer agent versions produce a warning, not an automatic failure. Contract tests, not version strings alone, determine compatibility.

## 10. Platform plugin rules

### Claude Code

- Manifest: `.claude-plugin/plugin.json`
- Hook config: `hooks/claude.json`
- MCP config: `.mcp.json` or manifest field
- Skills: `skills/<name>/SKILL.md`
- Explicit invocation: `/iroha:<skill>`
- Hook commands use exec form with `node` and `args`.
- Persistent data must not be stored under `${CLAUDE_PLUGIN_ROOT}`.

### Codex

- Manifest: `.codex-plugin/plugin.json`
- Hook config: `hooks/codex.json`
- MCP config: `.mcp.json` or manifest field
- Skills: `skills/<name>/SKILL.md`
- Explicit invocation: `$iroha:<skill>` where the installed namespace exposes it; CLI fallback is always documented.
- Only command hooks are required. Prompt/agent hook handlers are not used.
- Installation/enabling does not imply hook trust. Onboarding must direct users to `/hooks`.

The two manifests are not generated from each other at runtime. They are produced at build time from shared metadata and validated independently in CI.

## 11. Embedding baseline

- Embeddings are optional. The zero-config mode is FTS + graph retrieval.
- First provider: Voyage AI.
- Default model: `voyage-4`.
- Dimension: 1024.
- Document input uses `input_type=document`; query input uses `input_type=query`.
- API key variable: `VOYAGE_API_KEY`.
- The key name may be stored in config; the key value must never be written to `.iroha/`, local DB, logs, or diagnostics.
- Google and local providers are P1 adapters, not part of the 0.1 release gate.

Rationale: `voyage-4` is a current general-purpose multilingual retrieval model and the lexical index separately preserves code identifiers. `voyage-code-3` may be evaluated later as a second index, but v1 does not mix incompatible embedding spaces.

## 12. Forge baseline

- Git metadata is P0 and requires no hosting API.
- GitHub is the first P1 Forge provider.
- GitLab is represented by the provider port and fixtures only in 0.1.
- Forge failures never fail canonical sync.
- Authentication uses existing user tooling where possible; tokens are never copied into iroha storage.

## 13. Distribution and integrity

Initial channels:

1. GitHub Releases with plugin archives and SHA-256 checksums;
2. npm package `@iroha-labs/iroha` exposing the `iroha` binary;
3. Claude marketplace manifest hosted from the repository;
4. Codex marketplace manifest hosted from the repository.

Release requirements:

- CI builds from a clean checkout;
- `pnpm install --frozen-lockfile`;
- SBOM generation;
- npm provenance when the registry supports it;
- GitHub artifact attestation for archives;
- both manifests validate;
- archive smoke test runs without `node_modules` at the plugin root;
- the version matches package, manifests, changelog, and Git tag.

## 14. Source evidence

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code setup](https://code.claude.com/docs/en/setup)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Codex Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [pnpm Workspaces](https://pnpm.io/workspaces)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [libSQL vector search](https://docs.turso.tech/features/ai-and-embeddings)

