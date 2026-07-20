import type { IrohaError, NormalizedEvent, Result } from "@iroha/domain";
import type { HookOutput } from "./hook-output.js";

/** An `hmac-sha256:<64 hex>` digest string, as used throughout the normalized event. */
export type Digest = `hmac-sha256:${string}`;

/**
 * Structural target a tool acted on. Mirrors `$defs.target` in
 * schemas/normalized-event-v1.schema.json. Adapters extract these from raw hook
 * input by shape only; `@iroha/core` resolves `file`/`path` values to
 * repository-relative form after symlink-safe checks (it owns the filesystem and
 * Git access an adapter must not have).
 */
export interface ToolTarget {
  kind: "file" | "path" | "command" | "mcp" | "other";
  value: string;
  // `| undefined` mirrors the Zod-inferred normalized target (`.optional()`),
  // so an event's own `payload.targets` is assignable to `ToolTarget[]`.
  operation?: "read" | "write" | "delete" | "execute" | "unknown" | undefined;
}

/**
 * A safe, bounded classification of a shell command for a `command` tool target.
 * The full command is only ever kept as a digest; this value must never carry a
 * secret or an absolute path (hooks-contract.md §8/§10). Shared by both adapters
 * so the two extractors cannot drift.
 *
 * It takes the leading whitespace token, drops any leading directory (so
 * `/Users/alice/bin/deploy.sh` → `deploy.sh`, never leaking a username or
 * layout), and collapses anything that is not a bare program name — most
 * importantly an `VAR=secret cmd` env-assignment prefix, whose leading token is
 * `VAR=secret` — to the generic label `command`. The full command survives only
 * as the tool event's `inputDigest`.
 */
export function classifyCommandTarget(command: string): string {
  const leading = command.trim().split(/\s+/)[0] ?? "";
  // An env-assignment prefix (`VAR=value`) is never a program name — collapse it
  // *before* any path handling, because the assigned value can itself contain a
  // `/` whose tail would otherwise pass the bare-name check and leak.
  if (leading.length === 0 || leading.includes("=")) {
    return "command";
  }
  const base = leading.split(/[/\\]/).pop() ?? "";
  return /^[A-Za-z0-9._-]+$/.test(base) ? base : "command";
}

/**
 * Everything an adapter needs to finalize a normalized event but cannot compute
 * itself: repository-keyed HMAC digesting (the salt lives in `@iroha/git`, which
 * adapters may not depend on), a fresh event id, and the event timestamp.
 * `@iroha/core` supplies the concrete implementation; tests supply a fake.
 */
export interface NormalizationContext {
  /** Repository-keyed HMAC-SHA-256 of `value`, returned as `hmac-sha256:<hex>`. */
  digest(value: string): Digest;
  /** A fresh `evt_<ULID>` identifier. */
  newEventId(): string;
  /** The event time as an ISO-8601 UTC string ending in `Z`. */
  occurredAt(): string;
}

/**
 * Maps one platform's raw hook I/O to and from iroha's normalized contracts.
 * `@iroha/core` selects an implementation by the `<claude|codex>` entrypoint
 * argument and treats both uniformly.
 */
export interface HookAdapter {
  readonly platform: NormalizedEvent["platform"];
  /**
   * Parse one raw hook input object into a normalized event. Known required
   * fields are validated; unknown fields are ignored — raw platform schemas are
   * forward-compatible (hooks-contract.md §2). Returns:
   * - `ok(event)` for a supported event;
   * - `ok(null)` for a recognized event with no v0.1 normalized mapping (ignore it);
   * - `err(INVALID_INPUT)` for a structurally unusable payload.
   */
  parseEvent(raw: unknown, ctx: NormalizationContext): Result<NormalizedEvent | null, IrohaError>;
  /**
   * Render a normalized hook output to this platform's stdout JSON string, or
   * `undefined` when the event needs no model-visible output (write nothing).
   */
  renderOutput(output: HookOutput, event: NormalizedEvent): string | undefined;
}
