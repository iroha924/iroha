/**
 * Platform-independent description of what a hook wants to emit. Adapters render
 * it to each platform's concrete stdout JSON (hooks-contract.md §6/§9):
 *
 * - `none` — a successful side-effect-only event; write nothing to stdout;
 * - `context` — bounded `additionalContext` injected at SessionStart/UserPromptSubmit;
 * - `deny` — a PreToolUse Guardrail denial (rule id + human-readable reason);
 * - `continuation` — a single Stop continuation request.
 */
export type HookOutput =
  | { readonly kind: "none" }
  | { readonly kind: "context"; readonly additionalContext: string }
  | { readonly kind: "deny"; readonly ruleId: string; readonly reason: string }
  | { readonly kind: "continuation"; readonly reason: string };

export const noOutput: HookOutput = { kind: "none" };

export function contextOutput(additionalContext: string): HookOutput {
  return { kind: "context", additionalContext };
}

export function denyOutput(ruleId: string, reason: string): HookOutput {
  return { kind: "deny", ruleId, reason };
}

export function continuationOutput(reason: string): HookOutput {
  return { kind: "continuation", reason };
}
