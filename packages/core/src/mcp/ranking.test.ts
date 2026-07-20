import { describe, expect, it } from "vitest";
import { pathMatches } from "./ranking.js";

describe("pathMatches", () => {
  it("matches a /** scope within the directory boundary but not a sibling prefix", () => {
    expect(pathMatches("src/**", "src/payments/service.ts")).toBe(true);
    // Regression: stripping the boundary "/" made "src/**" over-match "src-generated/*".
    expect(pathMatches("src/**", "src-generated/foo.ts")).toBe(false);
    expect(pathMatches("packages/git/**", "packages/github/actions.ts")).toBe(false);
  });

  it("matches a /* scope by prefix within the boundary", () => {
    expect(pathMatches("src/*", "src/app.ts")).toBe(true);
    expect(pathMatches("src/*", "src-generated/foo.ts")).toBe(false);
  });

  it("matches a bare path as itself or a child, not a sibling prefix", () => {
    expect(pathMatches("src/app.ts", "src/app.ts")).toBe(true);
    expect(pathMatches("src/payments", "src/payments/service.ts")).toBe(true);
    expect(pathMatches("src/pay", "src/payments/service.ts")).toBe(false);
  });
});
