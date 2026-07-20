import { describe, expect, it } from "vitest";
import { err, IrohaError, isErr, normalizedEventSchema, ok } from "./index.js";

// These re-exports are the load-bearing contract of this package: the adapter
// packages may import them only through `@iroha/platform` (compatibility.md §4),
// so a broken barrel silently forces adapters to reach into `@iroha/domain`.

const validSessionStarted = {
  schemaVersion: 1,
  eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  platform: "claude_code",
  kind: "SESSION_STARTED",
  occurredAt: "2026-07-20T00:00:00.000Z",
  platformSessionId: "sess-1",
  cwdFingerprint: `hmac-sha256:${"a".repeat(64)}`,
  payload: { source: "startup" },
};

describe("re-exported normalized event schema", () => {
  it("validates a well-formed normalized event", () => {
    const result = normalizedEventSchema.safeParse(validSessionStarted);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown top-level field (strict)", () => {
    const result = normalizedEventSchema.safeParse({ ...validSessionStarted, extra: true });
    expect(result.success).toBe(false);
  });
});

describe("re-exported Result / IrohaError model", () => {
  it("wraps an IrohaError in an err Result", () => {
    const result = err(new IrohaError("INVALID_INPUT", "bad"));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("wraps a value in an ok Result", () => {
    expect(ok(42)).toStrictEqual({ ok: true, value: 42 });
  });
});
