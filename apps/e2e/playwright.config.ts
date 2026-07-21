import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end config (dashboard-api.md §10). Opt-in and local only — the CI
 * `verify` matrix runs `lint`/`typecheck`/`test`/`build`, never `test:e2e`, so
 * no browser binaries are downloaded on CI. Run locally with:
 *
 *   pnpm exec playwright install chromium   # once
 *   pnpm test:e2e
 *
 * Each spec launches the real built `iroha dashboard` binary against a fresh
 * temp repository, so tests run serially with a single worker.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
