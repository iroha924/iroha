import {
  err,
  IrohaError,
  type NormalizationContext,
  type NormalizedEvent,
  normalizedEventSchema,
  ok,
  type Result,
  type ToolTarget,
} from "@iroha/platform";
import { z } from "zod";

// Raw Codex hook input shapes. Forward-compatible: `z.object` validates the
// fields iroha relies on and *strips* unknown fields (hooks-contract.md §2).
// Field names, enums, and event set are taken verbatim from the official Codex
// hooks documentation (https://learn.chatgpt.com/docs/hooks). Differences from
// Claude Code: `turn_id` instead of `prompt_id`, `model` is a common field, no
// `SessionEnd` event, edits arrive as the `apply_patch` tool, and PostCompact
// carries no summary.

const rawCommon = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  turn_id: z.string().optional(),
});

const rawToolInput = z.record(z.string(), z.unknown());

const rawSessionStart = rawCommon.extend({
  source: z.enum(["startup", "resume", "clear", "compact"]),
});
const rawUserPromptSubmit = rawCommon.extend({ prompt: z.string() });
const rawPreToolUse = rawCommon.extend({
  tool_name: z.string().min(1),
  tool_input: rawToolInput,
  tool_use_id: z.string().optional(),
});
const rawPostToolUse = rawCommon.extend({
  tool_name: z.string().min(1),
  tool_input: rawToolInput,
  tool_response: z.unknown(),
  tool_use_id: z.string().optional(),
});
const rawCompact = rawCommon.extend({ trigger: z.enum(["manual", "auto"]) });
const rawStop = rawCommon.extend({
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().nullable().optional(),
});

type RawCommon = z.infer<typeof rawCommon>;

function baseEvent(common: RawCommon, ctx: NormalizationContext) {
  return {
    schemaVersion: 1 as const,
    eventId: ctx.newEventId(),
    platform: "codex" as const,
    occurredAt: ctx.occurredAt(),
    platformSessionId: common.session_id,
    cwdFingerprint: ctx.digest(common.cwd),
    ...(common.turn_id === undefined ? {} : { platformTurnId: common.turn_id }),
    ...(common.model === undefined ? {} : { model: common.model }),
    ...(common.permission_mode === undefined ? {} : { permissionMode: common.permission_mode }),
  };
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Matches an apply_patch section header line: `*** Add File: path`,
// `*** Update File: path`, `*** Delete File: path`. Captures only the file
// path; the patch body (the actual content) is never read or stored (§8).
const APPLY_PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/**
 * Extract file targets from an apply_patch command by reading only its section
 * header lines, never the diff body — Codex expresses every edit as
 * `apply_patch`, and cross-platform Guardrail parity needs the touched paths
 * even though the patch content itself must not be stored (hooks-contract.md §8).
 */
function extractApplyPatchTargets(command: string | undefined): ToolTarget[] {
  if (command === undefined) {
    return [{ kind: "other", value: "apply_patch", operation: "write" }];
  }
  const targets: ToolTarget[] = [];
  for (const line of command.split("\n")) {
    const match = APPLY_PATCH_HEADER.exec(line.trim());
    if (match) {
      const operation = match[1] === "Delete" ? "delete" : "write";
      targets.push({ kind: "file", value: match[2] as string, operation });
    }
  }
  return targets.length > 0
    ? targets
    : [{ kind: "other", value: "apply_patch", operation: "write" }];
}

/** Codex expresses shell and edits through `Bash`/`apply_patch`; both use `tool_input.command`. */
export function extractCodexTargets(
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolTarget[] {
  if (toolName === "Bash") {
    const command = stringField(toolInput, "command");
    const classified = command?.trim().split(/\s+/)[0];
    return [{ kind: "command", value: classified || toolName, operation: "execute" }];
  }
  if (toolName === "apply_patch") {
    return extractApplyPatchTargets(stringField(toolInput, "command"));
  }
  if (toolName.startsWith("mcp__")) {
    return [{ kind: "mcp", value: toolName, operation: "unknown" }];
  }
  return [{ kind: "other", value: toolName, operation: "unknown" }];
}

function finalize(candidate: unknown): Result<NormalizedEvent, IrohaError> {
  const parsed = normalizedEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new IrohaError("INTERNAL_ERROR", "adapter produced an invalid normalized event", {
        details: { issues: parsed.error.issues.length },
      }),
    );
  }
  return ok(parsed.data);
}

