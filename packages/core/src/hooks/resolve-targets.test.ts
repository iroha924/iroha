import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolTarget } from "@iroha/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTargets } from "./resolve-targets.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iroha-resolve-targets-"));
  await mkdir(join(root, "src", "payments"), { recursive: true });
  await writeFile(join(root, "src", "payments", "service.ts"), "export const x = 1;\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveTargets", () => {
  it("rewrites an absolute file target to a POSIX repo-relative path", async () => {
    const targets: ToolTarget[] = [
      { kind: "file", value: join(root, "src", "payments", "service.ts"), operation: "write" },
    ];
    expect(await resolveTargets(targets, root)).toStrictEqual([
      { kind: "file", value: "src/payments/service.ts", operation: "write" },
    ]);
  });

  it("rewrites a cwd-relative file target to a repo-relative path", async () => {
    const targets: ToolTarget[] = [
      { kind: "file", value: "src/payments/service.ts", operation: "read" },
    ];
    expect(await resolveTargets(targets, root)).toStrictEqual([
      { kind: "file", value: "src/payments/service.ts", operation: "read" },
    ]);
  });

  it("drops a target that escapes the repository root", async () => {
    const targets: ToolTarget[] = [{ kind: "file", value: "../outside.ts", operation: "write" }];
    expect(await resolveTargets(targets, root)).toStrictEqual([]);
  });

  it("passes command/mcp/other targets through unchanged", async () => {
    const targets: ToolTarget[] = [
      { kind: "command", value: "pnpm", operation: "execute" },
      { kind: "mcp", value: "mcp__iroha__search", operation: "unknown" },
      { kind: "other", value: "apply_patch", operation: "write" },
    ];
    expect(await resolveTargets(targets, root)).toStrictEqual(targets);
  });
});
