import { describe, expect, it } from "vitest";
import { normalizedEventSchema } from "./normalized-event.js";
import { createAjvValidator } from "./test-helpers/ajv.js";

const ajvValidate = createAjvValidator(
  new URL("../../../../schemas/normalized-event-v1.schema.json", import.meta.url),
);

function zodValid(data: unknown): boolean {
  return normalizedEventSchema.safeParse(data).success;
}

const ULID = "01J31J6Y00ZZZFVZ7VZBWZHXZP";
const DIGEST = `hmac-sha256:${"a".repeat(64)}`;

function base(overrides: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    eventId: `evt_${ULID}`,
    platform: "claude_code",
    occurredAt: "2026-07-18T00:00:00.000Z",
    platformSessionId: "session-1",
    cwdFingerprint: DIGEST,
    ...overrides,
  };
}

/** One valid event per `kind`, matching that kind's `allOf`-narrowed payload shape. */
const positiveFixtures: Array<[string, unknown]> = [
  ["SESSION_STARTED", base({ kind: "SESSION_STARTED", payload: { source: "startup" } })],
  ["PROMPT_SUBMITTED", base({ kind: "PROMPT_SUBMITTED", payload: { promptDigest: DIGEST } })],
  [
    "TOOL_STARTED",
    base({
      kind: "TOOL_STARTED",
      payload: { toolName: "Edit", phase: "pre", targets: [], status: "started" },
    }),
  ],
  [
    "TOOL_COMPLETED",
    base({
      kind: "TOOL_COMPLETED",
      payload: { toolName: "Edit", phase: "post", targets: [], status: "succeeded" },
    }),
  ],
  [
    "TOOL_FAILED",
    base({
      kind: "TOOL_FAILED",
      payload: { toolName: "Edit", phase: "failure", targets: [], status: "failed" },
    }),
  ],
  [
    "PERMISSION_REQUESTED",
    base({
      kind: "PERMISSION_REQUESTED",
      payload: { toolName: "Bash", phase: "permission", targets: [], status: "requested" },
    }),
  ],
  ["COMPACTION_STARTED", base({ kind: "COMPACTION_STARTED", payload: { trigger: "auto" } })],
  ["COMPACTION_COMPLETED", base({ kind: "COMPACTION_COMPLETED", payload: { trigger: "manual" } })],
  [
    "AGENT_STARTED",
    base({
      kind: "AGENT_STARTED",
      payload: { agentId: "agt_1", agentType: "Explore", phase: "start" },
    }),
  ],
  [
    "AGENT_STOPPED",
    base({
      kind: "AGENT_STOPPED",
      payload: { agentId: "agt_1", agentType: "Explore", phase: "stop" },
    }),
  ],
  [
    "TURN_STOPPED",
    base({
      kind: "TURN_STOPPED",
      payload: { stopHookActive: false, backgroundTaskCount: 0 },
    }),
  ],
  ["TURN_FAILED", base({ kind: "TURN_FAILED", payload: { reason: "timeout" } })],
  ["SESSION_ENDED", base({ kind: "SESSION_ENDED", payload: { reason: "normal" } })],
  [
    "INSTRUCTIONS_OBSERVED",
    base({
      kind: "INSTRUCTIONS_OBSERVED",
      payload: { sourcePath: "CLAUDE.md", loadReason: "session_start" },
    }),
  ],
  [
    "TASK_CREATED",
    base({
      kind: "TASK_CREATED",
      payload: { taskId: "tsk_1", subject: "Do the thing", phase: "created" },
    }),
  ],
  [
    "TASK_COMPLETED",
    base({
      kind: "TASK_COMPLETED",
      payload: { taskId: "tsk_1", subject: "Do the thing", phase: "completed" },
    }),
  ],
  [
    "with optional common fields",
    base({
      kind: "SESSION_STARTED",
      payload: { source: "resume" },
      platformTurnId: "turn-1",
      model: "claude-opus-4-8",
      permissionMode: "default",
    }),
  ],
];

