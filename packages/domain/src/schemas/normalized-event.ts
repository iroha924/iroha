import { z } from "zod";
import { timestampSchema, typedId } from "./shared.js";

/** Matches `$defs.digest` (also reused for `cwdFingerprint`, which has the same pattern). */
const digestSchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);

/** Mirrors schemas/normalized-event-v1.schema.json `$defs.target`. */
const targetSchema = z.strictObject({
  kind: z.enum(["file", "path", "command", "mcp", "other"]),
  value: z.string().min(1).max(500),
  operation: z.enum(["read", "write", "delete", "execute", "unknown"]).optional(),
});

const sessionStartedPayload = z.strictObject({
  source: z.enum(["startup", "resume", "clear", "compact"]),
});

const promptSubmittedPayload = z.strictObject({
  promptDigest: digestSchema,
});

/**
 * Mirrors `$defs.payload`'s tool-event branch, narrowed by the top-level
 * `allOf`/`if`/`then` block for the given `kind` (each tool-event `kind`
 * pins `phase`/`status` to one specific pair, not the branch's full enum).
 */
function toolEventPayload(
  phase: "pre" | "post" | "failure" | "permission",
  status: "started" | "succeeded" | "failed" | "denied" | "requested",
) {
  return z.strictObject({
    toolName: z.string().min(1).max(200),
    toolUseId: z.string().max(500).optional(),
    phase: z.literal(phase),
    targets: z.array(targetSchema).max(100),
    inputDigest: digestSchema.optional(),
    responseDigest: digestSchema.optional(),
    status: z.literal(status),
    durationMs: z.number().int().min(0).optional(),
  });
}

const compactionPayload = z.strictObject({
  trigger: z.enum(["manual", "auto"]),
  summaryDigest: digestSchema.optional(),
});

function agentPayload(phase: "start" | "stop") {
  return z.strictObject({
    agentId: z.string().min(1).max(500),
    agentType: z.string().min(1).max(200),
    phase: z.literal(phase),
    stopHookActive: z.boolean().optional(),
    lastMessageDigest: digestSchema.optional(),
  });
}

const turnStoppedPayload = z.strictObject({
  stopHookActive: z.boolean(),
  backgroundTaskCount: z.number().int().min(0),
  lastMessageDigest: digestSchema.optional(),
});

const reasonPayload = z.strictObject({
  reason: z.string().min(1).max(200),
});

const instructionsObservedPayload = z.strictObject({
  sourcePath: z.string().min(1).max(500),
  loadReason: z.string().min(1).max(200),
});

function taskPayload(phase: "created" | "completed") {
  return z.strictObject({
    taskId: z.string().min(1).max(500),
    subject: z.string().min(1).max(500),
    phase: z.literal(phase),
  });
}

const commonEventShape = {
  schemaVersion: z.literal(1),
  eventId: typedId("evt"),
  platform: z.enum(["claude_code", "codex"]),
  occurredAt: timestampSchema,
  platformSessionId: z.string().min(1).max(500),
  platformTurnId: z.string().max(500).optional(),
  cwdFingerprint: digestSchema,
  model: z.string().max(200).optional(),
  permissionMode: z.string().max(100).optional(),
};

/**
 * Mirrors the top-level object in schemas/normalized-event-v1.schema.json.
 * The JSON Schema expresses per-`kind` payload shape as a generic `payload`
 * `oneOf` intersected with a `kind`-keyed `allOf`/`if`/`then` block; both are
 * folded here into one `kind`-discriminated union with an already-narrowed
 * payload per variant, which validates the identical set of documents
 * (confirmed by the AJV/Zod equivalence tests).
 */
export const normalizedEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("SESSION_STARTED"),
    payload: sessionStartedPayload,
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("PROMPT_SUBMITTED"),
    payload: promptSubmittedPayload,
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TOOL_STARTED"),
    payload: toolEventPayload("pre", "started"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TOOL_COMPLETED"),
    payload: toolEventPayload("post", "succeeded"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TOOL_FAILED"),
    payload: toolEventPayload("failure", "failed"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("PERMISSION_REQUESTED"),
    payload: toolEventPayload("permission", "requested"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("COMPACTION_STARTED"),
    payload: compactionPayload,
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("COMPACTION_COMPLETED"),
    payload: compactionPayload,
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("AGENT_STARTED"),
    payload: agentPayload("start"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("AGENT_STOPPED"),
    payload: agentPayload("stop"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TURN_STOPPED"),
    payload: turnStoppedPayload,
  }),
  z.strictObject({ ...commonEventShape, kind: z.literal("TURN_FAILED"), payload: reasonPayload }),
  z.strictObject({ ...commonEventShape, kind: z.literal("SESSION_ENDED"), payload: reasonPayload }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("INSTRUCTIONS_OBSERVED"),
    payload: instructionsObservedPayload,
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TASK_CREATED"),
    payload: taskPayload("created"),
  }),
  z.strictObject({
    ...commonEventShape,
    kind: z.literal("TASK_COMPLETED"),
    payload: taskPayload("completed"),
  }),
]);

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
