import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("package skeleton", () => {
  it("exposes the package name", () => {
    expect(packageName).toBe("@iroha/git");
  });
});