function invalid(message: string): Result<never, IrohaError> {
  return err(new IrohaError("INVALID_INPUT", message));
}

/**
 * Parse one raw Codex hook input object into a normalized event.
 *
 * - `ok(event)` for a supported P0 event;
 * - `ok(null)` for a recognized-but-unmapped event (SubagentStart/Stop,
 *   PermissionRequest — P1 in v0.1);
 * - `err(INVALID_INPUT)` when required fields for a mapped event are missing.
 */
export function parseCodexEvent(
  raw: unknown,
  ctx: NormalizationContext,
): Result<NormalizedEvent | null, IrohaError> {
  const discriminator = z.object({ hook_event_name: z.string() }).safeParse(raw);
  if (!discriminator.success) {
    return invalid("missing or non-string hook_event_name");
  }

  switch (discriminator.data.hook_event_name) {
    case "SessionStart": {
      const r = rawSessionStart.safeParse(raw);
      if (!r.success) return invalid("invalid SessionStart input");
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "SESSION_STARTED",
        payload: { source: r.data.source },
      });
    }
    case "UserPromptSubmit": {
      const r = rawUserPromptSubmit.safeParse(raw);
      if (!r.success) return invalid("invalid UserPromptSubmit input");
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "PROMPT_SUBMITTED",
        payload: { promptDigest: ctx.digest(r.data.prompt) },
      });
    }
    case "PreToolUse": {
      const r = rawPreToolUse.safeParse(raw);
      if (!r.success) return invalid("invalid PreToolUse input");
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "TOOL_STARTED",
        payload: {
          toolName: r.data.tool_name,
          ...(r.data.tool_use_id === undefined ? {} : { toolUseId: r.data.tool_use_id }),
          phase: "pre",
          targets: extractCodexTargets(r.data.tool_name, r.data.tool_input),
          inputDigest: ctx.digest(JSON.stringify(r.data.tool_input)),
          status: "started",
        },
      });
    }
    case "PostToolUse": {
      const r = rawPostToolUse.safeParse(raw);
      if (!r.success) return invalid("invalid PostToolUse input");
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "TOOL_COMPLETED",
        payload: {
          toolName: r.data.tool_name,
          ...(r.data.tool_use_id === undefined ? {} : { toolUseId: r.data.tool_use_id }),
          phase: "post",
          targets: extractCodexTargets(r.data.tool_name, r.data.tool_input),
          inputDigest: ctx.digest(JSON.stringify(r.data.tool_input)),
          ...(r.data.tool_response === undefined
            ? {}
            : { responseDigest: ctx.digest(JSON.stringify(r.data.tool_response)) }),
          status: "succeeded",
        },
      });
    }
    case "PreCompact": {
      const r = rawCompact.safeParse(raw);
      if (!r.success) return invalid("invalid PreCompact input");
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "COMPACTION_STARTED",
        payload: { trigger: r.data.trigger },
      });
    }
    case "PostCompact": {
      const r = rawCompact.safeParse(raw);
      if (!r.success) return invalid("invalid PostCompact input");
      // Codex PostCompact carries no summary payload, so no summaryDigest.
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "COMPACTION_COMPLETED",
        payload: { trigger: r.data.trigger },
      });
    }
    case "Stop": {
      const r = rawStop.safeParse(raw);
      if (!r.success) return invalid("invalid Stop input");
      const lastMessage = r.data.last_assistant_message;
      return finalize({
        ...baseEvent(r.data, ctx),
        kind: "TURN_STOPPED",
        payload: {
          stopHookActive: r.data.stop_hook_active,
          // Codex has no background-task payload on Stop.
          backgroundTaskCount: 0,
          ...(lastMessage ? { lastMessageDigest: ctx.digest(lastMessage) } : {}),
        },
      });
    }
    default:
      // Codex has no SessionEnd; SubagentStart/Stop and PermissionRequest are P1.
      return ok(null);
  }
}