const validSessionStarted = positiveFixtures[0]?.[1];

/** Targeted violations, one per constraint, each expected to fail both validators. */
const negativeFixtures: Array<[string, unknown]> = [
  ["top-level unknown field", { ...(validSessionStarted as object), extra: true }],
  [
    "schemaVersion wrong",
    base({ kind: "SESSION_STARTED", schemaVersion: 2, payload: { source: "startup" } }),
  ],
  [
    "eventId wrong prefix",
    base({ kind: "SESSION_STARTED", eventId: `ses_${ULID}`, payload: { source: "startup" } }),
  ],
  [
    "platform unknown",
    base({ kind: "SESSION_STARTED", platform: "cursor", payload: { source: "startup" } }),
  ],
  ["kind unknown", base({ kind: "UNKNOWN_KIND", payload: { source: "startup" } })],
  [
    "occurredAt missing Z suffix",
    base({
      kind: "SESSION_STARTED",
      occurredAt: "2026-07-18T00:00:00.000+09:00",
      payload: { source: "startup" },
    }),
  ],
  [
    "cwdFingerprint bad pattern",
    base({
      kind: "SESSION_STARTED",
      cwdFingerprint: "not-a-digest",
      payload: { source: "startup" },
    }),
  ],
  [
    "SESSION_STARTED wrong payload shape",
    base({ kind: "SESSION_STARTED", payload: { promptDigest: DIGEST } }),
  ],
  [
    "SESSION_STARTED unknown source",
    base({ kind: "SESSION_STARTED", payload: { source: "boot" } }),
  ],
  [
    "TOOL_STARTED wrong phase for kind",
    base({
      kind: "TOOL_STARTED",
      payload: { toolName: "Edit", phase: "post", targets: [], status: "started" },
    }),
  ],
  [
    "TOOL_STARTED wrong status for kind",
    base({
      kind: "TOOL_STARTED",
      payload: { toolName: "Edit", phase: "pre", targets: [], status: "succeeded" },
    }),
  ],
  [
    "TOOL_STARTED missing required targets",
    base({ kind: "TOOL_STARTED", payload: { toolName: "Edit", phase: "pre", status: "started" } }),
  ],
  [
    "TOOL_STARTED bad target kind",
    base({
      kind: "TOOL_STARTED",
      payload: {
        toolName: "Edit",
        phase: "pre",
        status: "started",
        targets: [{ kind: "url", value: "x" }],
      },
    }),
  ],
  [
    "AGENT_STARTED wrong phase for kind",
    base({ kind: "AGENT_STARTED", payload: { agentId: "a", agentType: "t", phase: "stop" } }),
  ],
  [
    "TURN_STOPPED missing backgroundTaskCount",
    base({ kind: "TURN_STOPPED", payload: { stopHookActive: false } }),
  ],
  [
    "TURN_STOPPED negative backgroundTaskCount",
    base({ kind: "TURN_STOPPED", payload: { stopHookActive: false, backgroundTaskCount: -1 } }),
  ],
  [
    "TASK_CREATED wrong phase for kind",
    base({ kind: "TASK_CREATED", payload: { taskId: "t", subject: "s", phase: "completed" } }),
  ],
  [
    "payload extra field rejected",
    base({ kind: "SESSION_STARTED", payload: { source: "startup", extra: 1 } }),
  ],
];

describe("normalized event schema: AJV/Zod equivalence", () => {
  for (const [label, fixture] of positiveFixtures) {
    it(`accepts (both validators): ${label}`, () => {
      expect(ajvValidate(fixture)).toBe(true);
      expect(zodValid(fixture)).toBe(true);
    });
  }

  for (const [label, fixture] of negativeFixtures) {
    it(`rejects (both validators): ${label}`, () => {
      expect(ajvValidate(fixture)).toBe(false);
      expect(zodValid(fixture)).toBe(false);
    });
  }
});
