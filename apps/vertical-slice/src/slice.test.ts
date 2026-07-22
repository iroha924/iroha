import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanonicalDocument } from "@iroha/canonical";
import {
  approveCandidate,
  type CheckpointInput,
  resolveInitializedRepository,
  runDoctor,
  runHook,
  runInit,
  runSearch,
  runSync,
} from "@iroha/core";
import type { TypedId } from "@iroha/domain";
import { runGit } from "@iroha/git";
import { dispatchTool, type McpEnvelope } from "@iroha/mcp";
import {
  closeDatabase,
  getActiveSessionRunForSession,
  getAgentSessionByPlatformIdentity,
  getCandidateById,
  getEntityById,
  getKnowledgeItemById,
  getLatestTurnForRun,
  listCandidatesByStatus,
  openDatabase,
} from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeededRule, seedApprovedGeneratedFilesRule } from "./helpers/canonical-seed.js";
import {
  claudePostTool,
  claudePreTool,
  claudePrompt,
  claudeSessionStart,
  claudeStop,
  codexPostTool,
  codexPreTool,
  codexPrompt,
  codexSessionStart,
  contextFromSessionStart,
  tokenFromSessionStart,
} from "./helpers/hook-events.js";
import {
  buildSliceRepo,
  cleanupSliceRepo,
  MIGRATIONS_DIR,
  type SliceRepo,
} from "./helpers/slice-repo.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Canonical Markdown documents anywhere under `.iroha/` (empty until approval/seed). */
async function canonicalDocFiles(irohaCanonicalDir: string): Promise<string[]> {
  const subdirs = ["decisions", "rules", "sessions", "knowledge"];
  const found: string[] = [];
  for (const sub of subdirs) {
    try {
      const entries = await readdir(join(irohaCanonicalDir, sub), { recursive: true });
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          found.push(join(sub, entry));
        }
      }
    } catch {
      // subdir may not exist yet
    }
  }
  return found;
}

const DEPS = (repo: SliceRepo) => ({ clock: repo.clock, random: repo.random });
const CTX = (repo: SliceRepo, cwd: string) => ({ cwd, clock: repo.clock, random: repo.random });

let repo: SliceRepo;
let cloneParent: string | undefined;

beforeAll(async () => {
  repo = await buildSliceRepo();
}, 30_000);

afterAll(async () => {
  if (repo) {
    await cleanupSliceRepo(repo.repoDir);
  }
  if (cloneParent) {
    // Removes the parent (and the `clone/` worktree inside it).
    await cleanupSliceRepo(cloneParent);
  }
});

describe("Step A: initialization", () => {
  it("creates the canonical scaffold and local database", async () => {
    const canonical = repo.resolved.irohaCanonicalDir;
    expect((await readFile(join(canonical, "schema-version"), "utf8")).trim()).toBe("1");
    expect(await pathExists(join(canonical, "config.yaml"))).toBe(true);
    expect(await pathExists(join(canonical, ".gitignore"))).toBe(true);
    expect(await pathExists(join(canonical, "taxonomy", "labels.yaml"))).toBe(true);
    expect(await pathExists(repo.resolved.dbPath)).toBe(true);
  });

  it("imports source docs as local candidates, not canonical documents", async () => {
    expect(repo.candidatesCreated).toBeGreaterThanOrEqual(2);
    expect(await canonicalDocFiles(repo.resolved.irohaCanonicalDir)).toEqual([]);
  });

  it("is idempotent: a second init makes no destructive change", async () => {
    const before = await readFile(join(repo.resolved.irohaCanonicalDir, "config.yaml"), "utf8");
    const second = await runInit(repo.repoDir, MIGRATIONS_DIR, { scan: true });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.init.freshInit).toBe(false);
      expect(second.value.init.candidatesCreated).toBe(0);
    }
    const after = await readFile(join(repo.resolved.irohaCanonicalDir, "config.yaml"), "utf8");
    expect(after).toBe(before);
  });

  it("doctor reports capability and platform checks", async () => {
    const report = await runDoctor(repo.repoDir);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.checks.length).toBeGreaterThan(0);
    }
  });
});

