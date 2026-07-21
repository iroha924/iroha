import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { approveCandidate, type CheckpointInput, runHook } from "@iroha/core";
import { dispatchTool, type McpEnvelope } from "@iroha/mcp";
import { closeDatabase, listCandidatesByStatus, openDatabase } from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudePostTool,
  claudePreTool,
  claudePrompt,
  claudeSessionStart,
  tokenFromSessionStart,
} from "./helpers/hook-events.js";
import { buildSliceRepo, cleanupSliceRepo, type SliceRepo } from "./helpers/slice-repo.js";

// Distinctive, non-secret-shaped markers seeded into the raw prompt and the raw
// edit body. Neither may reach any persisted or agent/human-facing artifact —
// only their HMAC digests are stored (hooks-contract.md §10, vertical-slice.md §6).
const RAW_PROMPT_MARKER = "RAW-PROMPT-PRIVACY-MARKER-abc123";
const RAW_PATCH_MARKER = "RAW-PATCH-PRIVACY-MARKER-def456";
const SESSION_TOKEN_RE = /ist_[A-Za-z0-9_-]{43}/;
// A detectable secret seeded into a checkpoint free-text field: create_checkpoint
// must redact it (WP-07) so it never reaches storage or an MCP response.
const SECRET_MARKER = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const SECRET_NEEDLE = "BEGIN RSA PRIVATE KEY";

const SESSION = "privacy-sess-1";

let repo: SliceRepo;
let sessionToken: string;

/** Every file under `.iroha/`, as `{ relativePath, content }`. */
async function irohaFiles(canonicalDir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const entries = await readdir(canonicalDir, { recursive: true });
  for (const entry of entries) {
    const full = join(canonicalDir, entry);
    if ((await stat(full)).isFile()) {
      out.push({ path: entry, content: await readFile(full, "utf8") });
    }
  }
  return out;
}

/** Every string cell across every real table (schema-driven, so no column is missed). */
async function allDbTextCells(dbPath: string): Promise<string[]> {
  const opened = await openDatabase(dbPath);
  if (!opened.ok) throw new Error(`db open failed: ${opened.error.code}`);
  const cells: string[] = [];
  try {
    const tables = await opened.value.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    for (const tableRow of tables.rows) {
      const table = String(tableRow.name);
      try {
        const rows = await opened.value.execute(`SELECT * FROM "${table}"`);
        for (const row of rows.rows) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") {
              cells.push(value);
            }
          }
        }
      } catch {
        // Virtual/shadow FTS tables that do not support `SELECT *` are skipped;
        // their text content mirrors `search_documents`, already scanned.
      }
    }
  } finally {
    await closeDatabase(opened.value);
  }
  return cells;
}

