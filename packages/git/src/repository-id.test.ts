import { FixedClock, FixedRandomSource } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { generateRepositoryId, parseRepositoryId } from "./repository-id.js";

describe("generateRepositoryId", () => {
  it("generates a repo_-prefixed ULID that round-trips through parseRepositoryId", () => {
    const clock = new FixedClock(new Date("2026-07-18T00:00:00.000Z"));
    const random = new FixedRandomSource(new Uint8Array(16).fill(7));

    const id = generateRepositoryId(clock, random);

    expect(id.startsWith("repo_")).toBe(true);
    expect(parseRepositoryId(id)).toEqual({ ok: true, value: id });
  });

  it("rejects a value with the wrong prefix", () => {
    const result = parseRepositoryId("act_01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});
