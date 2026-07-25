# Contributing to iroha

Thanks for your interest in improving iroha. This guide covers the local development setup. The confirmed product specification lives in [docs/product/](./docs/product/), and the implementation entry points are [CLAUDE.md](./CLAUDE.md) (Claude Code) and [AGENTS.md](./AGENTS.md) (Codex and others).

## Prerequisites

- Node.js `>=24 <25`
- pnpm `11.14.0` via Corepack

## Setup and verification

```bash
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When your change affects them, also run `pnpm test:contracts`, `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:package`.

This is a pnpm workspace monorepo; internal packages depend on each other with `workspace:*`. Keep domain code independent of platform SDK types and of the filesystem/database implementation, validate every external boundary with Zod, and use parameterized SQL only. See `.claude/rules/` for the repository's TypeScript, security, and path-safety conventions.

## Running the dashboard

`iroha dashboard` serves the built SPA and its JSON API from one loopback port and hands the browser a one-time launch token. There are three ways to run it during development.

### `pnpm dashboard` — verify iroha itself

This repository dogfoods its own `.iroha/`, so from the repo root:

```bash
pnpm dashboard
```

This builds everything, serves the dashboard at `http://127.0.0.1:<random-port>`, and opens the browser. The URL carries the launch token in its fragment (`#token=…`), which the SPA exchanges once for an HttpOnly session cookie.

### `iroha` command — dogfood in another project

To use `iroha` as a global command in another repository:

```bash
pnpm setup        # once: puts pnpm's global bin dir on PATH, then reload your shell
pnpm link:global  # link the @iroha/cli binary globally
```

Then, inside any Git repository:

```bash
iroha init        # if not initialized yet
iroha dashboard
```

### HMR development — editing the UI

For hot-module-reload work on the SPA. Vite proxies `/api` same-origin, so the real cookie + anti-CSRF auth is reused (no auth bypass):

```bash
pnpm dashboard:api   # terminal 1 — API on fixed port 5178 with a fixed dev token
pnpm dashboard:web   # terminal 2 — Vite dev server (HMR), proxying /api to :5178
```

Then open `http://localhost:5173/#token=iroha-dev`.

`IROHA_DASHBOARD_DEV_TOKEN` (used by `pnpm dashboard:api`) is a loopback-development convenience only; when it is unset, each start mints a fresh random 256-bit token, as in production.

## End-to-end tests

The dashboard has a Playwright end-to-end test (`apps/e2e`) that launches the real `iroha dashboard` binary, seeds a candidate, and drives the full approve flow in a browser. It is **opt-in and local only** — it is not part of the CI verify matrix, so `pnpm test` never downloads a browser. Run it explicitly:

```bash
pnpm exec playwright install chromium   # once, downloads the browser
pnpm test:e2e
```

The package's `lint` and `typecheck` (both browser-free) do run in CI, so the harness stays current even though the browser run does not.

## Pull requests

- Keep one PR to one concern. Conventional Commits, one-line subjects.
- CI must be green (lint, typecheck, test, build across the verify matrix).
- Distributables and artifacts default to English; see [.claude/rules/distributable-language.md](./.claude/rules/distributable-language.md).
