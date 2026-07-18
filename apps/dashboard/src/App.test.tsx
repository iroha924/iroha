import { describe, expect, it } from "vitest";
import { App } from "@/App.js";

describe("@ path alias", () => {
  it("resolves through vitest, matching the tsconfig/vite.config alias", () => {
    expect(typeof App).toBe("function");
  });
});
