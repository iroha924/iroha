import type { IrohaError, NormalizationContext, NormalizedEvent, Result } from "@iroha/platform";
import { describe, expect, it } from "vitest";
import { parseClaudeEvent } from "./parse-event.js";

const FIXED_DIGEST = `hmac-sha256:${"a".repeat(64)}` as const;

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

const common = { session_id: "sess-1", cwd: "/repo", transcript_path: "/tmp/t.jsonl" };

describe("parseClaudeEvent — session lifecycle", () => {
  it("maps SessionStart to SESSION_STARTED and fingerprints cwd", () => {
    const { ctx, digested } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        { ...common, hook_event_name: "SessionStart", source: "startup", model: "claude-opus-4-8" },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "SESSION_STARTED",
      platform: "claude_code",
      platformSessionId: "sess-1",
      cwdFingerprint: FIXED_DIGEST,
      model: "claude-opus-4-8",
      payload: { source: "startup" },
    });
    expect(digested).toContain("/repo");
  });

  it("maps SessionEnd to SESSION_ENDED with the reason", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent({ ...common, hook_event_name: "SessionEnd", reason: "logout" }, ctx),
    );
    expect(event).toMatchObject({ kind: "SESSION_ENDED", payload: { reason: "logout" } });
  });
});

describe("parseClaudeEvent — prompt", () => {
  it("digests the prompt and carries prompt_id as the turn id", () => {
    const { ctx, digested } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "UserPromptSubmit",
          prompt: "why repository pattern?",
          prompt_id: "p-1",
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "PROMPT_SUBMITTED",
      platformTurnId: "p-1",
      payload: { promptDigest: FIXED_DIGEST },
    });
    expect(digested).toContain("why repository pattern?");
  });

  it("omits platformTurnId when prompt_id is absent (first input, pre-2.1.196)", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent({ ...common, hook_event_name: "UserPromptSubmit", prompt: "hi" }, ctx),
    );
    expect(event).not.toHaveProperty("platformTurnId");
  });
});

describe("parseClaudeEvent — tool events and target extraction", () => {
  it("classifies a Bash command to its leading token, never verbatim", () => {
    const { ctx, digested } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test payments --filter x" },
          tool_use_id: "toolu_1",
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TOOL_STARTED",
      payload: {
        toolName: "Bash",
        toolUseId: "toolu_1",
        phase: "pre",
        status: "started",
        targets: [{ kind: "command", value: "pnpm", operation: "execute" }],
        inputDigest: FIXED_DIGEST,
      },
    });
    // The full command survives only as a digest, never as a stored target value.
    expect(digested.some((v) => v.includes("pnpm test payments"))).toBe(true);
    expect(event?.kind === "TOOL_STARTED" && event.payload.targets[0]?.value).toBe("pnpm");
  });

  it("never leaks an env-assignment secret through the command target", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "GITHUB_TOKEN=ghp_notARealSecret gh api /user" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "command", value: "command", operation: "execute" }] },
    });
    expect(JSON.stringify(event)).not.toContain("ghp_notARealSecret");
  });

  it("extracts an Edit file target as a write", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "src/payments/service.ts", old_string: "a", new_string: "b" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: {
        targets: [{ kind: "file", value: "src/payments/service.ts", operation: "write" }],
      },
    });
  });

  it("retains only the tool name for an MCP tool", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PreToolUse",
          tool_name: "mcp__iroha__search",
          tool_input: { query: "x" },
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      payload: { targets: [{ kind: "mcp", value: "mcp__iroha__search", operation: "unknown" }] },
    });
  });

  it("maps PostToolUse to TOOL_COMPLETED with a response digest and duration", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "src/x.ts" },
          tool_response: { filePath: "src/x.ts", success: true },
          tool_use_id: "toolu_1",
          duration_ms: 42,
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TOOL_COMPLETED",
      payload: {
        phase: "post",
        status: "succeeded",
        responseDigest: FIXED_DIGEST,
        durationMs: 42,
      },
    });
  });
});

describe("parseClaudeEvent — compaction and stop", () => {
  it("maps PreCompact to COMPACTION_STARTED", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent({ ...common, hook_event_name: "PreCompact", trigger: "auto" }, ctx),
    );
    expect(event).toMatchObject({ kind: "COMPACTION_STARTED", payload: { trigger: "auto" } });
  });

  it("digests compact_summary on PostCompact without storing it", () => {
    const { ctx, digested } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "PostCompact",
          trigger: "manual",
          compact_summary: "we did X",
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "COMPACTION_COMPLETED",
      payload: { trigger: "manual", summaryDigest: FIXED_DIGEST },
    });
    expect(digested).toContain("we did X");
  });

  it("counts background_tasks into backgroundTaskCount on Stop", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: "done",
          background_tasks: [{ id: 1 }, { id: 2 }],
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({
      kind: "TURN_STOPPED",
      payload: { stopHookActive: false, backgroundTaskCount: 2, lastMessageDigest: FIXED_DIGEST },
    });
  });

  it("defaults backgroundTaskCount to 0 when the field is absent", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent({ ...common, hook_event_name: "Stop", stop_hook_active: true }, ctx),
    );
    expect(event).toMatchObject({ payload: { backgroundTaskCount: 0 } });
  });
});

describe("parseClaudeEvent — forward-compatibility and errors", () => {
  it("ignores unknown fields on a known event", () => {
    const { ctx } = makeFakeCtx();
    const event = unwrap(
      parseClaudeEvent(
        {
          ...common,
          hook_event_name: "SessionStart",
          source: "startup",
          a_future_field: { nested: true },
          another: 123,
        },
        ctx,
      ),
    );
    expect(event).toMatchObject({ kind: "SESSION_STARTED" });
  });

  it("returns ok(null) for a recognized but unmapped event", () => {
    const { ctx } = makeFakeCtx();
    const result = parseClaudeEvent(
      { ...common, hook_event_name: "PermissionRequest", tool_name: "Bash" },
      ctx,
    );
    expect(unwrap(result)).toBeNull();
  });

  it("returns INVALID_INPUT when hook_event_name is missing", () => {
    const { ctx } = makeFakeCtx();
    const result = parseClaudeEvent({ ...common, source: "startup" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT when a mapped event is missing a required field", () => {
    const { ctx } = makeFakeCtx();
    const result = parseClaudeEvent({ ...common, hook_event_name: "SessionStart" }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
