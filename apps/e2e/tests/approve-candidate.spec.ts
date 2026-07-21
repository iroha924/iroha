import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveInitializedRepository, runInit } from "@iroha/core";
import { CryptoRandomSource, makeTypedId, SystemClock } from "@iroha/domain";
import { closeDatabase, insertCandidate, openDatabase } from "@iroha/storage";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

// apps/e2e/tests/<file> -> repo root.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const CLI_BIN = join(REPO_ROOT, "packages/cli/dist/bin.mjs");

// A fixed synthetic launch token (like `pnpm dashboard:api`), exchanged by the
// SPA for a session cookie. In production an unset env mints a random one.
const LAUNCH_TOKEN = "e2e-launch-token";

// A decision draft that already satisfies the canonical template (H1 + required
// H2s), so validation reports it approvable — mirrors the core test fixture.
const DECISION_TITLE = "Use libSQL as the local index";
const DECISION_BODY = `# ${DECISION_TITLE}

## Context

We need a rebuildable local index.

## Decision

Use libSQL.

## Rationale

It is embeddable and rebuildable.

## Consequences

- None

## Alternatives considered

- Native SQLite`;
const DECISION_DRAFT = {
  type: "decision",
  title: DECISION_TITLE,
  summary: "libSQL was chosen as the local index",
  body: DECISION_BODY,
  labels: [],
  scope: { paths: [], symbols: [] },
  sources: [{ type: "commit", ref: "abc1234" }],
};

let repoDir: string | undefined;
let server: ReturnType<typeof spawn> | undefined;
let launchUrl: string;

/** Resolves with the loopback URL the dashboard prints (JSON mode), or rejects on early exit. */
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
        // Partial line — keep buffering until the newline arrives.
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

/** Recursively finds the first `.md` file under `dir` whose content contains `needle`. */
async function findCanonicalContaining(dir: string, needle: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findCanonicalContaining(full, needle);
      if (found !== null) return found;
    } else if (entry.name.endsWith(".md")) {
      const content = await readFile(full, "utf8");
      if (content.includes(needle)) return full;
    }
  }
  return null;
}

test.beforeAll(async () => {
  const clock = new SystemClock();
  const random = new CryptoRandomSource();

  repoDir = await mkdtemp(join(tmpdir(), "iroha-e2e-"));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "iroha-e2e@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "iroha e2e"], { cwd: repoDir });

  const init = await runInit(repoDir, MIGRATIONS_DIR);
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const resolved = await resolveInitializedRepository(repoDir);
  if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.code}`);

  // Seed one pending decision candidate directly into the local index.
  const opened = await openDatabase(resolved.value.dbPath);
  if (!opened.ok) throw new Error(`open db failed: ${opened.error.code}`);
  const inserted = await insertCandidate(opened.value, {
    id: makeTypedId("cand", clock, random),
    repositoryId: resolved.value.repositoryId,
    candidateType: "decision",
    payloadJson: JSON.stringify(DECISION_DRAFT),
    revisionToken: Buffer.from(random.bytes(16)).toString("base64url"),
    createdAt: clock.now().toISOString(),
  });
  await closeDatabase(opened.value);
  if (!inserted.ok) throw new Error(`seed candidate failed: ${inserted.error.code}`);

  // Launch the real built dashboard binary against the seeded repo.
  server = spawn(process.execPath, [CLI_BIN, "dashboard", "--json", "--no-open"], {
    cwd: repoDir,
    env: { ...process.env, IROHA_DASHBOARD_DEV_TOKEN: LAUNCH_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launchUrl = await readServerUrl(server);
});

test.afterAll(async () => {
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

test("approve a fixture candidate, write canonical, and read it as approved knowledge", async ({
  page,
}) => {
  // The launch URL already carries the one-time token in its fragment; the SPA
  // exchanges it for the session cookie, then strips it from history.
  await page.goto(launchUrl);

  // Review queue → open the pending fixture candidate.
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.getByRole("link", { name: DECISION_TITLE }).click();
  await expect(page).toHaveURL(/\/review\/[^/]+$/);

  // Approval is gated on a reviewer name; the button is disabled until it is set.
  const approveButton = page.getByRole("button", { name: "Approve" });
  await expect(approveButton).toBeDisabled();
  await page.getByLabel("Reviewer name").fill("E2E Reviewer");
  await expect(approveButton).toBeEnabled();
  await approveButton.click();

  // Approval navigates back to the review queue.
  await expect(page).toHaveURL(/\/review$/);

  // The canonical Markdown file is written under .iroha/ on disk (the core guarantee).
  const canonicalPath = repoDir
    ? await findCanonicalContaining(join(repoDir, ".iroha"), DECISION_TITLE)
    : null;
  expect(
    canonicalPath,
    "a canonical file containing the decision title should exist on disk",
  ).not.toBeNull();

  // Reload: the approved decision now appears as approved knowledge.
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await page.getByRole("link", { name: DECISION_TITLE }).click();
  await expect(page).toHaveURL(/\/knowledge\/[^/]+$/);
  await expect(page.getByText(DECISION_TITLE).first()).toBeVisible();

  // A direct-route reload is served by the packaged server's SPA fallback.
  await page.reload();
  await expect(page.getByText(DECISION_TITLE).first()).toBeVisible();
});
