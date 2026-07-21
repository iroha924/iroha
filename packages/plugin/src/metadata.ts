/**
 * Shared plugin metadata. Both the Claude and the Codex manifest are generated
 * from this single source (compatibility.md §10: "produced at build time from
 * shared metadata and validated independently"), so the two platforms can never
 * drift on name, version, or component wiring.
 */

/** Product name; also the plugin identifier and the npm binary (ID-011). */
export const PLUGIN_NAME = "iroha";

/** Published npm package the marketplaces resolve the plugin from (ID-011). */
export const PUBLISHED_PACKAGE_NAME = "@iroha-labs/iroha";

/**
 * Product version. Kept in lockstep with `packages/plugin/package.json` — a unit
 * test asserts equality, and WP-11b's release workflow additionally gates
 * package/manifest/changelog/tag agreement (compatibility.md §13).
 */
export const PLUGIN_VERSION = "0.1.0";

export const PLUGIN_DESCRIPTION = "Local-first Engineering Memory Graph for Claude Code and Codex.";

/** Publisher (product invariant). */
export const PLUGIN_AUTHOR = { name: "iroha labs" } as const;

/** SPDX license id (decision-log ID-019, chosen before first release). */
export const PLUGIN_LICENSE = "Apache-2.0";

/** Canonical source repository (also the homepage in the absence of a docs site). */
export const PLUGIN_REPOSITORY = "https://github.com/iroha924/iroha";
export const PLUGIN_HOMEPAGE = "https://github.com/iroha924/iroha";

export const PLUGIN_KEYWORDS = [
  "memory",
  "knowledge-graph",
  "engineering",
  "claude-code",
  "codex",
] as const;

/**
 * The installed npm binary the plugin drives (Option A, decision-log ID-038):
 * hooks and the MCP server run through `iroha`, which npm resolves together with
 * its native `@libsql/client` binding — the plugin archive ships no runtime `dist`.
 */
export const BINARY_NAME = "iroha";

/** Internal subcommand: `iroha __hook <claude|codex>` runs one hook invocation. */
export const HOOK_SUBCOMMAND = "__hook";

/** Internal subcommand: `iroha __mcp` starts the stdio MCP server. */
export const MCP_SUBCOMMAND = "__mcp";

export interface HookEventSpec {
  /** Platform lifecycle event name (identical string on Claude and Codex). */
  readonly event: string;
  /**
   * Manifest hook timeout, in whole seconds. A ceiling ≥ the hooks-contract.md
   * §7 hook budget for the event (the internal p95 targets are far smaller); the
   * hook is fail-open on its own, so this only bounds a pathological hang.
   */
  readonly timeoutSeconds: number;
}

/**
 * The P0 hook events iroha subscribes to on both platforms (hooks-contract.md
 * §3). Codex lacks `SessionEnd`, which iroha's P0 set does not use, so this list
 * is portable as-is. Every event dispatches the same `iroha __hook <platform>`
 * command; the hook discriminates internally on the stdin `hook_event_name`.
 */
export const HOOK_EVENTS: readonly HookEventSpec[] = [
  { event: "SessionStart", timeoutSeconds: 3 },
  { event: "UserPromptSubmit", timeoutSeconds: 2 },
  { event: "PreToolUse", timeoutSeconds: 1 },
  { event: "PostToolUse", timeoutSeconds: 1 },
  { event: "PreCompact", timeoutSeconds: 1 },
  { event: "PostCompact", timeoutSeconds: 1 },
  { event: "Stop", timeoutSeconds: 2 },
];

/**
 * Shared Skills (implementation-plan.md WP-11). Each is a `skills/<name>/SKILL.md`
 * with `name` + `description` frontmatter only, so the one directory is valid for
 * both Claude (`/iroha:<name>`) and Codex (`$<name>`; Codex documents no richer
 * frontmatter and no plugin namespace — the CLI is the reliable fallback).
 */
export const SKILL_NAMES = ["init", "sync", "search", "checkpoint", "dashboard", "doctor"] as const;
