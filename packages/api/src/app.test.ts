import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInitializedRepository, runInit } from "@iroha/core";
import { CryptoRandomSource, FixedClock, makeTypedId, type TypedId } from "@iroha/domain";
import { runGit } from "@iroha/git";
import {
  closeDatabase,
  getCandidateById,
  getEntityById,
  insertCandidate,
  openDatabase,
} from "@iroha/storage";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();
const LAUNCH_TOKEN = "test-launch-token-abcdef0123456789";
const ORIGIN = "http://127.0.0.1";
const HOST = "127.0.0.1";

const VALID_DECISION_BODY = `# Use libSQL as the local index

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

function decisionDraft(body = VALID_DECISION_BODY): unknown {
  return {
    type: "decision",
    title: "Use libSQL as the local index",
    summary: "libSQL was chosen as the local index",
    body,
    labels: [],
    scope: { paths: [], symbols: [] },
    sources: [{ type: "commit", ref: "abc1234" }],
  };
}

async function setupApiRepo(): Promise<{
  dir: string;
  repositoryId: TypedId<"repo">;
  dbPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-api-test-"));
  await runGit(["init", "--initial-branch=main"], { cwd: dir });
  await runGit(["config", "user.email", "iroha-test@example.com"], { cwd: dir });
  await runGit(["config", "user.name", "iroha test"], { cwd: dir });
  const init = await runInit(dir, MIGRATIONS_DIR);
  if (!init.ok) throw new Error(`init: ${init.error.code}`);
  const resolved = await resolveInitializedRepository(dir);
  if (!resolved.ok) throw new Error(`resolve: ${resolved.error.code}`);
  return { dir, repositoryId: resolved.value.repositoryId, dbPath: resolved.value.dbPath };
}

async function seedDecision(
  dbPath: string,
  repositoryId: TypedId<"repo">,
  body = VALID_DECISION_BODY,
): Promise<{ candidateId: TypedId<"cand">; revisionToken: string }> {
  const db = await openDatabase(dbPath);
  if (!db.ok) throw new Error(db.error.code);
  const candidateId = makeTypedId("cand", clock, random);
  const revisionToken = Buffer.from(random.bytes(16)).toString("base64url");
  const inserted = await insertCandidate(db.value, {
    id: candidateId,
    repositoryId,
    candidateType: "decision",
    payloadJson: JSON.stringify(decisionDraft(body)),
    revisionToken,
    createdAt: clock.now().toISOString(),
  });
  await closeDatabase(db.value);
  if (!inserted.ok) throw new Error(inserted.error.code);
  return { candidateId, revisionToken };
}

function makeApp(cwd: string): { app: Hono; launchToken: string } {
  const auth = createAuth(random, LAUNCH_TOKEN);
  const app = createApp({ cwd, clock, random, auth }) as unknown as Hono;
  return { app, launchToken: auth.launchToken };
}

const CSRF = {
  Origin: ORIGIN,
  Host: HOST,
  "Content-Type": "application/json",
  "X-Iroha-Request": "1",
};

async function exchange(app: Hono, token = LAUNCH_TOKEN): Promise<string> {
  const res = await app.request("/api/auth/exchange", {
    method: "POST",
    headers: CSRF,
    body: JSON.stringify({ token }),
  });
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(/iroha_session=([^;]+)/);
  return match?.[1] ?? "";
}

async function get(app: Hono, path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { Cookie: `iroha_session=${cookie}`, Host: HOST } });
}

async function post(app: Hono, path: string, cookie: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { ...CSRF, Cookie: `iroha_session=${cookie}` },
    body: JSON.stringify(body),
  });
}

describe("dashboard API", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      dir = undefined;
    }
  });

  it("exchanges the launch token once and rejects a replay", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);

    const first = await app.request("/api/auth/exchange", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({ token: LAUNCH_TOKEN }),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(first.headers.get("Set-Cookie")).toContain("SameSite=Strict");

    const replay = await app.request("/api/auth/exchange", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({ token: LAUNCH_TOKEN }),
    });
    expect(replay.status).toBe(401);
  });

  it("requires a session cookie for API reads and applies security headers", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);

    const unauth = await app.request("/api/v1/overview", { headers: { Host: HOST } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(unauth.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const cookie = await exchange(app);
    const ok = await get(app, "/api/v1/overview", cookie);
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { ok: boolean; meta: { requestId: string } };
    expect(json.ok).toBe(true);
    expect(json.meta.requestId).toMatch(/^req_/);
  });

  it("rejects a mutation missing the anti-CSRF header", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);

    const res = await app.request(`/api/v1/candidates/${candidateId}/approve`, {
      method: "POST",
      // Missing X-Iroha-Request / Origin.
      headers: {
        "Content-Type": "application/json",
        Cookie: `iroha_session=${cookie}`,
        Host: HOST,
      },
      body: JSON.stringify({ revisionToken, actor: { provider: "git", displayName: "R" } }),
    });
    expect(res.status).toBe(403);
  });

  it("approves a candidate over HTTP, writing the canonical file", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);

    const res = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
      comment: "ok",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { entityId: string; canonicalPath: string };
    };
    expect(json.ok).toBe(true);
    expect(json.data.canonicalPath).toMatch(/^decisions\/dec_/);

    const content = await readFile(join(repo.dir, ".iroha", json.data.canonicalPath), "utf8");
    expect(content).toContain("status: approved");

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error(db.error.code);
    const entity = await getEntityById(db.value, json.data.entityId);
    const candidate = await getCandidateById(db.value, candidateId);
    await closeDatabase(db.value);
    expect(entity.ok && entity.value?.authority).toBe(100);
    expect(candidate.ok && candidate.value?.status).toBe("approved");
  });

  it("returns 409 CONFLICT for a stale approve token", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId } = await seedDecision(repo.dbPath, repo.repositoryId);

    const res = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken: "stale",
      actor: { provider: "git", displayName: "R" },
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("CONFLICT");
  });

  it("returns 400 and blocks approval when a secret is present", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const secretBody = VALID_DECISION_BODY.replace(
      "We need a rebuildable local index.",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==\n-----END RSA PRIVATE KEY-----",
    );
    const { candidateId, revisionToken } = await seedDecision(
      repo.dbPath,
      repo.repositoryId,
      secretBody,
    );

    const res = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "R" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown request fields", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);

    const res = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "R" },
      unexpected: "field",
    });
    expect(res.status).toBe(400);
  });

  it("paginates the candidate queue with a stable cursor and has no raw-content endpoint", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    await seedDecision(repo.dbPath, repo.repositoryId);
    await seedDecision(repo.dbPath, repo.repositoryId);
    await seedDecision(repo.dbPath, repo.repositoryId);

    const page1 = await get(app, "/api/v1/candidates?limit=2", cookie);
    const j1 = (await page1.json()) as {
      data: { items: { id: string }[]; nextCursor: string | null };
    };
    expect(j1.data.items.length).toBe(2);
    expect(j1.data.nextCursor).not.toBeNull();

    const page2 = await get(
      app,
      `/api/v1/candidates?limit=2&cursor=${encodeURIComponent(j1.data.nextCursor ?? "")}`,
      cookie,
    );
    const j2 = (await page2.json()) as { data: { items: { id: string }[] } };
    expect(j2.data.items.length).toBe(1);
    const ids1 = new Set(j1.data.items.map((i) => i.id));
    expect(j2.data.items.every((i) => !ids1.has(i.id))).toBe(true);

    // No raw transcript / conversation endpoint exists.
    const raw = await get(app, "/api/v1/sessions/ses_x/raw", cookie);
    expect(raw.status).toBe(404);
  });
});
