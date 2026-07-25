# Local dev tooling: what each tool is for and when to reach for it

The core build/verify loop is `pnpm` + `turbo` + `biome` + `vitest` + `tsdown` (documented in
`typescript-conventions.md`). This file covers the *auxiliary* local tooling layered on top — the
things you run by hand at specific moments, not on every build. Each entry says **what it does** and
the **trigger** (when to run it).

## Conventions for adding any new tool

- **Strict catalog.** `pnpm-workspace.yaml` has `catalogMode: strict`, so every dependency — including
  a root-only dev tool — must be pinned in the `catalog:` block and referenced as `"catalog:"` in the
  consuming `package.json`. A bare version string fails install.
- **`minimumReleaseAge` guard.** A freshly published version (younger than the cutoff) fails
  `pnpm install --frozen-lockfile` in CI (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). Pin a version
  that is already older than the cutoff, or add a `minimumReleaseAgeExclude` entry with a reason.
- **typos allowlist.** A tool whose name looks like a misspelling (e.g. `sherif` → "sheriff") trips the
  CI `typos` check. Add it to `_typos.toml` `[default.extend-words]` as `name = "name"`. `typos` is a
  CI-only gate (not in the pre-commit/pre-push hooks), so a local `pnpm install` will not catch this —
  the failure only shows up in the `docs-lint` job.

## Toolchain pinning — mise

- **What:** `mise.toml` pins the local Node major (`node = "24"`) so `mise install` reproduces CI's
  runtime. pnpm is intentionally *not* pinned here — it stays managed by corepack via the
  `packageManager` field, so there is a single source of truth for the pnpm version.
- **Trigger:** run `mise install` after cloning (or when the pin changes). If you don't use mise, the
  `engines.node` range in `package.json` still documents the same requirement.
- **First use / after edits:** mise refuses an untrusted config (`Config files … are not trusted` /
  `error parsing config file`) as a security measure. Run `mise trust` once in the repo to allow it;
  it re-prompts whenever `mise.toml` changes. This is expected, not a config error.

## Commit messages — czg

- **What:** `pnpm cz` opens an interactive Conventional Commit prompt (cz-git engine). It reads the
  existing `commitlint.config.js`, so the produced message already satisfies the `commit-msg` hook.
- **Trigger:** use it instead of `git commit -m` when you want the guided flow. Plain `git commit`
  still works — czg is an aid, not a gate.

## Monorepo package.json hygiene — sherif

- **What:** `pnpm lint:packages` runs `sherif`, a fast Rust linter for cross-package `package.json`
  consistency (unordered dependency keys, multiple versions of one dep, missing fields, …). `sherif -f`
  autofixes the mechanical ones (dependency-key ordering).
- **Trigger:** run it after you add, remove, or reorder any dependency in any `package.json`. It is
  fast enough (~ms) to run before every push that touches a manifest.

## Dead code and unused dependencies — knip

- **What:** `pnpm knip` finds unused files, unused (dev)dependencies, and unused exports/types across
  the whole workspace. Its config is `knip.json`.
- **Trigger:** run it after removing a feature or a caller, or when auditing what can be trimmed. It is
  a review-time check (listed in the `iroha-review`/`self-review` skills), **not** a hard CI gate — a
  knip false-positive on a legitimate new dependency should not block an unrelated PR.
- **The config models these project-specific false positives.** knip cannot see them statically, so
  they are configured, not real dead code — do **not** "fix" a config entry by deleting the code:
  - `apps/dashboard/src/components/ui/**` is marked `entry`: it is the vendored shadcn design system
    ([[dashboard-shadcn-and-csp]]); a primitive not yet composed is kept on purpose, and `shadcn add`
    re-adds it anyway. Marking it `entry` (not `ignore`) also keeps its transitive deps (e.g. `cmdk`)
    and its own exports from being flagged.
  - `tests/fixtures/**` is ignored: fixtures are read from disk at test time, never imported.
  - `packages/canonical` ignores the three secretlint rule packages — `secret-scan.ts` resolves them
    at runtime by string id (`createEngine({ rules: [{ id: "@secretlint/..." }] })`), so no static
    import exists ([[secure-subprocess-and-credentials]]).
  - `packages/plugin` ignores its runtime deps: those are the concrete deps of the **published** npm
    package (decision-log ID-038); the workspace source reaches them through the bundled
    `@iroha/cli`/`@iroha/mcp`, not direct imports.
  - `packages/forge-github` ignores the graphql-codegen deps: `codegen.ts` references them by plugin
    name (string) at codegen time, not by import.
  - `apps/e2e` ignores `@iroha/cli`/`@iroha/dashboard`: e2e spawns the built binary/dashboard as
    subprocesses — the deps only guarantee they build first.
- When knip flags a genuinely unused export that is still used **within its own file**, remove the
  `export` keyword (make it file-local) rather than deleting the symbol.

## Dependency upgrades — taze

- **What:** `pnpm deps:check` runs `taze -r` (recursive, catalog-aware) and *reports* available
  upgrades without writing anything. Add `-w` to write, `taze major` to include majors.
- **Trigger:** use it for an ad-hoc look at what is upgradable locally. Routine, PR-based updates are
  Renovate's job (see [[ci-review-bots]]) — taze is the manual, interactive counterpart, not a
  replacement for the bot.

## Published-package validation — publint + attw

- **What:** `pnpm check:package` builds the release bundle (`packages/plugin/release/`, the exact
  artifact `release.yml` publishes as `@irohalabs/iroha`) and lints it with **publint** (packaging
  correctness: `exports`/`files`/`bin`, ESM/CJS conditions) and **attw** (`@arethetypeswrong/cli` —
  whether a consumer can resolve the package's types). `pnpm check:package:validate` runs just the two
  linters against an already-built release — used by `release.yml`, which has already assembled it.
- **Trigger:** run it when you change packaging — `packages/plugin/build-release.ts`, the plugin's
  `package.json`, `exports`, `files`, or `bin`. It also runs on every PR (CI `package-check` job) and
  before every publish (a `release.yml` step).
- **attw reports "This package does not contain types" and that is expected:** the published package
  is a **CLI** (`bin: { iroha }`), not an importable library — `build-release.ts` strips the workspace
  `exports`/types (decision-log ID-038). attw exits 0 on this, so it does not fail the gate; do not add
  library types just to satisfy it.

## Related

- Core build/typecheck/test conventions: [[typescript-conventions]].
- Everything under `.claude/**` is English: [[distributable-language]].
- CI gates and the review bots: [[ci-review-bots]] and `~/.claude/rules/ci-discipline.md`.
