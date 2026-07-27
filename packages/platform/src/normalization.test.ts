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

  it("names the command after a leading chdir, not the chdir", () => {
    // Agents prefix most commands with `cd <repo>`, so the leading token was `cd`
    // for every one of them.
    expect(classifyCommandTarget("cd /Users/alice/repo; git status")).toBe("git");
    expect(classifyCommandTarget("cd /repo && pnpm test")).toBe("pnpm");
    expect(classifyCommandTarget("cd /repo ; rm -rf dist")).toBe("rm");
  });

  it("keeps `cd` when the directory is not a plain single token", () => {
    // The claim is that no fragment of the path can reach the label. A path with a
    // space, a quote or a separator must therefore fail to match and fall back —
    // these are the shapes that would break it, not ones that already work.
    expect(classifyCommandTarget("cd '/repo; rm -rf x' && ls")).toBe("cd");
    expect(classifyCommandTarget('cd "/My Repo" && ls')).toBe("cd");
    expect(classifyCommandTarget("cd /My Repo && ls")).toBe("cd");
  });

  it("does not let the chdir skip expose what the leading token hid", () => {
    // Whatever follows the chdir goes through the same env-prefix and bare-name
    // checks as a first token would.
    expect(classifyCommandTarget("cd /repo; API_TOKEN=s3cret pnpm test")).toBe("command");
    expect(classifyCommandTarget("cd /repo && /Users/alice/bin/deploy.sh")).toBe("deploy.sh");
    expect(classifyCommandTarget("cd /repo && $(cat evil)")).toBe("command");
    // An unexpanded directory is skipped like any other, and the label names the
    // program that follows — `ls`, not any part of the variable.
    expect(classifyCommandTarget("cd $SECRET_DIR && ls")).toBe("ls");
  });

  it("collapses anything else that is not a bare program name", () => {
    expect(classifyCommandTarget("")).toBe("command");
    expect(classifyCommandTarget("   ")).toBe("command");
    expect(classifyCommandTarget("$(cat secret)")).toBe("command");
  });
});
