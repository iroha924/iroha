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
  a review-time check (listed in the `iroha-review` skill), **not** a hard CI gate — a
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
    package; the workspace source reaches them through the bundled
    `@iroha/cli`/`@iroha/mcp`, not direct imports.
  - `packages/forge-github` ignores the graphql-codegen deps: `codegen.ts` references them by plugin
    name (string) at codegen time, not by import.
  - `apps/e2e` ignores `@iroha/cli`/`@iroha/dashboard`: e2e spawns the built binary/dashboard as
    subprocesses — the deps only guarantee they build first.
  - `ignoreBinaries: ["semgrep"]`: the `pnpm semgrep` script invokes `semgrep`, which is a Python/pipx
    tool (see [[ci-security]]), not an npm dependency — so knip cannot resolve it and would otherwise
    report it as an unlisted binary.
- When knip flags a genuinely unused export that is still used **within its own file**, remove the
  `export` keyword (make it file-local) rather than deleting the symbol.

## Dependency upgrades — taze

- **What:** `pnpm deps:check` runs `taze -r` (recursive, catalog-aware) and *reports* available
  upgrades without writing anything. Add `-w` to write, `taze major` to include majors.
- **Trigger:** use it for an ad-hoc look at what is upgradable locally. Routine, PR-based updates are
  Renovate's job (below) — taze is the manual, interactive counterpart, not a replacement for the bot.

## Automated dependency PRs — Renovate

- **What:** `.github/renovate.json` configures the Renovate app to open the routine dependency-update
  PRs (npm + the `pnpm-workspace.yaml` catalog + GitHub Actions). It **replaces Dependabot** (there is
  no `.github/dependabot.yml`): Renovate understands the pnpm catalog, groups
  non-major bumps into one PR while a major is proposed on its own (except a genuine monorepo family,
  which `config:recommended`'s `group:monorepos`/`group:recommended` correctly keep together — e.g.
  `react` + `react-dom`), keeps action pins as commit SHAs + a version comment
  (`helpers:pinGitHubActionDigests`), and — matching this repo's supply-chain caution — holds a new
  release for `minimumReleaseAge: 3 days` before proposing it. A top-level `semanticCommitType: "chore"`
  forces **every** dependency commit to `chore(deps):` (without it, `config:recommended`'s
  `:semanticPrefixFixDepsChoreOthers` would emit `fix(deps):` for a runtime dep); the GitHub Actions
  rule overrides it to `ci(deps):`. Both satisfy `commitlint`.
- **Trigger:** it runs itself on the weekly schedule; there is nothing to run locally, and the Renovate
  app itself validates the config when it runs (config errors surface on its dependency dashboard).
  For an optional local check after editing, run the validator **pinned to at least the major**
  (Renovate publishes several releases a day, so a bare `renovate` would run an unvetted same-day
  build): `npx --yes --package renovate@43 renovate-config-validator .github/renovate.json`.
- **One-time human setup (outside the repo):** the Renovate **GitHub App must be installed** on the
  repo/org for the config to take effect — unlike Dependabot, which is GitHub-native. Until then the
  config is valid but inert.

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
  `exports`/types. attw exits 0 on this, so it does not fail the gate; do not add
  library types just to satisfy it.

## Bundle-size gate — size-limit

- **What:** `pnpm size` builds the dashboard and checks the **brotli** size of its JS/CSS bundles
  against the ceilings in `.size-limit.json` (currently ~295 kB JS / ~15 kB CSS, capped at 320 / 18 kB).
  The dashboard is the only large shipped artifact — the CLI/plugin are small.
- **Trigger:** it runs on every PR (CI `size` job); run it locally after adding a UI dependency or a
  heavy import. Bumping a ceiling is a deliberate act — do it in the same PR that adds the weight, with
  a note on why.
- **Supply-chain note:** size-limit 13.0.1 is in `minimumReleaseAgeExclude` (it was one day old at
  adoption). It is a devDependency by a high-reputation author, so this is
  accepted — but prefer an already-aged version for any future bump.

## End-to-end release smoke — Verdaccio + zx

- **What:** `pnpm release:smoke` runs `scripts/release-smoke.mjs` (a **zx** script) which publishes the
  exact `@irohalabs/iroha` artifact to a throwaway **Verdaccio** registry, installs it globally into a
  clean prefix, and runs `iroha --version` / `init` / `doctor` against a fresh git repo. It exercises
  the real publish → `npm install -g` → run path — native `@libsql/client`, `bin` resolution, bundled
  runtime assets — that the in-tree `test:package` cannot, because that never
  leaves the workspace. Everything is created in a temp dir and torn down in a `finally`.
- **Trigger:** run it before a release, or after changing `build-release.ts` / the plugin's packaging.
  It needs **network** (Verdaccio proxies dependencies to npmjs) and a free port **4873**; it is a
  local convenience, deliberately **not** a CI job (it is slow and network-bound).
- **Convention:** `verdaccio` is spawned as a binary from the zx script (not imported), and `zx` runs
  the script — knip resolves both, so no `knip.json` entry is needed (unlike a purely runtime-string
  dependency). Both are pinned in the strict catalog (`verdaccio@6.8.0`, `zx@8.8.5`).

## Local CI reproduction — act

- **What:** `pnpm ci:local` runs **act**, which executes the `.github/workflows` jobs locally in Docker.
  Use it to reproduce a CI failure without pushing.
- **Trigger:** when a CI job fails in a way you cannot reproduce with the plain `pnpm` scripts, or before
  pushing a workflow change. `act -l` lists jobs; `act -j <job>` runs one (e.g. `act -j verify`).
- **Not an npm dependency:** act is a Go binary (`brew install act`, like `semgrep` is a pipx tool), so
  it is in `knip.json` `ignoreBinaries` and needs Docker running. A green `act` run is a strong signal
  but not identical to GitHub's runners (image and hardware differ) — see `~/.claude/rules/ci-discipline.md`.

## Related

- Core build/typecheck/test conventions: [[typescript-conventions]].
- Everything under `.claude/**` is English: [[distributable-language]].
- CI gates and the review bots: [[ci-review-bots]] and `~/.claude/rules/ci-discipline.md`.
