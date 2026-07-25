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

## Dependency upgrades — taze

- **What:** `pnpm deps:check` runs `taze -r` (recursive, catalog-aware) and *reports* available
  upgrades without writing anything. Add `-w` to write, `taze major` to include majors.
- **Trigger:** use it for an ad-hoc look at what is upgradable locally. Routine, PR-based updates are
  Renovate's job (see [[ci-review-bots]]) — taze is the manual, interactive counterpart, not a
  replacement for the bot.

## Related

- Core build/typecheck/test conventions: [[typescript-conventions]].
- Everything under `.claude/**` is English: [[distributable-language]].
- CI gates and the review bots: [[ci-review-bots]] and `~/.claude/rules/ci-discipline.md`.
