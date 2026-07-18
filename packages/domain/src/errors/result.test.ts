import { describe, expect, it } from "vitest";
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from "./result.js";

describe("ok/err", () => {
  it("constructs a success result", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("constructs a failure result", () => {
    const result = err("boom");
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

describe("isOk/isErr", () => {
  it("narrows a success result", () => {
    const result = ok(1);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it("narrows a failure result", () => {
    const result = err("boom");
    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
  });
});

describe("map", () => {
  it("transforms the value of a success result", () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
  });

  it("passes a failure result through unchanged", () => {
    expect(map(err("boom"), (n: number) => n * 2)).toEqual(err("boom"));
  });
});

describe("mapErr", () => {
  it("transforms the error of a failure result", () => {
    expect(mapErr(err("boom"), (e) => e.toUpperCase())).toEqual(err("BOOM"));
  });

  it("passes a success result through unchanged", () => {
    expect(mapErr(ok(1), (e: string) => e.toUpperCase())).toEqual(ok(1));
  });
});

describe("andThen", () => {
  it("chains successful results", () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err("odd"));
    expect(andThen(ok(4), half)).toEqual(ok(2));
  });

  it("short-circuits on the first failure", () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err("odd"));
    expect(andThen(ok(3), half)).toEqual(err("odd"));
    expect(andThen(err("prior"), half)).toEqual(err("prior"));
  });
});

describe("unwrapOr", () => {
  it("returns the value on success", () => {
    expect(unwrapOr(ok(1), 0)).toBe(1);
  });

  it("returns the fallback on failure", () => {
    expect(unwrapOr(err("boom"), 0)).toBe(0);
  });
});
