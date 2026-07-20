import type { IrohaError, NormalizationContext, NormalizedEvent, Result } from "@iroha/platform";
import { describe, expect, it } from "vitest";
import { parseClaudeEvent } from "./parse-event.js";
import { renderClaudeOutput } from "./render-output.js";

const ctx: NormalizationContext = {
  digest: () => `hmac-sha256:${"a".repeat(64)}`,
  newEventId: () => "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  occurredAt: () => "2026-07-20T00:00:00.000Z",
};

function eventOf(raw: Record<string, unknown>): NormalizedEvent {
  const result: Result<NormalizedEvent | null, IrohaError> = parseClaudeEvent(raw, ctx);
  if (!result.ok || result.value === null) {
    throw new Error("failed to build event for test");
  }
  return result.value;
}

const sessionStart = eventOf({
  session_id: "s",
  cwd: "/repo",
  hook_event_name: "SessionStart",
  source: "startup",
});
const preToolUse = eventOf({
  session_id: "s",
  cwd: "/repo",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "src/generated/client.ts" },
});

describe("renderClaudeOutput", () => {
  it("writes nothing for a side-effect-only event", () => {
    expect(renderClaudeOutput({ kind: "none" }, sessionStart)).toBeUndefined();
  });

  it("nests additionalContext under hookSpecificOutput with the platform event name", () => {
    const json = renderClaudeOutput(
      { kind: "context", additionalContext: "[iroha]\n..." },
      sessionStart,
    );
    expect(JSON.parse(json ?? "")).toStrictEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[iroha]\n..." },
    });
  });

  it("renders a PreToolUse deny with the rule-prefixed reason", () => {
    const json = renderClaudeOutput(
      {
        kind: "deny",
        ruleId: "rul_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reason: "generated files are read-only",
      },
      preToolUse,
    );
    expect(JSON.parse(json ?? "")).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Blocked by iroha rule rul_01ARZ3NDEKTSV4RRFFQ69G5FAV: generated files are read-only",
      },
    });
  });

  it("renders a Stop continuation as a top-level block decision", () => {
    const json = renderClaudeOutput(
      { kind: "continuation", reason: "Save an iroha checkpoint" },
      sessionStart,
    );
    expect(JSON.parse(json ?? "")).toStrictEqual({
      decision: "block",
      reason: "Save an iroha checkpoint",
    });
  });
});
