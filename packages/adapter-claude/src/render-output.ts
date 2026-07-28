import type { HookOutput, NormalizedEvent } from "@iroha/platform";
import { match } from "ts-pattern";

/**
 * The Claude Code hook event name to stamp into `hookSpecificOutput` for a
 * context injection. Only SessionStart and UserPromptSubmit accept
 * `additionalContext`, so only their normalized kinds map here.
 */
function contextEventName(kind: NormalizedEvent["kind"]): string | undefined {
  switch (kind) {
    case "SESSION_STARTED":
      return "SessionStart";
    case "PROMPT_SUBMITTED":
      return "UserPromptSubmit";
    // Stop accepts `additionalContext` too, which is how §6.6's suggestion path
    // reaches the agent without a `decision: block` continuation.
    case "TURN_STOPPED":
      return "Stop";
    default:
      return undefined;
  }
}

/**
 * Render a normalized hook output to Claude Code's stdout JSON string, or
 * `undefined` when nothing should be written (contracts/hooks.md §6/§9). Output
 * shapes are verbatim from the official Claude Code hooks documentation.
 */
export function renderClaudeOutput(output: HookOutput, event: NormalizedEvent): string | undefined {
  return (
    match(output)
      .with({ kind: "none" }, () => undefined)
      .with({ kind: "context" }, (o) => {
        const hookEventName = contextEventName(event.kind);
        if (hookEventName === undefined) {
          return undefined;
        }
        return JSON.stringify({
          hookSpecificOutput: { hookEventName, additionalContext: o.additionalContext },
        });
      })
      .with({ kind: "deny" }, (o) =>
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Blocked by iroha rule ${o.ruleId}: ${o.reason}`,
          },
        }),
      )
      .with({ kind: "continuation" }, (o) =>
        JSON.stringify({ decision: "block", reason: o.reason }),
      )
      // `.exhaustive()`: a new HookOutput kind becomes a compile error here, not a
      // silent `undefined` fall-through (the switch had no default).
      .exhaustive()
  );
}
