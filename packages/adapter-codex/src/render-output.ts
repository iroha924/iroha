import type { HookOutput, NormalizedEvent } from "@iroha/platform";
import { match } from "ts-pattern";

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
    // §6.6's suggestion path. Verified against the official docs for Claude
    // Code, which documents `additionalContext` on Stop; mirrored here on the
    // same key names this adapter already shares, but **not** verified against
    // Codex's own documentation. If Codex ignores the field the suggestion is
    // simply not delivered, which is the same outcome as omitting the case —
    // so mirroring costs nothing and omitting would leave a command-only Turn
    // with neither a block nor a reminder.
    case "TURN_STOPPED":
      return "Stop";
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
