import { describe, expect, it } from "vitest";
import { classifyCommandTarget, isBuildTestOrMigrationCommand } from "./normalization.js";

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

describe("isBuildTestOrMigrationCommand", () => {
  // The rule contracts/hooks.md §6.6 actually states is "a build/test/migration
  // command ran". The dispatcher used to treat *any* command as qualifying, so a
  // turn that only polled a URL had its stop blocked for a Checkpoint and the
  // record filled with near-empty entries.
  it("does not treat a read-only command as build/test/migration", () => {
    for (const command of ["curl", "git", "ls", "cat", "grep", "sed", "echo", "sqlite3"]) {
      expect(isBuildTestOrMigrationCommand(command), command).toBe(false);
    }
  });

  it("recognizes the runners a build, test or migration actually goes through", () => {
    for (const command of [
      "pnpm",
      "npm",
      "yarn",
      "bun",
      "npx",
      "turbo",
      "vitest",
      "cargo",
      "go",
      "make",
      "tsc",
    ]) {
      expect(isBuildTestOrMigrationCommand(command), command).toBe(true);
    }
  });

  // `classifyCommandTarget` keeps only the program name — arguments live in the
  // digest — so a runner qualifies whatever subcommand followed it.
  it("matches the classified program name, which is all that survives", () => {
    expect(isBuildTestOrMigrationCommand(classifyCommandTarget("pnpm test --run"))).toBe(true);
    expect(
      isBuildTestOrMigrationCommand(classifyCommandTarget("curl -s https://example.com")),
    ).toBe(false);
    // An env-assignment prefix collapses to the generic label, which must not match.
    expect(isBuildTestOrMigrationCommand(classifyCommandTarget("CI=1 pnpm test"))).toBe(false);
  });
});
