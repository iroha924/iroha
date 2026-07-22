import type { IrohaError, NormalizationContext, NormalizedEvent, Result } from "@iroha/platform";
import { describe, expect, it } from "vitest";
import { parseCodexEvent } from "./parse-event.js";

const FIXED_DIGEST = `hmac-sha256:${"b".repeat(64)}` as const;

function makeFakeCtx() {
  const digested: string[] = [];
  const ctx: NormalizationContext = {
    digest: (value) => {
      digested.push(value);
      return FIXED_DIGEST;
    },
    newEventId: () => "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    occurredAt: () => "2026-07-20T00:00:00.000Z",
  };
  return { ctx, digested };
}

function unwrap(result: Result<NormalizedEvent | null, IrohaError>): NormalizedEvent | null {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

const common = { session_id: "sess-1", cwd: "/repo", transcript_path: null, model: "gpt-5-codex" };

describe("parseCodexEvent — Codex-specific mapping", () => {
  it("carries turn_id as the platform turn id and model as a common field", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        { ...common, hook_event_name: "UserPromptSubmit", turn_id: "t-9", prompt: "hi" },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "PROMPT_SUBMITTED",
      platform: "codex",
      platformTurnId: "t-9",
      model: "gpt-5-codex",
      payload: { promptDigest: FIXED_DIGEST },
    });
  });

  it("has no SessionEnd event — returns ok(null)", () => {
    const { ctx } = makeFakeCtx();
    expect(
      unwrap(parseCodexEvent({ ...common, hook_event_name: "SessionEnd", reason: "other" }, ctx)),
    ).toBeNull();
  });

  it("returns ok(null) for P1 events (SubagentStart, PermissionRequest)", () => {
    const { ctx } = makeFakeCtx();
    expect(
      unwrap(parseCodexEvent({ ...common, hook_event_name: "PermissionRequest" }, ctx)),
    ).toBeNull();
    expect(
      unwrap(parseCodexEvent({ ...common, hook_event_name: "SubagentStart" }, ctx)),
    ).toBeNull();
  });

  it("maps PostCompact without a summary digest (Codex has no compact_summary)", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        { ...common, hook_event_name: "PostCompact", turn_id: "t-1", trigger: "auto" },
        ctx,
      ),
    );
    expect(event).toMatchObject({ kind: "COMPACTION_COMPLETED", payload: { trigger: "auto" } });
    expect(event).not.toHaveProperty("payload.summaryDigest");
  });

  it("tolerates a null last_assistant_message on Stop", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "Stop",
          turn_id: "t-1",
          stop_hook_active: false,
          last_assistant_message: null,
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TURN_STOPPED",
      payload: { stopHookActive: false, backgroundTaskCount: 0 },
    });
    expect(event).not.toHaveProperty("payload.lastMessageDigest");
  });
});

describe("parseCodexEvent — apply_patch and Bash targets", () => {
  it("extracts touched file paths from apply_patch headers without storing the body", () => {
    const { ctx, digested } = makeFakeCtx();
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/payments/service.ts",
      "@@ class PaymentService",
      "-  const secret = 'sk-live-123'",
      "+  const secret = env.SECRET",
      "*** Add File: src/generated/client.ts",
      "+export const generated = true",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "apply_patch",
          tool_input: { command: patch },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TOOL_STARTED",
      payload: {
        toolName: "apply_patch",
        targets: [
          { kind: "file", value: "src/payments/service.ts", operation: "write" },
          { kind: "file", value: "src/generated/client.ts", operation: "write" },
          { kind: "file", value: "src/old.ts", operation: "delete" },
        ],
      },
    });
    // The patch body (including the secret-looking line) is only ever digested.
    expect(digested.some((v) => v.includes("sk-live-123"))).toBe(true);
    const targetValues =
      event?.kind === "TOOL_STARTED" ? event.payload.targets.map((t) => t.value) : [];
    expect(targetValues.some((v) => v.includes("sk-live-123"))).toBe(false);
  });

  it("extracts a `Move to:` rename as a delete of the source and a write to the destination", () => {
    const { ctx } = makeFakeCtx();
    // A move INTO a protected path — the destination write must be surfaced so
    // the Guardrail sees it (was silently dropped, a Codex-only bypass).
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/scratch/tmp.ts",
      "*** Move to: src/generated/client.ts",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n");
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "apply_patch",
          tool_input: { command: patch },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TOOL_STARTED",
      payload: {
        toolName: "apply_patch",
        targets: [
          { kind: "file", value: "src/scratch/tmp.ts", operation: "delete" },
          { kind: "file", value: "src/generated/client.ts", operation: "write" },
        ],
      },
    });
  });

  it("falls back to an opaque write target when apply_patch has no headers", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "apply_patch",
          tool_input: { command: "not a real patch" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "other", value: "apply_patch", operation: "write" }] },
    });
  });

  it("classifies a Bash command to its leading token", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "Bash",
          tool_input: { command: "pnpm test payments" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "command", value: "pnpm", operation: "execute" }] },
    });
  });

  it("never leaks an env-assignment secret through the command target", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "Bash",
          tool_input: { command: "AWS_SECRET_ACCESS_KEY=abcd/efgh aws s3 ls" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "command", value: "command", operation: "execute" }] },
    });
    expect(JSON.stringify(event)).not.toContain("abcd/efgh");
  });

  it("does not treat a header-shaped patch body line as a real apply_patch header", () => {
    const { ctx } = makeFakeCtx();
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/real.ts",
      "@@",
      "-*** Update File: src/removed-from-a-string.ts",
      "+const doc = '*** Add File: src/inside-a-string.ts'",
      "*** End Patch",
    ].join("\n");
    const event = unwrap(
      parseCodexEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          turn_id: "t-1",
          tool_name: "apply_patch",
          tool_input: { command: patch },
        },
        ctx,
      ),
    );
    // Only the column-0 header is a target; the `+`/`-`-prefixed body lines are not.
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "file", value: "src/real.ts", operation: "write" }] },
    });
  });
});

describe("parseCodexEvent — forward-compatibility and errors", () => {
  it("ignores unknown fields", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseCodexEvent(
        { ...common, hook_event_name: "SessionStart", source: "resume", future_field: 1 },
        ctx,
      ),
    );
    expect(event).toMatchObject({ kind: "SESSION_STARTED", payload: { source: "resume" } });
  });

  it("returns INVALID_INPUT when a mapped event is missing a required field", () => {
    const { ctx } = makeFakeCtx();
    const result = parseCodexEvent(
      { ...common, hook_event_name: "PreToolUse", turn_id: "t-1" },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
