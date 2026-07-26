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
  insertAgentSession,
  insertCandidate,
  insertEntity,
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

async function seedSession(
  dbPath: string,
  repositoryId: TypedId<"repo">,
  opts: { platform: "claude_code" | "codex"; startedAt: string; lastSeenAt: string },
): Promise<TypedId<"ses">> {
  const db = await openDatabase(dbPath);
  if (!db.ok) throw new Error(db.error.code);
  const id = makeTypedId("ses", clock, random);
  const entity = await insertEntity(db.value, {
    id,
    repositoryId,
    entityType: "session",
    title: "session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: opts.startedAt,
    updatedAt: opts.lastSeenAt,
  });
  if (!entity.ok) {
    await closeDatabase(db.value);
    throw new Error(entity.error.code);
  }
  const ses = await insertAgentSession(db.value, {
    id,
    repositoryId,
    platform: opts.platform,
    platformSessionId: id,
    startedAt: opts.startedAt,
    lastSeenAt: opts.lastSeenAt,
  });
  await closeDatabase(db.value);
  if (!ses.ok) throw new Error(ses.error.code);
  return id;
}

async function eventLogCount(dbPath: string): Promise<number> {
  const db = await openDatabase(dbPath);
  if (!db.ok) throw new Error(db.error.code);
  try {
    const result = await db.value.execute("SELECT COUNT(*) AS n FROM event_log");
    return Number(result.rows[0]?.n ?? 0);
  } finally {
    await closeDatabase(db.value);
  }
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

  it("filters the knowledge list by type and status, and the candidate queue by status", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);

    const items = async (res: Response): Promise<{ id: string; type?: string }[]> =>
      ((await res.json()) as { data: { items: { id: string; type?: string }[] } }).data.items;

    // Pending by default; the approved status tab is empty until approval.
    expect((await items(await get(app, "/api/v1/candidates?status=pending", cookie))).length).toBe(
      1,
    );
    expect((await items(await get(app, "/api/v1/candidates?status=approved", cookie))).length).toBe(
      0,
    );

    const approved = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
    });
    expect(approved.status).toBe(200);

    // Review history: the approved status tab now surfaces the candidate.
    const approvedNow = await items(await get(app, "/api/v1/candidates?status=approved", cookie));
    expect(approvedNow.map((i) => i.id)).toContain(candidateId);

    // Knowledge default lists the approved decision.
    const all = await items(await get(app, "/api/v1/knowledge", cookie));
    expect(all.length).toBe(1);
    expect(all[0]?.type).toBe("decision");

    // `type` narrows: the matching type includes, a non-matching type excludes.
    expect((await items(await get(app, "/api/v1/knowledge?type=decision", cookie))).length).toBe(1);
    expect((await items(await get(app, "/api/v1/knowledge?type=rule", cookie))).length).toBe(0);

    // `status` narrows: archived excludes the approved decision.
    expect((await items(await get(app, "/api/v1/knowledge?status=archived", cookie))).length).toBe(
      0,
    );

    // An out-of-enum `type` is ignored (never applied, never widened to non-knowledge).
    expect((await items(await get(app, "/api/v1/knowledge?type=session", cookie))).length).toBe(1);
  });

  it("filters the session list by last_seen_at range and ignores a non-RFC-3339 bound", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    // A long-running session started in December, last active mid-January.
    const straddler = await seedSession(repo.dbPath, repo.repositoryId, {
      platform: "claude_code",
      startedAt: "2025-12-30T00:00:00.000Z",
      lastSeenAt: "2026-01-15T12:00:00.000Z",
    });
    await seedSession(repo.dbPath, repo.repositoryId, {
      platform: "codex",
      startedAt: "2026-03-01T00:00:00.000Z",
      lastSeenAt: "2026-03-01T00:00:00.000Z",
    });

    const sids = async (res: Response): Promise<string[]> =>
      ((await res.json()) as { data: { items: { id: string }[] } }).data.items.map((i) => i.id);

    // The Jan range is compared against last_seen_at, so the December-started
    // straddler is included and the March session is excluded.
    const jan = await get(
      app,
      "/api/v1/sessions?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z",
      cookie,
    );
    expect(await sids(jan)).toEqual([straddler]);

    // A malformed `from` is not RFC 3339, so it is ignored and both sessions list.
    const bad = await get(app, "/api/v1/sessions?from=not-a-date", cookie);
    expect((await sids(bad)).length).toBe(2);
  });

  it("forwards search filters to hybrid retrieval, rejects unknown filter keys, and has no suggestions route", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);

    // Approve a decision so it lands in `search_documents` (approve imports the
    // canonical doc, which projects the search document) and becomes searchable.
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);
    const approved = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
      comment: "ok",
    });
    expect(approved.status).toBe(200);

    // The `entityTypes` filter is a hard filter, forwarded into `mcpSearch`.
    const asDecision = await post(app, "/api/v1/search", cookie, {
      query: "libSQL",
      filters: { entityTypes: ["decision"] },
    });
    const decisionJson = (await asDecision.json()) as { data: { results: { type: string }[] } };
    expect(decisionJson.data.results.length).toBeGreaterThan(0);
    expect(decisionJson.data.results.every((r) => r.type === "decision")).toBe(true);

    // Filtering to a type the corpus does not contain excludes the decision —
    // proof the filter is forwarded and applied, not dropped.
    const asRule = await post(app, "/api/v1/search", cookie, {
      query: "libSQL",
      filters: { entityTypes: ["rule"] },
    });
    const ruleJson = (await asRule.json()) as { data: { results: unknown[] } };
    expect(ruleJson.data.results.length).toBe(0);

    // The tightened schema rejects an unknown filter key.
    const bogus = await post(app, "/api/v1/search", cookie, {
      query: "libSQL",
      filters: { bogus: true },
    });
    expect(bogus.status).toBe(400);

    // A non-RFC3339 date filter is rejected rather than silently mis-windowing
    // results (mcpSearch compares `from`/`to` lexicographically against updated_at).
    const badDate = await post(app, "/api/v1/search", cookie, {
      query: "libSQL",
      filters: { from: "zzzz" },
    });
    expect(badDate.status).toBe(400);

    const suggestions = await get(app, "/api/v1/search/suggestions", cookie);
    expect(suggestions.status).toBe(404);
  });

  it("returns 400 (not 500) for a malformed JSON body, in the standard failure envelope", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);

    // Passes anti-CSRF (headers are present) but the body is not parseable JSON;
    // @hono/zod-openapi's validator throws before the defaultHook, so onError must
    // rebuild the envelope the SPA client reads (`json.error.code`), not a bare 500.
    const res = await app.request("/api/auth/exchange", {
      method: "POST",
      headers: CSRF,
      body: "{ this is : not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("does not 400 a duplicated scalar query param; it stays lenient", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);

    // A repeated scalar param (abnormal — the SPA sends each once) must not 400;
    // the value is read leniently (first value), matching the pre-migration handler.
    const res = await get(app, "/api/v1/sessions?platform=codex&platform=claude_code", cookie);
    expect(res.status).toBe(200);
  });

  it("serves an OpenAPI 3.1 document, unauthenticated, describing the routes and request bodies", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);

    // No session cookie: the doc is the API shape only (no repository data).
    const res = await app.request("/api/doc", { headers: { Host: HOST } });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: unknown;
            parameters?: { name: string; in: string; required?: boolean }[];
            responses?: Record<string, unknown>;
          }
        >
      >;
    };
    expect(doc.openapi).toBe("3.1.0");

    // A representative mutation and its request body are documented.
    const approve = doc.paths["/api/v1/candidates/{id}/approve"]?.post;
    expect(approve?.requestBody).toBeDefined();
    // The mandatory anti-CSRF header is on the mutation, so a generated client sends it.
    expect(
      approve?.parameters?.some((p) => p.name === "x-iroha-request" && p.in === "header"),
    ).toBe(true);
    // The error set (403/404/409/500/503) is covered via a `default` response.
    expect(approve?.responses?.default).toBeDefined();
    // A GET with a query param is present; the doc endpoint does not describe itself.
    expect(doc.paths["/api/v1/sessions"]?.get).toBeDefined();
    expect(doc.paths["/api/doc"]).toBeUndefined();
  });

  it("records a mutation and a failure, but not a successful read", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);
    const { candidateId, revisionToken } = await seedDecision(repo.dbPath, repo.repositoryId);

    await get(app, "/api/v1/overview", cookie);
    const approved = await post(app, `/api/v1/candidates/${candidateId}/approve`, cookie, {
      revisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
    });
    expect(approved.status).toBe(200);
    const missing = await get(app, "/api/v1/knowledge/kno_01JQZ0000000000000000000", cookie);
    expect(missing.status).toBe(404);

    const body = (await (await get(app, "/api/v1/events", cookie)).json()) as {
      data: {
        events: {
          eventType: string;
          adapter: string | null;
          outcome: string;
          durationMs: number | null;
          errorCode: string | null;
        }[];
      };
    };
    const adapters = body.data.events.map((e) => e.adapter);

    // A successful read is not recorded: the SPA polls several pages every 5s,
    // which would fill the whole list and hide the rows worth reading.
    expect(adapters).not.toContain("GET /api/v1/overview");
    expect(adapters).not.toContain("GET /api/v1/events");

    // Hono reports the route pattern in its own `:param` form, not OpenAPI's `{param}`.
    const mutation = body.data.events.find(
      (e) => e.adapter === "POST /api/v1/candidates/:id/approve",
    );
    expect(mutation?.eventType).toBe("api.request");
    expect(mutation?.outcome).toBe("success");
    expect(mutation?.durationMs).not.toBeNull();

    const failed = body.data.events.find((e) => e.adapter === "GET /api/v1/knowledge/:id");
    expect(failed?.outcome).toBe("warning");
    expect(failed?.errorCode).toBe("NOT_FOUND");

    // The concrete URL never reaches the row — only the matched route pattern.
    expect(body.data.events.every((e) => e.adapter === null || !e.adapter.includes("?"))).toBe(
      true,
    );
  });

  it("writes nothing for a request rejected before authentication", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);

    // A 401 must cost no repository resolution and no write: `event_log` has no
    // pruning, so logging outside the guards would be an unauthenticated
    // disk-write for anything that can reach the loopback port.
    const before = await eventLogCount(repo.dbPath);
    const unauth = await app.request("/api/v1/overview", { headers: { Host: HOST } });
    expect(unauth.status).toBe(401);
    const csrf = await app.request("/api/v1/sync", {
      method: "POST",
      headers: { Host: HOST, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(csrf.status).toBe(403);
    expect(await eventLogCount(repo.dbPath)).toBe(before);
  });

  it("ignores a non-integer limit instead of failing the request", async () => {
    const repo = await setupApiRepo();
    dir = repo.dir;
    const { app } = makeApp(repo.dir);
    const cookie = await exchange(app);

    // A fractional value reaches SQL `LIMIT` unless it is truncated, where it
    // raises SQLITE_MISMATCH and becomes a 500 — the query rules require an
    // invalid value to be ignored, not to fail the request.
    const res = await get(app, "/api/v1/events?limit=10.5", cookie);
    expect(res.status).toBe(200);
  });
});
