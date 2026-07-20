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

// Raw Claude Code hook input shapes. Forward-compatible: `z.object` validates
// the fields iroha relies on and *strips* every unknown field, so a newer
// Claude Code release adding fields never breaks parsing (hooks-contract.md §2).
// Field names and enums are taken verbatim from the official Claude Code hooks
// documentation (https://code.claude.com/docs/en/hooks).

const rawCommon = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  // Claude sends `model` only on SessionStart; `permission_mode` on a subset of
  // events; `prompt_id` from v2.1.196+ and only once user input exists.
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  prompt_id: z.string().optional(),
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
  duration_ms: z.number().int().min(0).optional(),
});
const rawPreCompact = rawCommon.extend({ trigger: z.enum(["manual", "auto"]) });
const rawPostCompact = rawCommon.extend({
  trigger: z.enum(["manual", "auto"]),
  compact_summary: z.string().optional(),
});
const rawStop = rawCommon.extend({
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().optional(),
  background_tasks: z.array(z.unknown()).optional(),
});
const rawSessionEnd = rawCommon.extend({ reason: z.string().min(1).max(200) });

type RawCommon = z.infer<typeof rawCommon>;

/**
 * Fields every normalized event shares, derived from the raw common fields plus
 * the injected context. Optional fields are omitted (not set to `undefined`) to
 * satisfy `exactOptionalPropertyTypes` and the strict normalized schema.
 */
function baseEvent(common: RawCommon, ctx: NormalizationContext) {
  return {
    schemaVersion: 1 as const,
    eventId: ctx.newEventId(),
    platform: "claude_code" as const,
    occurredAt: ctx.occurredAt(),
    platformSessionId: common.session_id,
    cwdFingerprint: ctx.digest(common.cwd),
    ...(common.prompt_id === undefined ? {} : { platformTurnId: common.prompt_id }),
    ...(common.model === undefined ? {} : { model: common.model }),
    ...(common.permission_mode === undefined ? {} : { permissionMode: common.permission_mode }),
  };
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const CLAUDE_FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * Structural extraction only. iroha resolves `file`/`path` values to
 * repository-relative form in `@iroha/core` (it owns the filesystem/Git access
 * an adapter must not have). Shell commands are classified to their leading
 * token, never stored verbatim — the full command survives only as
 * `inputDigest` (hooks-contract.md §8).
 */
export function extractClaudeTargets(
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolTarget[] {
  if (toolName === "Bash") {
    const command = stringField(toolInput, "command");
    const classified = command?.trim().split(/\s+/)[0];
    return [{ kind: "command", value: classified || toolName, operation: "execute" }];
  }
  if (toolName === "Read") {
    const path = stringField(toolInput, "file_path");
    return path ? [{ kind: "file", value: path, operation: "read" }] : [];
  }
  if (toolName === "NotebookEdit") {
    const path = stringField(toolInput, "notebook_path");
    return path ? [{ kind: "file", value: path, operation: "write" }] : [];
  }
  if (CLAUDE_FILE_WRITE_TOOLS.has(toolName)) {
    const path = stringField(toolInput, "file_path");
    return path ? [{ kind: "file", value: path, operation: "write" }] : [];
  }
  if (toolName === "Glob" || toolName === "Grep") {
    const path = stringField(toolInput, "path");
    return path ? [{ kind: "path", value: path, operation: "read" }] : [];
  }
  if (toolName.startsWith("mcp__")) {
    // MCP arguments are allowlisted per known server/tool in core; the adapter
    // retains only the tool name here (hooks-contract.md §8).
    return [{ kind: "mcp", value: toolName, operation: "unknown" }];
  }
  return [{ kind: "other", value: toolName, operation: "unknown" }];
}

function finalize(
  candidate: unknown,
  ctx: NormalizationContext,
): Result<NormalizedEvent, IrohaError> {
  // Produce-then-validate: the adapter must never emit a normalized event the
  // rest of iroha would reject. A failure here is an adapter bug, not bad input.
  const parsed = normalizedEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new IrohaError("INTERNAL_ERROR", "adapter produced an invalid normalized event", {
        details: { issues: parsed.error.issues.length },
      }),
    );
  }
  void ctx;
  return ok(parsed.data);
}

