---
paths:
  - "package.json"
  - "packages/*/package.json"
  - "apps/*/package.json"
  - "pnpm-workspace.yaml"
  - "knip.json"
  - "mise.toml"
  - ".size-limit.json"
  - "_typos.toml"
  - ".github/renovate.json"
  - "commitlint.config.js"
  - "lefthook.yml"
  - ".markdownlint-cli2.jsonc"
  - "scripts/**"
  - "packages/plugin/src/build-release.ts"
---

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
  `typos` check. Add it to `_typos.toml` `[default.extend-words]` as `name = "name"`. `typos` is not an
  npm dependency, so `pnpm install` does not provide it — see the typos entry below for how it is
  installed and where it runs.

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

## Spell check — typos

- **What:** `pnpm typos` runs [crate-ci/typos](https://github.com/crate-ci/typos), a source-code spell
  checker, against the `_typos.toml` allowlist. It checks code and prose alike, not just `docs/`.
  ~30ms on this repo.
- **Trigger:** it runs itself — the `pre-commit` hook checks the **staged files**, and CI's `docs-lint`
  job checks the tree. Run `pnpm typos` by hand when you want the whole tree without committing.
- **Install it:** `brew install typos-cli` on macOS; on Linux/WSL2 (both Tier 1 per
  `docs/contracts/compatibility.md`) use `cargo install typos-cli` or a
  [release binary](https://github.com/crate-ci/typos/releases). It is a Rust binary, like `semgrep` is
  a pipx tool — hence the `knip.json` `ignoreBinaries` entry.
- **Hidden paths are skipped by default, so `_typos.toml` turns that off.** Without
  `[files] ignore-hidden = false`, all of `.claude/**` and `.github/**` — 30 files, the largest English
  prose corpus here outside `docs/` — is silently unchecked, **in CI too** (the pinned action runs
  `typos .` with stock defaults). `.git/` is excluded explicitly, since enabling hidden paths otherwise
  pulls in ~682 files of Git internals. The hook is unaffected either way: it passes staged paths
  explicitly, and an explicit path is checked regardless of being hidden.
- **Not installed is not a failure.** The hook degrades to a warning rather than blocking, the same way
  `secret-scan` treats `gitleaks`, because CI's `docs-lint` job remains the authoritative gate. So a
  contributor without the binary is never blocked, and never silently protected either.
- **`typos` resolves its config from each target file's location — your cwd is irrelevant.** Measured:
  a file inside the repo passes even when you run from `/tmp`, and a file in `/tmp` fails even when you
  run from the repo (`sherif` flagged despite the allowlist). So never point it at paths outside the
  repository and read the result as meaningful.
- **A version mismatch is the first thing to check when a result surprises you.** The dictionary changes
  monthly and nothing keeps brew in step with the CI pin: Renovate bumps the pinned action, brew is on
  its own. Measured on this tree, typos 1.47.0 flags `inferrable` and `requestors`, which 1.48.0
  accepts — so an out-of-date local install blocks a commit CI would pass, and the output gives no hint
  that the version is why. Compare `typos --version` against the pin in `.github/workflows/ci.yml`.
- A false positive belongs in `_typos.toml` with a one-line reason, not in a hook exclusion.

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
- **It is installed and running.** The GitHub App is on this repo (it is not GitHub-native like
  Dependabot, so it needed a one-time install — that is done). Its **Dependency Dashboard is issue
  #121**, kept up to date by the bot: read that first to see what is queued rather than guessing.
- **Nothing appears between Mondays, and that is not a fault.** The schedule is `before 9am on
  monday` (Asia/Tokyo), so mid-week the dashboard lists updates under *Awaiting Schedule* and no PR
  exists yet. Before concluding Renovate "missed" an update, open #121 — the entry is usually there,
  waiting. A dashboard checkbox forces one out immediately when you need it sooner.
- **It reports versions, not urgency.** It will offer a bump, never tell you that staying put is a
  problem. A deprecation warning in a workflow run (e.g. an action still on the Node 20 runtime) is
  yours to notice and act on; Renovate would have offered the same bump as a routine major, with no
  signal that it mattered.

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
- CI gates and the review bots: the `pr-review-status` skill and `~/.claude/rules/ci-discipline.md`.
