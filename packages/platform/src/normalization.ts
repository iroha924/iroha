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
  operation?: "read" | "write" | "delete" | "execute" | "unknown";
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
