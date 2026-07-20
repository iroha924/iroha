/**
 * @iroha/adapter-claude — Claude Code input/output mapping.
 *
 * Maps Claude Code's raw hook I/O to and from iroha's normalized contracts.
 * Structural mapping only: repository-relative path resolution, HMAC digesting,
 * and event dispatch live in `@iroha/core`, which injects a `NormalizationContext`.
 */
import type { HookAdapter } from "@iroha/platform";
import { parseClaudeEvent } from "./parse-event.js";
import { renderClaudeOutput } from "./render-output.js";

export const packageName = "@iroha/adapter-claude";

export * from "./parse-event.js";
export * from "./render-output.js";

export const claudeHookAdapter: HookAdapter = {
  platform: "claude_code",
  parseEvent: parseClaudeEvent,
  renderOutput: renderClaudeOutput,
};
