import { LibsqlError } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { mapLibsqlError } from "./errors.js";

describe("mapLibsqlError", () => {
  it("maps SQLITE_BUSY to a retryable DB_BUSY error", () => {
    const cause = new LibsqlError("database is locked", "SQLITE_BUSY");

    const error = mapLibsqlError(cause);

    expect(error.code).toBe("DB_BUSY");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it("maps a constraint violation to CONFLICT", () => {
    const cause = new LibsqlError(
      "UNIQUE constraint failed: entities.id",
      "SQLITE_CONSTRAINT_UNIQUE",
    );

    const error = mapLibsqlError(cause);

    expect(error.code).toBe("CONFLICT");
  });

  it("maps SQLITE_CANTOPEN to DB_UNAVAILABLE", () => {
    const cause = new LibsqlError("unable to open database file", "SQLITE_CANTOPEN");

    const error = mapLibsqlError(cause);

    expect(error.code).toBe("DB_UNAVAILABLE");
  });

  it("maps an unrecognized libSQL error code to INTERNAL_ERROR", () => {
    const cause = new LibsqlError("something else went wrong", "SQLITE_MISUSE");

    const error = mapLibsqlError(cause);

    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("maps a non-LibsqlError cause to INTERNAL_ERROR", () => {
    const error = mapLibsqlError(new Error("plain error"));

    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("never puts the raw LibsqlError message into its own message", () => {
    // A constraint error's raw message can include table/column identifiers;
    // mcp-contract.md §4 forbids returning raw SQL to the model, so the
    // mapped error must carry its own generic message instead.
    const cause = new LibsqlError(
      "UNIQUE constraint failed: entities.id",
      "SQLITE_CONSTRAINT_UNIQUE",
    );

    const error = mapLibsqlError(cause);

    expect(error.message.includes("entities.id")).toBe(false);
  });
});
