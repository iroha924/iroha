import type { HookOutput, NormalizedEvent } from "@iroha/platform";

/**
 * The Codex hook event name to stamp into `hookSpecificOutput` for a context
 * injection. Codex accepts `additionalContext` on SessionStart/UserPromptSubmit
 * (among others); only their normalized kinds map here.
 */
function contextEventName(kind: NormalizedEvent["kind"]): string | undefined {
  switch (kind) {
    case "SESSION_STARTED":
      return "SessionStart";
    case "PROMPT_SUBMITTED":
      return "UserPromptSubmit";
    default:
      return undefined;
  }
}

/**
 * Render a normalized hook output to Codex's stdout JSON string, or `undefined`
 * when nothing should be written. Codex uses the same output key names as Claude
 * Code for deny/additionalContext/continuation; Stop/SubagentStop require JSON
 * (never plain text). Shapes are verbatim from the official Codex hooks docs.
 */
export function renderCodexOutput(output: HookOutput, event: NormalizedEvent): string | undefined {
  switch (output.kind) {
    case "none":
      return undefined;
    case "context": {
      const hookEventName = contextEventName(event.kind);
      if (hookEventName === undefined) {
        return undefined;
      }
      return JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: output.additionalContext },
      });
    }
    case "deny":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Blocked by iroha rule ${output.ruleId}: ${output.reason}`,
        },
      });
    case "continuation":
      return JSON.stringify({ decision: "block", reason: output.reason });
  }
}
