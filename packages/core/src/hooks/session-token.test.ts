import { describe, expect, it } from "vitest";
import { hashSessionToken } from "./session-token.js";

const saltA = new Uint8Array(32).fill(1);
const saltB = new Uint8Array(32).fill(2);

describe("hashSessionToken", () => {
  it("produces a well-formed hmac-sha256 digest", () => {
    expect(hashSessionToken(saltA, "ist_abc")).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  });

  it("is deterministic for the same token and salt", () => {
    expect(hashSessionToken(saltA, "ist_abc")).toBe(hashSessionToken(saltA, "ist_abc"));
  });

  it("differs by token and by repository salt", () => {
    expect(hashSessionToken(saltA, "ist_abc")).not.toBe(hashSessionToken(saltA, "ist_def"));
    expect(hashSessionToken(saltA, "ist_abc")).not.toBe(hashSessionToken(saltB, "ist_abc"));
  });
});
