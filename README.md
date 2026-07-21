# iroha

A local-first Engineering Memory Graph for Claude Code and Codex.

It links development sessions, Issues, implementations, commits, PRs, reviews, decisions, rules, and incidents — each with provenance and human approval.

## Specifications

The confirmed specification lives in [docs/product/](./docs/product/). The implementation entry point is [CLAUDE.md](./CLAUDE.md) (Codex and others: [AGENTS.md](./AGENTS.md)).

## Development

Requires Node.js `>=24 <25` and pnpm 11.14.0 (via Corepack).

```bash
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Running the dashboard

The dashboard is a local, single-origin app: `iroha dashboard` serves the built SPA and its JSON API from one loopback port and hands the browser a one-time launch token. Human approval of knowledge candidates lives only here (and in the CLI) — agents never see it. There are three ways to run it.

### `pnpm dashboard` — verify iroha itself

This repository is already initialized (it dogfoods its own `.iroha/`), so from the repo root:

```bash
pnpm dashboard
```

This builds everything, then serves the dashboard at `http://127.0.0.1:<random-port>` and opens the browser. The URL carries the launch token in its fragment (`#token=…`), which the SPA exchanges once for an HttpOnly session cookie.

### `iroha` command — dogfood in another project

To use `iroha` as a global command in any other repository:

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
