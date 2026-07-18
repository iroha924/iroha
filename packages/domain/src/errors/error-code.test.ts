import { describe, expect, it } from "vitest";
import { ERROR_CODES, IrohaError, isErrorCode } from "./error-code.js";

describe("isErrorCode", () => {
  it("accepts every declared error code", () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isErrorCode("NOT_A_REAL_CODE")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});

describe("IrohaError", () => {
  it("defaults retryable to false and omits details", () => {
    const error = new IrohaError("NOT_FOUND", "missing");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("missing");
    expect(error.retryable).toBe(false);
    expect(error.details).toBeUndefined();
  });

  it("carries retryable and details when provided", () => {
    const error = new IrohaError("DB_BUSY", "locked", {
      retryable: true,
      details: { repositoryId: "repo_x" },
    });
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ repositoryId: "repo_x" });
  });

  it("is an instance of Error", () => {
    const error = new IrohaError("INTERNAL_ERROR", "boom");
    expect(error).toBeInstanceOf(Error);
  });
});