beforeAll(async () => {
  repo = await buildSliceRepo();
  const deps = { clock: repo.clock, random: repo.random };
  const raw = (payload: unknown) => ({
    platform: "claude_code" as const,
    raw: payload,
    cwd: repo.repoDir,
  });

  // Drive the loop with seeded raw markers, then approve a Decision into canonical.
  const started = await runHook(raw(claudeSessionStart(repo.repoDir, SESSION)), deps);
  const token = tokenFromSessionStart(started.stdout);
  if (token === undefined) throw new Error("no session token issued");
  sessionToken = token;

  await runHook(
    raw(claudePrompt(repo.repoDir, SESSION, `Refactor payments — ${RAW_PROMPT_MARKER}`, "p1")),
    deps,
  );
  const editInput = {
    file_path: "src/payments/service.ts",
    old_string: RAW_PATCH_MARKER,
    new_string: "x",
  };
  await runHook(raw(claudePreTool(repo.repoDir, SESSION, "Edit", editInput, "t1")), deps);
  await runHook(
    raw(claudePostTool(repo.repoDir, SESSION, "Edit", editInput, { success: true }, "t1", 10)),
    deps,
  );

  const checkpoint: CheckpointInput = {
    schemaVersion: 1,
    sessionToken: token,
    idempotencyKey: "privacy-checkpoint-0001",
    outcome: "completed",
    objective: "Adopt the repository pattern for payments",
    // The secret in this free-text field must be redacted by create_checkpoint.
    summary: `Extracted a PaymentRepository port. ${SECRET_MARKER}`,
    implementation: [{ file: "src/payments/service.ts", change: "extracted the port" }],
    validation: [{ command: "pnpm test payments", result: "passed" }],
    unresolved: [],
    references: [{ type: "issue", ref: "GH-42" }],
    labels: [],
    proposals: [
      {
        type: "decision",
        title: "Use the repository pattern for payments",
        summary: "Payments depend on a PaymentRepository port",
        body: [
          "# Use the repository pattern for payments",
          "## Context",
          "",
          "Payment code was coupled to a concrete store.",
          "## Decision",
          "",
          "Depend on a PaymentRepository port.",
          "## Rationale",
          "",
          "Testability and storage-agnosticism.",
          "## Consequences",
          "",
          "A repository implementation is required at composition time.",
          "## Alternatives considered",
          "",
          "Direct data-store access, rejected.",
        ].join("\n\n"),
        labels: [],
        scope: { paths: ["src/payments/**"], symbols: ["PaymentService"] },
        sources: [{ type: "issue", ref: "GH-42" }],
      },
    ],
  };
  const cp = await dispatchTool("create_checkpoint", checkpoint, {
    cwd: repo.repoDir,
    clock: repo.clock,
    random: repo.random,
  });
  const cpEnv = cp.structuredContent as unknown as McpEnvelope<{ candidateIds: string[] }>;
  if (!cpEnv.ok) throw new Error(`checkpoint failed: ${cpEnv.error.code}`);

  const db = await openDatabase(repo.resolved.dbPath);
  if (!db.ok) throw new Error("db open failed");
  let decisionCandidate: { id: string; revisionToken: string } | undefined;
  try {
    const pending = await listCandidatesByStatus(db.value, repo.resolved.repositoryId, "pending");
    if (pending.ok) {
      const found = pending.value.find((candidate) => candidate.candidateType === "decision");
      if (found) {
        decisionCandidate = { id: found.id, revisionToken: found.revisionToken };
      }
    }
  } finally {
    await closeDatabase(db.value);
  }
  if (decisionCandidate === undefined) throw new Error("no decision candidate created");

  const approved = await approveCandidate({
    cwd: repo.repoDir,
    clock: repo.clock,
    random: repo.random,
    candidateId: decisionCandidate.id,
    revisionToken: decisionCandidate.revisionToken,
    actor: { provider: "git", displayName: "Example Reviewer" },
  });
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.code}`);
}, 30_000);

afterAll(async () => {
  if (repo) {
    await cleanupSliceRepo(repo.repoDir);
  }
});

describe("Cross-artifact privacy scan (vertical-slice.md §6)", () => {
  it("keeps raw prompt/patch, the session token, and absolute paths out of canonical files", async () => {
    const files = await irohaFiles(repo.resolved.irohaCanonicalDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.content).not.toContain(RAW_PROMPT_MARKER);
      expect(file.content).not.toContain(RAW_PATCH_MARKER);
      expect(SESSION_TOKEN_RE.test(file.content)).toBe(false);
      // No absolute fixture path leaks into git-tracked canonical data.
      expect(file.content).not.toContain(repo.repoDir);
    }
  });

  it("keeps raw prompt/patch, a redacted secret, and token plaintext out of every DB text column", async () => {
    const cells = await allDbTextCells(repo.resolved.dbPath);
    const joined = cells.join("\n");
    expect(joined).not.toContain(RAW_PROMPT_MARKER);
    expect(joined).not.toContain(RAW_PATCH_MARKER);
    // The secret seeded into the checkpoint summary was redacted before storage.
    expect(joined).not.toContain(SECRET_NEEDLE);
    // Tokens are stored only as `hmac-sha256:` digests, never as `ist_` plaintext.
    expect(SESSION_TOKEN_RE.test(joined)).toBe(false);
  });

  it("keeps the raw prompt/patch and the redacted secret out of MCP responses", async () => {
    const ctx = { cwd: repo.repoDir, clock: repo.clock, random: repo.random };
    const search = await dispatchTool(
      "search",
      { query: "repository pattern", mode: "lexical" },
      ctx,
    );
    // get_session_state echoes the recent checkpoint summary — the surface a
    // redaction miss would leak through — so this assertion is not vacuous.
    const sessionState = await dispatchTool("get_session_state", { sessionToken }, ctx);
    const combined =
      JSON.stringify(search.structuredContent) + JSON.stringify(sessionState.structuredContent);
    expect(combined).not.toContain(RAW_PROMPT_MARKER);
    expect(combined).not.toContain(RAW_PATCH_MARKER);
    expect(combined).not.toContain(SECRET_NEEDLE);
    expect(SESSION_TOKEN_RE.test(combined)).toBe(false);
  });
});
