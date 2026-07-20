import type { IrohaError, NormalizationContext, NormalizedEvent, Result } from "@iroha/platform";
import { describe, expect, it } from "vitest";
import { parseCodexEvent } from "./parse-event.js";
import { renderCodexOutput } from "./render-output.js";

const ctx: NormalizationContext = {
  digest: () => `hmac-sha256:${"b".repeat(64)}`,
  newEventId: () => "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  occurredAt: () => "2026-07-20T00:00:00.000Z",
};

function eventOf(raw: Record<string, unknown>): NormalizedEvent {
  const result: Result<NormalizedEvent | null, IrohaError> = parseCodexEvent(raw, ctx);
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

describe("renderCodexOutput", () => {
  it("writes nothing for a side-effect-only event", () => {
    expect(renderCodexOutput({ kind: "none" }, sessionStart)).toBeUndefined();
  });

  it("nests additionalContext under hookSpecificOutput", () => {
    const json = renderCodexOutput({ kind: "context", additionalContext: "[iroha]" }, sessionStart);
    expect(JSON.parse(json ?? "")).toStrictEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[iroha]" },
    });
  });

  it("renders a PreToolUse deny", () => {
    const json = renderCodexOutput(
      { kind: "deny", ruleId: "rul_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "read-only" },
      sessionStart,
    );
    expect(JSON.parse(json ?? "")).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Blocked by iroha rule rul_01ARZ3NDEKTSV4RRFFQ69G5FAV: read-only",
      },
    });
  });

  it("renders a Stop continuation as a block decision (Codex requires JSON)", () => {
    const json = renderCodexOutput(
      { kind: "continuation", reason: "Save a checkpoint" },
      sessionStart,
    );
    expect(JSON.parse(json ?? "")).toStrictEqual({
      decision: "block",
      reason: "Save a checkpoint",
    });
  });
});
