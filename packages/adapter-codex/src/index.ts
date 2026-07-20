/**
 * @iroha/adapter-codex — Codex input/output mapping.
 *
 * Maps Codex's raw hook I/O to and from iroha's normalized contracts. Structural
 * mapping only: repository-relative path resolution, HMAC digesting, and event
 * dispatch live in `@iroha/core`, which injects a `NormalizationContext`.
 */
import type { HookAdapter } from "@iroha/platform";
import { parseCodexEvent } from "./parse-event.js";
import { renderCodexOutput } from "./render-output.js";

export const packageName = "@iroha/adapter-codex";

export * from "./parse-event.js";
export * from "./render-output.js";

export const codexHookAdapter: HookAdapter = {
  platform: "codex",
  parseEvent: parseCodexEvent,
  renderOutput: renderCodexOutput,
};