// The linear slice (steps B–F) shares one repo and carries ids between steps.
const CLAUDE_SESSION = "claude-sess-1";
let seededRule: SeededRule;
let claudeToken: string;
let decisionCandidateId: TypedId<"cand">;
let decisionRevisionToken: string;
let approvedEntityId: string;

describe("Steps B–F: the approved-knowledge loop (Claude)", () => {
  beforeAll(async () => {
    // A teammate's already-approved Rule, committed in Git and synced locally.
    seededRule = await seedApprovedGeneratedFilesRule(repo);
  }, 20_000);

  it("Step B: SessionStart returns a token and the approved rule, not pending candidates", async () => {
    const started = await runHook(
      {
        platform: "claude_code",
        raw: claudeSessionStart(repo.repoDir, CLAUDE_SESSION),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    const context = contextFromSessionStart(started.stdout);
    const token = tokenFromSessionStart(started.stdout);
    expect(token).toBeDefined();
    claudeToken = token as string;

    // Approved rule is present; a pending candidate (cand_…) never is.
    expect(context).toContain(seededRule.id);
    expect(context).toContain(seededRule.title);
    expect(context).not.toContain("cand_");

    const db = await openDatabase(repo.resolved.dbPath);
    expect(db.ok).toBe(true);
    if (!db.ok) throw new Error("db open failed");
    try {
      const session = await getAgentSessionByPlatformIdentity(
        db.value,
        repo.resolved.repositoryId,
        "claude_code",
        CLAUDE_SESSION,
      );
      expect(session.ok && session.value !== null).toBe(true);
      if (session.ok && session.value) {
        const run = await getActiveSessionRunForSession(db.value, session.value.id);
        expect(run.ok && run.value !== null).toBe(true);
      }
    } finally {
      await closeDatabase(db.value);
    }
  }, 15_000);

  it("Step C: a prompt + edit + test run create a Turn and mark it checkpoint-pending", async () => {
    await runHook(
      {
        platform: "claude_code",
        raw: claudePrompt(
          repo.repoDir,
          CLAUDE_SESSION,
          "Refactor src/payments/service.ts for GH-42 using the repository pattern",
          "prompt-1",
        ),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    const editInput = {
      file_path: "src/payments/service.ts",
      old_string: "a",
      new_string: "b",
    };
    await runHook(
      {
        platform: "claude_code",
        raw: claudePreTool(repo.repoDir, CLAUDE_SESSION, "Edit", editInput, "tool-edit-1"),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    await runHook(
      {
        platform: "claude_code",
        raw: claudePostTool(
          repo.repoDir,
          CLAUDE_SESSION,
          "Edit",
          editInput,
          { filePath: "src/payments/service.ts", success: true },
          "tool-edit-1",
          42,
        ),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    const bashInput = { command: "pnpm test payments" };
    await runHook(
      {
        platform: "claude_code",
        raw: claudePreTool(repo.repoDir, CLAUDE_SESSION, "Bash", bashInput, "tool-bash-1"),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    await runHook(
      {
        platform: "claude_code",
        raw: claudePostTool(
          repo.repoDir,
          CLAUDE_SESSION,
          "Bash",
          bashInput,
          { success: true },
          "tool-bash-1",
          120,
        ),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );

    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const session = await getAgentSessionByPlatformIdentity(
        db.value,
        repo.resolved.repositoryId,
        "claude_code",
        CLAUDE_SESSION,
      );
      if (!session.ok || !session.value) throw new Error("session missing");
      const run = await getActiveSessionRunForSession(db.value, session.value.id);
      if (!run.ok || !run.value) throw new Error("run missing");
      const turn = await getLatestTurnForRun(db.value, run.value.id);
      expect(turn.ok && turn.value !== null).toBe(true);
      if (turn.ok && turn.value) {
        expect(turn.value.checkpointState).toBe("pending");
      }

      // Tool targets are repo-relative; neither the command body nor a patch is stored whole.
      const events = await db.value.execute(
        "SELECT tool_name, target_kind, target_summary FROM tool_events",
      );
      const cells = events.rows.flatMap((row) => Object.values(row).map((v) => String(v)));
      expect(cells).toContain("src/payments/service.ts");
      expect(cells).toContain("pnpm"); // command classified to its leading token
      expect(cells.some((cell) => cell.includes("pnpm test payments"))).toBe(false);
    } finally {
      await closeDatabase(db.value);
    }
  }, 15_000);

  it("Step D: create_checkpoint saves one checkpoint and a pending Decision candidate (idempotent)", async () => {
    const input: CheckpointInput = {
      schemaVersion: 1,
      sessionToken: claudeToken,
      idempotencyKey: "slice-checkpoint-00000001",
      outcome: "completed",
      objective: "Refactor payments onto the repository pattern",
      summary: "Introduced a PaymentRepository port and updated PaymentService",
      implementation: [
        { file: "src/payments/service.ts", change: "extracted the PaymentRepository port" },
      ],
      validation: [{ command: "pnpm test payments", result: "passed" }],
      unresolved: [],
      references: [
        { type: "issue", ref: "GH-42" },
        { type: "file", ref: "src/payments/service.ts" },
      ],
      labels: [],
      proposals: [
        {
          type: "decision",
          title: "Use the repository pattern for payments",
          summary: "Payments depend on a PaymentRepository port for testability",
          body: [
            "# Use the repository pattern for payments",
            "## Context",
            "",
            "Payment code was coupled to a concrete store, which made it hard to test.",
            "## Decision",
            "",
            "Payments depend on a PaymentRepository port; PaymentService never touches a concrete store.",
            "## Rationale",
            "",
            "The repository pattern keeps payment logic testable and storage-agnostic.",
            "## Consequences",
            "",
            "A PaymentRepository implementation must be provided at composition time.",
            "## Alternatives considered",
            "",
            "Direct data-store access, rejected for poor testability.",
          ].join("\n\n"),
          labels: [],
          scope: { paths: ["src/payments/**"], symbols: ["PaymentService"] },
          sources: [{ type: "issue", ref: "GH-42" }],
        },
      ],
    };

    const first = await dispatchTool("create_checkpoint", input, CTX(repo, repo.repoDir));
    const firstEnv = first.structuredContent as unknown as McpEnvelope<{
      checkpointId: string;
      candidateIds: string[];
      deduplicated: boolean;
    }>;
    expect(firstEnv.ok).toBe(true);
    if (!firstEnv.ok) throw new Error(`checkpoint failed: ${firstEnv.error.code}`);
    expect(firstEnv.data.candidateIds).toHaveLength(1);
    expect(firstEnv.data.deduplicated).toBe(false);
    const checkpointId = firstEnv.data.checkpointId;

    // A retry with the same idempotency key returns the identical checkpoint.
    const retry = await dispatchTool("create_checkpoint", input, CTX(repo, repo.repoDir));
    const retryEnv = retry.structuredContent as unknown as McpEnvelope<{
      checkpointId: string;
      deduplicated: boolean;
    }>;
    expect(retryEnv.ok).toBe(true);
    if (retryEnv.ok) {
      expect(retryEnv.data.deduplicated).toBe(true);
      expect(retryEnv.data.checkpointId).toBe(checkpointId);
    }

    // Stop after a saved checkpoint does not request a second one.
    const stop = await runHook(
      { platform: "claude_code", raw: claudeStop(repo.repoDir, CLAUDE_SESSION), cwd: repo.repoDir },
      DEPS(repo),
    );
    expect(stop.stdout).toBeUndefined();

    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const pending = await listCandidatesByStatus(db.value, repo.resolved.repositoryId, "pending");
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        const decision = pending.value.find((c) => c.candidateType === "decision");
        expect(decision).toBeDefined();
        if (decision) {
          decisionCandidateId = decision.id;
          decisionRevisionToken = decision.revisionToken;
        }
      }
    } finally {
      await closeDatabase(db.value);
    }
  }, 20_000);

  it("Step E: approving the candidate writes a canonical Decision at authority 100", async () => {
    const approved = await approveCandidate({
      cwd: repo.repoDir,
      clock: repo.clock,
      random: repo.random,
      candidateId: decisionCandidateId,
      revisionToken: decisionRevisionToken,
      actor: { provider: "git", displayName: "Example Reviewer" },
    });
    if (!approved.ok) {
      throw new Error(
        `approve failed: ${approved.error.code}: ${approved.error.message} (cause: ${String(approved.error.cause)})`,
      );
    }
    approvedEntityId = approved.value.entityId;

    // A file was created under .iroha/decisions/dec_<ULID>.md and round-trips.
    expect(approved.value.canonicalPath).toContain("decisions");
    expect(approved.value.canonicalPath).toContain(`${approvedEntityId}.md`);
    const filePath = join(repo.resolved.irohaCanonicalDir, "decisions", `${approvedEntityId}.md`);
    expect(await pathExists(filePath)).toBe(true);
    const parsed = parseCanonicalDocument(await readFile(filePath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.frontmatter.type).toBe("decision");
      expect(parsed.value.frontmatter.title).toBe("Use the repository pattern for payments");
    }

    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const entity = await getEntityById(db.value, approvedEntityId);
      expect(entity.ok && entity.value?.authority).toBe(100);
      const candidate = await getCandidateById(db.value, decisionCandidateId);
      expect(candidate.ok && candidate.value?.status).toBe("approved");
    } finally {
      await closeDatabase(db.value);
    }
  }, 20_000);

  it("Step F: a teammate clone rebuilds and retrieves the Decision, with no local state", async () => {
    // Commit the approved canonical file, then clone only Git-tracked data.
    await runGit(["add", "-A"], { cwd: repo.repoDir });
    const commit = await runGit(["commit", "-m", "chore: approve repository-pattern decision"], {
      cwd: repo.repoDir,
    });
    expect(commit.ok).toBe(true);

    cloneParent = await mkdtemp(join(tmpdir(), "iroha-slice-clone-"));
    const cloneDir = join(cloneParent, "clone");
    const cloned = await runGit(["clone", repo.repoDir, cloneDir], { cwd: cloneParent });
    expect(cloned.ok).toBe(true);

    // A fresh clone has the committed `.iroha/` but no local index yet: the
    // teammate initializes (creating the local DB and importing canonical),
    // then rebuilds from `.iroha/` — proving rebuild-equivalence.
    const initialized = await runInit(cloneDir, MIGRATIONS_DIR);
    expect(initialized.ok).toBe(true);
    const rebuilt = await runSync(cloneDir, MIGRATIONS_DIR, { rebuild: true });
    if (!rebuilt.ok) {
      throw new Error(
        `rebuild failed: ${rebuilt.error.code}: ${rebuilt.error.message} (cause: ${String(rebuilt.error.cause)})`,
      );
    }

    // FTS-only Japanese query returns the approved Decision by its entity id.
    // The Latin term is whitespace-delimited: FTS tokenizes on whitespace, so a
    // script-glued form ("…repository…") cannot match English content via the
    // lexical arm (decision-log ID-032 — cross-lingual recall is a vector-arm
    // concern, out of scope for FTS-only).
    const jpQuery = "なぜ repository pattern を使うのか";
    const cliHits = await runSearch(cloneDir, jpQuery, { mode: "lexical", limit: 10 });
    expect(cliHits.ok).toBe(true);
    if (cliHits.ok) {
      expect(cliHits.value.results.some((hit) => hit.id === approvedEntityId)).toBe(true);
    }

    // MCP search (the agent path) returns the same entity id, with provenance.
    const mcp = await dispatchTool(
      "search",
      { query: jpQuery, mode: "lexical" },
      CTX(repo, cloneDir),
    );
    const mcpEnv = mcp.structuredContent as unknown as McpEnvelope<{
      results: { id: string; sources: { type: string }[] }[];
    }>;
    expect(mcpEnv.ok).toBe(true);
    if (mcpEnv.ok) {
      const hit = mcpEnv.data.results.find((r) => r.id === approvedEntityId);
      expect(hit).toBeDefined();
      expect((hit?.sources.length ?? 0) > 0).toBe(true);
    }

    // No local candidate, token, prompt (Turn), or Tool Event crosses the clone boundary.
    const cloneResolved = await resolveInitializedRepository(cloneDir);
    expect(cloneResolved.ok).toBe(true);
    if (!cloneResolved.ok) return;
    const db = await openDatabase(cloneResolved.value.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const counts = await db.value.execute(
        "SELECT (SELECT count(*) FROM candidates) AS candidates, (SELECT count(*) FROM session_tokens) AS tokens, (SELECT count(*) FROM turns) AS turns, (SELECT count(*) FROM tool_events) AS tool_events",
      );
      const row = counts.rows[0];
      expect(Number(row?.candidates)).toBe(0);
      expect(Number(row?.tokens)).toBe(0);
      expect(Number(row?.turns)).toBe(0);
      expect(Number(row?.tool_events)).toBe(0);

      // Rebuild-equivalence: the approved Decision is reconstructed identically
      // from `.iroha/` alone — same entity (authority 100) and knowledge_items row.
      const entity = await getEntityById(db.value, approvedEntityId);
      expect(entity.ok && entity.value?.authority).toBe(100);
      const knowledge = await getKnowledgeItemById(db.value, approvedEntityId);
      expect(knowledge.ok && knowledge.value?.enforcement).toBe("advisory");
    } finally {
      await closeDatabase(db.value);
    }
  }, 30_000);
});

describe("Platform parity: Codex produces the same normalized behavior", () => {
  const CODEX_SESSION = "codex-sess-1";

  it("SessionStart surfaces the approved rule and a token; a patch + command mark the Turn pending", async () => {
    const started = await runHook(
      { platform: "codex", raw: codexSessionStart(repo.repoDir, CODEX_SESSION), cwd: repo.repoDir },
      DEPS(repo),
    );
    expect(tokenFromSessionStart(started.stdout)).toBeDefined();
    expect(contextFromSessionStart(started.stdout)).toContain(seededRule.id);

    await runHook(
      {
        platform: "codex",
        raw: codexPrompt(repo.repoDir, CODEX_SESSION, "Update payments for GH-42", "codex-turn-1"),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/payments/service.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const patchInput = { command: patch };
    await runHook(
      {
        platform: "codex",
        raw: codexPreTool(repo.repoDir, CODEX_SESSION, "codex-turn-1", "apply_patch", patchInput),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );
    await runHook(
      {
        platform: "codex",
        raw: codexPostTool(repo.repoDir, CODEX_SESSION, "codex-turn-1", "apply_patch", patchInput, {
          success: true,
        }),
        cwd: repo.repoDir,
      },
      DEPS(repo),
    );

    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const session = await getAgentSessionByPlatformIdentity(
        db.value,
        repo.resolved.repositoryId,
        "codex",
        CODEX_SESSION,
      );
      if (!session.ok || !session.value) throw new Error("codex session missing");
      const run = await getActiveSessionRunForSession(db.value, session.value.id);
      if (!run.ok || !run.value) throw new Error("codex active run missing");
      const turn = await getLatestTurnForRun(db.value, run.value.id);
      // Same normalized outcome as Claude: the patch marks the Turn pending.
      expect(turn.ok && turn.value?.checkpointState).toBe("pending");

      // The patch body is only digested, never stored as a tool target.
      const events = await db.value.execute("SELECT target_summary FROM tool_events");
      const cells = events.rows.flatMap((r) => Object.values(r).map((v) => String(v)));
      expect(cells).toContain("src/payments/service.ts");
      expect(cells.some((cell) => cell.includes("Begin Patch"))).toBe(false);
    } finally {
      await closeDatabase(db.value);
    }
  }, 20_000);
});
