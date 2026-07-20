import { describe, expect, it } from "vitest";
import { classifyCommandTarget } from "./normalization.js";

describe("classifyCommandTarget", () => {
  it("keeps a bare program name", () => {
    expect(classifyCommandTarget("pnpm test payments --filter x")).toBe("pnpm");
    expect(classifyCommandTarget("git commit -m 'x'")).toBe("git");
    expect(classifyCommandTarget("python3.11 script.py")).toBe("python3.11");
  });

  it("reduces an absolute or relative program path to its basename (no path leak)", () => {
    expect(classifyCommandTarget("/Users/alice/bin/deploy.sh --prod")).toBe("deploy.sh");
    expect(classifyCommandTarget("./scripts/run.sh")).toBe("run.sh");
    expect(classifyCommandTarget("C:\\Users\\bob\\tool.exe")).toBe("tool.exe");
  });

  it("collapses an env-assignment prefix to the generic label (never leaks the secret)", () => {
    // The leading token is the credential itself; it must not survive as the value.
    expect(classifyCommandTarget("GITHUB_TOKEN=ghp_notARealSecret gh api /user")).toBe("command");
    expect(classifyCommandTarget("AWS_SECRET_ACCESS_KEY=abc/def aws s3 ls")).toBe("command");
  });

  it("collapses anything else that is not a bare program name", () => {
    expect(classifyCommandTarget("")).toBe("command");
    expect(classifyCommandTarget("   ")).toBe("command");
    expect(classifyCommandTarget("$(cat secret)")).toBe("command");
  });
});
