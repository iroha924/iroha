import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveInitializedRepository, runInit } from "@iroha/core";
import { CryptoRandomSource, makeTypedId, SystemClock } from "@iroha/domain";
import { closeDatabase, insertCandidate, openDatabase } from "@iroha/storage";
import { expect, type Page, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const CLI_BIN = join(REPO_ROOT, "packages/cli/dist/bin.mjs");
const LAUNCH_TOKEN = "e2e-all-tabs-token";

/**
 * Every top-level tab, walked in one browser session. The per-page unit tests
 * render each route against a stubbed client; this asserts the same routes survive
 * the real API, the real router and a real repository — which is where an empty
 * state, a failed fetch, or an unhandled render throws instead.
 */
const TABS = [
  { path: "/", nav: "Digest" },
  { path: "/overview", nav: "Overview" },
  { path: "/sessions", nav: "Sessions" },
  { path: "/review", nav: "Review" },
  { path: "/knowledge", nav: "Knowledge" },
  { path: "/graph", nav: "Graph" },
  { path: "/search", nav: "Search" },
  { path: "/settings", nav: "Settings" },
  { path: "/doctor", nav: "Doctor" },
] as const;

let repoDir: string | undefined;
let server: ReturnType<typeof spawn> | undefined;
/** The full launch URL the CLI prints — it already carries `#token=`. */
let launchUrl: string;
/** Just the origin, for navigating to a route once the session cookie exists. */
let origin: string;

function readServerUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
    };
    const onOut = (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((candidate) => candidate.includes('"url"'));
      if (line === undefined) return;
      try {
        const parsed = JSON.parse(line) as { url?: string };
        if (typeof parsed.url === "string") {
          cleanup();
          resolve(parsed.url);
        }
      } catch {
        // Partial line — keep buffering.
      }
    };
    const onErr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`dashboard exited early (code=${code}). stderr: ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`dashboard did not report a URL within 20s. stderr: ${stderr}`));
    }, 20_000);
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("exit", onExit);
  });
}

test.beforeAll(async () => {
  const clock = new SystemClock();
  const random = new CryptoRandomSource();

  repoDir = await mkdtemp(join(tmpdir(), "iroha-e2e-tabs-"));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "iroha-e2e@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "iroha e2e"], { cwd: repoDir });

  const init = await runInit(repoDir, MIGRATIONS_DIR);
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const resolved = await resolveInitializedRepository(repoDir);
  if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.code}`);

  // One pending candidate, so the review queue renders a row rather than only its
  // empty state — both paths matter and the empty one is covered by every other tab.
  const db = await openDatabase(resolved.value.dbPath);
  if (!db.ok) throw new Error("failed to open database");
  await insertCandidate(db.value, {
    id: makeTypedId("cand", clock, random),
    repositoryId: resolved.value.repositoryId,
    candidateType: "rule",
    payloadJson: JSON.stringify({
      type: "rule",
      title: "Prefer parameterized SQL",
      summary: "String-built SQL is rejected in review.",
      body: "# Prefer parameterized SQL\n\nAlways bind parameters.",
      labels: [],
      scope: { paths: [], symbols: [] },
      sources: [{ type: "commit", ref: "abc1234" }],
      enforcement: "advisory",
    }),
    revisionToken: "e2e-token",
    createdAt: clock.now().toISOString(),
  });
  await closeDatabase(db.value);

  server = spawn(process.execPath, [CLI_BIN, "dashboard", "--json", "--no-open"], {
    cwd: repoDir,
    env: { ...process.env, IROHA_DASHBOARD_DEV_TOKEN: LAUNCH_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launchUrl = await readServerUrl(server);
  origin = new URL(launchUrl).origin;
});

test.afterAll(async () => {
  // `kill` only initiates termination. Removing the repository while the child
  // still owns it as cwd and holds an open libSQL database races it — the deletion
  // error is swallowed, so the temp repo leaks and a still-running child can
  // overlap the next serial spec. Matches approve-candidate.spec.ts's teardown.
  if (server !== undefined && server.exitCode === null) {
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve());
      server?.kill("SIGTERM");
      setTimeout(() => resolve(), 3_000);
    });
  }
  if (repoDir !== undefined) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Collects everything a broken page reports, so a failure names the cause. */
function watch(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      problems.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return problems === undefined ? { problems: [] } : { problems };
}

test("every tab renders against the real API with no errors", async ({ page }) => {
  const { problems } = watch(page);

  await page.goto(launchUrl);
  // The chrome only mounts once bootstrap resolves, so settle first: asserting a
  // count and then re-querying races the app's own re-render.
  await page.waitForLoadState("networkidle");

  // Two landmarks in one header. An unlabelled second one is announced as another
  // bare "navigation", with nothing to tell a screen-reader user them apart.
  const navs = page.getByRole("navigation");
  await expect(navs).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await expect(navs.nth(i)).toBeVisible();
    await expect(navs.nth(i)).toHaveAttribute("aria-label", /.+/);
  }

  // The launch token is single-use: it was exchanged for the session cookie above,
  // so re-visiting `#token=` per tab would 401 on a spent token rather than test
  // anything. Navigate by path and let the cookie carry the session.
  for (const tab of TABS) {
    await page.goto(`${origin}${tab.path}`);
    // The app is a hash-free SPA served from one origin; wait for the network to
    // settle so a fetch that 500s is attributed to this tab and not the next one.
    await page.waitForLoadState("networkidle");

    const main = page.locator("main");
    await expect(main, `${tab.nav} rendered no main region`).toBeVisible();
    const text = (await main.innerText()).trim();
    expect(text.length, `${tab.nav} rendered an empty main region`).toBeGreaterThan(0);
    expect(text, `${tab.nav} rendered a raw error boundary`).not.toContain("Something went wrong");

    // Identity, not just "something rendered": react-router marks the matched
    // NavLink `aria-current="page"`, so a route quietly falling through to another
    // page fails here instead of passing on whatever that page happened to draw.
    await expect(
      page.locator('[aria-current="page"]'),
      `${tab.nav} did not mark its own nav item active`,
    ).toHaveText(tab.nav);

    // Exactly one h1 per view: zero leaves a screen reader with no page title, and
    // more than one makes "the" title ambiguous.
    await expect(page.locator("h1"), `${tab.nav} h1 count`).toHaveCount(1);
  }

  // The detail route, reached the way a user reaches it — by clicking a row. A
  // hand-built `/review/<id>` can pass while the link that produces it is broken.
  // Kept in this test rather than its own: Playwright gives each test a fresh
  // context, and the session cookie lives in the context, not the server.
  await page.goto(`${origin}/review`);
  await page.waitForLoadState("networkidle");

  const row = page.getByRole("link", { name: /Prefer parameterized SQL/ });
  await expect(row, "the seeded candidate is not linked from the review queue").toBeVisible();
  await row.click();
  await page.waitForLoadState("networkidle");

  await expect(page).toHaveURL(/\/review\/cand_/);
  await expect(page.locator("h1")).toHaveCount(1);
  const detail = (await page.locator("main").innerText()).trim();
  expect(detail).toContain("Prefer parameterized SQL");
  expect(detail, "detail rendered a raw error boundary").not.toContain("Something went wrong");

  expect(problems, `problems across tabs:\n${problems.join("\n")}`).toEqual([]);
});