function invalid(message: string): Result<never, IrohaError> {
  return err(new IrohaError("INVALID_INPUT", message));
}

/**
 * Parse one raw Claude Code hook input object into a normalized event.
 *
 * - `ok(event)` for a supported P0 event;
 * - `ok(null)` for a recognized-but-unmapped event (P1/P2 or non-product events);
 * - `err(INVALID_INPUT)` when required fields for a mapped event are missing/malformed.
 */
export function parseClaudeEvent(
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
      return finalize(
        { ...baseEvent(r.data, ctx), kind: "SESSION_STARTED", payload: { source: r.data.source } },
        ctx,
      );
    }
    case "UserPromptSubmit": {
      const r = rawUserPromptSubmit.safeParse(raw);
      if (!r.success) return invalid("invalid UserPromptSubmit input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "PROMPT_SUBMITTED",
          payload: { promptDigest: ctx.digest(r.data.prompt) },
        },
        ctx,
      );
    }
    case "PreToolUse": {
      const r = rawPreToolUse.safeParse(raw);
      if (!r.success) return invalid("invalid PreToolUse input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "TOOL_STARTED",
          payload: {
            toolName: r.data.tool_name,
            ...(r.data.tool_use_id === undefined ? {} : { toolUseId: r.data.tool_use_id }),
            phase: "pre",
            targets: extractClaudeTargets(r.data.tool_name, r.data.tool_input),
            inputDigest: ctx.digest(JSON.stringify(r.data.tool_input)),
            status: "started",
          },
        },
        ctx,
      );
    }
    case "PostToolUse": {
      const r = rawPostToolUse.safeParse(raw);
      if (!r.success) return invalid("invalid PostToolUse input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "TOOL_COMPLETED",
          payload: {
            toolName: r.data.tool_name,
            ...(r.data.tool_use_id === undefined ? {} : { toolUseId: r.data.tool_use_id }),
            phase: "post",
            targets: extractClaudeTargets(r.data.tool_name, r.data.tool_input),
            inputDigest: ctx.digest(JSON.stringify(r.data.tool_input)),
            ...(r.data.tool_response === undefined
              ? {}
              : { responseDigest: ctx.digest(JSON.stringify(r.data.tool_response)) }),
            status: "succeeded",
            ...(r.data.duration_ms === undefined ? {} : { durationMs: r.data.duration_ms }),
          },
        },
        ctx,
      );
    }
    case "PreCompact": {
      const r = rawPreCompact.safeParse(raw);
      if (!r.success) return invalid("invalid PreCompact input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "COMPACTION_STARTED",
          payload: { trigger: r.data.trigger },
        },
        ctx,
      );
    }
    case "PostCompact": {
      const r = rawPostCompact.safeParse(raw);
      if (!r.success) return invalid("invalid PostCompact input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "COMPACTION_COMPLETED",
          payload: {
            trigger: r.data.trigger,
            ...(r.data.compact_summary === undefined
              ? {}
              : { summaryDigest: ctx.digest(r.data.compact_summary) }),
          },
        },
        ctx,
      );
    }
    case "Stop": {
      const r = rawStop.safeParse(raw);
      if (!r.success) return invalid("invalid Stop input");
      return finalize(
        {
          ...baseEvent(r.data, ctx),
          kind: "TURN_STOPPED",
          payload: {
            stopHookActive: r.data.stop_hook_active,
            backgroundTaskCount: r.data.background_tasks?.length ?? 0,
            ...(r.data.last_assistant_message === undefined
              ? {}
              : { lastMessageDigest: ctx.digest(r.data.last_assistant_message) }),
          },
        },
        ctx,
      );
    }
    case "SessionEnd": {
      const r = rawSessionEnd.safeParse(raw);
      if (!r.success) return invalid("invalid SessionEnd input");
      return finalize(
        { ...baseEvent(r.data, ctx), kind: "SESSION_ENDED", payload: { reason: r.data.reason } },
        ctx,
      );
    }
    default:
      // Recognized transport, but not a P0 event iroha maps in v0.1
      // (PermissionRequest, SubagentStart/Stop, PostToolUseFailure, ...).
      return ok(null);
  }
}
