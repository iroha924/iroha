import { guardrailPathViolations, runDoctor, runHook } from "@iroha/core";
import { closeDatabase, listApprovedRulesForRepository, openDatabase } from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeededRule, seedApprovedGeneratedFilesRule } from "./helpers/canonical-seed.js";
import { claudePreTool, claudePrompt, claudeSessionStart } from "./helpers/hook-events.js";
import { buildSliceRepo, cleanupSliceRepo, type SliceRepo } from "./helpers/slice-repo.js";

const SESSION = "guardrail-sess-1";
const GENERATED_FILE = "src/generated/client.ts";
const PAYMENTS_FILE = "src/payments/service.ts";

let repo: SliceRepo;
let guardRule: SeededRule;

beforeAll(async () => {
  repo = await buildSliceRepo();
  guardRule = await seedApprovedGeneratedFilesRule(repo, { guardrail: true });
}, 30_000);

afterAll(async () => {
  if (repo) {
    await cleanupSliceRepo(repo.repoDir);
  }
});

const deps = () => ({ clock: repo.clock, random: repo.random });
const raw = (payload: unknown) => ({
  platform: "claude_code" as const,
  raw: payload,
  cwd: repo.repoDir,
});
const editOf = (file: string) => ({ file_path: file, old_string: "a", new_string: "b" });

describe("Guardrail flow (vertical-slice.md §4)", () => {
  it("denies a write to a protected path by any write tool, and allows unrelated writes", async () => {
    await runHook(raw(claudeSessionStart(repo.repoDir, SESSION)), deps());
    await runHook(raw(claudePrompt(repo.repoDir, SESSION, "edit generated", "p1")), deps());

    // Edit under src/generated/** is denied; the edit body carries a marker we
    // later assert never lands in the persisted event.
    const marker = "GUARDRAIL-DENY-CONTENT-MARKER";
    const denied = await runHook(
      raw(
        claudePreTool(
          repo.repoDir,
          SESSION,
          "Edit",
          { file_path: GENERATED_FILE, old_string: marker, new_string: "x" },
          "t1",
        ),
      ),
      deps(),
    );
    expect(denied.stdout).toBeDefined();
    const output = JSON.parse(denied.stdout as string) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(guardRule.id);

    // Tool-agnostic (ID-036): a MultiEdit — a write tool the guard's `tools`
    // (["Edit","Write"]) does not name — is denied just the same.
    const deniedMulti = await runHook(
      raw(claudePreTool(repo.repoDir, SESSION, "MultiEdit", { file_path: GENERATED_FILE }, "t2")),
      deps(),
    );
    expect(deniedMulti.stdout).toBeDefined();

    // An unrelated write is allowed (no deny output).
    const allowed = await runHook(
      raw(claudePreTool(repo.repoDir, SESSION, "Edit", editOf(PAYMENTS_FILE), "t3")),
      deps(),
    );
    expect(allowed.stdout).toBeUndefined();

    // Denied Tool Events are keyed to the protected path, and no edit body is stored.
    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const events = await db.value.execute(
        "SELECT tool_name, target_kind, target_summary, input_digest, response_digest FROM tool_events WHERE status = 'denied'",
      );
      const denialPaths = events.rows.map((row) => String(row.target_summary));
      expect(denialPaths).toContain(GENERATED_FILE);
      const cells = events.rows.flatMap((row) =>
        Object.values(row).map((value) => (value === null ? "" : String(value))),
      );
      expect(cells.some((cell) => cell.includes(marker))).toBe(false);
    } finally {
      await closeDatabase(db.value);
    }
  }, 20_000);

  it("enforces the same rule independently as a CI-style changed-path check", async () => {
    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      const rules = await listApprovedRulesForRepository(db.value, repo.resolved.repositoryId);
      expect(rules.ok).toBe(true);
      if (rules.ok) {
        const violations = guardrailPathViolations(rules.value, [GENERATED_FILE, PAYMENTS_FILE]);
        expect(violations).toEqual([{ ruleId: guardRule.id, path: GENERATED_FILE }]);
      }
    } finally {
      await closeDatabase(db.value);
    }
  });

  it("fails open and warns in doctor when a guard spec is unevaluable", async () => {
    const healthy = await runDoctor(repo.repoDir);
    expect(healthy.ok).toBe(true);
    if (healthy.ok) {
      expect(healthy.value.checks.find((c) => c.name === "guardrails")?.status).toBe("ok");
    }

    // Corrupt the stored guard spec into a structurally unevaluable shape. It
    // must stay valid JSON (the `json_valid(guard_spec_json)` CHECK forbids
    // otherwise), so an empty `tools` list — which the canonical schema's
    // `tools: min(1)` can never produce — stands in for a corrupt spec.
    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      await db.value.execute({
        sql: "UPDATE knowledge_items SET guard_spec_json = ? WHERE id = ?",
        args: ['{"tools":[],"paths":["src/generated/**"]}', guardRule.id],
      });
    } finally {
      await closeDatabase(db.value);
    }

    // Fail-open: a governed write is now allowed (the corrupt Guardrail is skipped).
    await runHook(raw(claudeSessionStart(repo.repoDir, SESSION, "resume")), deps());
    await runHook(raw(claudePrompt(repo.repoDir, SESSION, "edit generated again", "p3")), deps());
    const afterCorrupt = await runHook(
      raw(claudePreTool(repo.repoDir, SESSION, "Edit", editOf(GENERATED_FILE), "t3")),
      deps(),
    );
    expect(afterCorrupt.stdout).toBeUndefined();

    // Doctor surfaces the unevaluable Guardrail as a warning.
    const warned = await runDoctor(repo.repoDir);
    expect(warned.ok).toBe(true);
    if (warned.ok) {
      const check = warned.value.checks.find((c) => c.name === "guardrails");
      expect(check?.status).toBe("warning");
      expect(check?.message).toContain(guardRule.id);
    }
  }, 20_000);
});
