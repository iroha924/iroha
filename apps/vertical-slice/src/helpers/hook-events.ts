/**
 * Raw platform Hook payload builders, mirroring the exact shapes the adapter
 * unit tests use (packages/adapter-claude, packages/adapter-codex). They feed
 * `runHook({ platform, raw, cwd }, deps)` so the slice drives the real
 * adapter → normalize → dispatch path rather than synthetic normalized events.
 */

interface ToolInput {
  [key: string]: unknown;
}

// --- Claude Code raw payloads (discriminated by hook_event_name) ---

export function claudeSessionStart(cwd: string, sessionId: string, source = "startup") {
  return { cwd, session_id: sessionId, hook_event_name: "SessionStart", source };
}

export function claudePrompt(cwd: string, sessionId: string, prompt: string, promptId: string) {
  return {
    cwd,
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt,
    prompt_id: promptId,
  };
}

export function claudePreTool(
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: ToolInput,
  toolUseId: string,
) {
  return {
    cwd,
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

export function claudePostTool(
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: ToolInput,
  toolResponse: unknown,
  toolUseId: string,
  durationMs: number,
) {
  return {
    cwd,
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseId,
    duration_ms: durationMs,
  };
}

export function claudeStop(cwd: string, sessionId: string, stopHookActive = false) {
  return { cwd, session_id: sessionId, hook_event_name: "Stop", stop_hook_active: stopHookActive };
}

// --- Codex raw payloads (turn_id instead of prompt_id/tool_use_id) ---

function codexCommon(cwd: string, sessionId: string) {
  return { session_id: sessionId, cwd, transcript_path: null, model: "gpt-5-codex" };
}

export function codexSessionStart(cwd: string, sessionId: string, source = "startup") {
  return { ...codexCommon(cwd, sessionId), hook_event_name: "SessionStart", source };
}

export function codexPrompt(cwd: string, sessionId: string, prompt: string, turnId: string) {
  return {
    ...codexCommon(cwd, sessionId),
    hook_event_name: "UserPromptSubmit",
    turn_id: turnId,
    prompt,
  };
}

export function codexPreTool(
  cwd: string,
  sessionId: string,
  turnId: string,
  toolName: string,
  toolInput: ToolInput,
) {
  return {
    ...codexCommon(cwd, sessionId),
    hook_event_name: "PreToolUse",
    turn_id: turnId,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

export function codexPostTool(
  cwd: string,
  sessionId: string,
  turnId: string,
  toolName: string,
  toolInput: ToolInput,
  toolResponse: unknown,
) {
  return {
    ...codexCommon(cwd, sessionId),
    hook_event_name: "PostToolUse",
    turn_id: turnId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  };
}

/** Extract the `ist_…` session token a SessionStart hook emits in its context block. */
export function tokenFromSessionStart(stdout: string | undefined): string | undefined {
  if (stdout === undefined) {
    return undefined;
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  const context = parsed.hookSpecificOutput?.additionalContext ?? "";
  return /session_token:\s*(ist_[A-Za-z0-9_-]{43})/.exec(context)?.[1];
}

/** The context block a SessionStart hook emits, or `""` when there is no output. */
export function contextFromSessionStart(stdout: string | undefined): string {
  if (stdout === undefined) {
    return "";
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}
