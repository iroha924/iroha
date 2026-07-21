import type { ToolTarget } from "@iroha/platform";
import type { ActiveRuleRow } from "@iroha/storage";
import { describe, expect, it } from "vitest";
import { classifyGuardSpec, evaluateGuardrails, guardrailPathViolations } from "./guardrail.js";

function guardrailRule(id: string, guard: { tools: string[]; paths: string[] }): ActiveRuleRow {
  return {
    id,
    title: "Do not edit generated files",
    summary: null,
    enforcement: "guardrail",
    scopeJson: JSON.stringify({ paths: guard.paths, symbols: [] }),
    guardSpecJson: JSON.stringify(guard),
    canonicalPath: `rules/${id}.md`,
  };
}

function target(value: string, operation: ToolTarget["operation"]): ToolTarget {
  return { kind: "file", value, operation };
}

const GENERATED_GUARD = guardrailRule("rul_gen", {
  tools: ["Edit", "Write"],
  paths: ["src/generated/**"],
});

describe("evaluateGuardrails", () => {
  it("denies a write under a protected path and reports the matched target", () => {
    const denial = evaluateGuardrails(
      [GENERATED_GUARD],
      [target("src/generated/client.ts", "write")],
    );
    expect(denial).not.toBeNull();
    expect(denial?.ruleId).toBe("rul_gen");
    expect(denial?.reason).toBe("Do not edit generated files");
    expect(denial?.target.value).toBe("src/generated/client.ts");
  });

  it("denies regardless of which write tool produced the target (tool-agnostic)", () => {
    // `guard.tools` is ["Edit","Write"], but a MultiEdit/NotebookEdit/apply_patch
    // write also resolves to operation "write" — it must not bypass the guard.
    const patch = [target("src/app/main.ts", "write"), target("src/generated/client.ts", "delete")];
    const denial = evaluateGuardrails([GENERATED_GUARD], patch);
    expect(denial?.target.value).toBe("src/generated/client.ts");
  });

  it("allows a write to an unrelated path", () => {
    expect(
      evaluateGuardrails([GENERATED_GUARD], [target("src/payments/service.ts", "write")]),
    ).toBeNull();
  });

  it("allows a read of a protected path", () => {
    expect(
      evaluateGuardrails([GENERATED_GUARD], [target("src/generated/client.ts", "read")]),
    ).toBeNull();
  });

  it("never denies on an advisory rule", () => {
    const advisory: ActiveRuleRow = {
      ...GENERATED_GUARD,
      enforcement: "advisory",
      guardSpecJson: null,
    };
    expect(evaluateGuardrails([advisory], [target("src/generated/client.ts", "write")])).toBeNull();
  });

  it("fails open on a corrupt guard spec", () => {
    const corrupt: ActiveRuleRow = { ...GENERATED_GUARD, guardSpecJson: "{not json" };
    expect(evaluateGuardrails([corrupt], [target("src/generated/client.ts", "write")])).toBeNull();
  });

  it("does not deny a guard that protects no paths", () => {
    const noPaths = guardrailRule("rul_cmd", { tools: ["Bash"], paths: [] });
    expect(evaluateGuardrails([noPaths], [target("src/generated/client.ts", "write")])).toBeNull();
  });
});

describe("classifyGuardSpec", () => {
  it("is enforceable with tools and paths", () => {
    expect(
      classifyGuardSpec(JSON.stringify({ tools: ["Edit"], paths: ["src/generated/**"] })),
    ).toBe("enforceable");
  });

  it("is not_hook_enforceable with no paths (command/deny_commands-scoped)", () => {
    expect(classifyGuardSpec(JSON.stringify({ tools: ["Bash"], paths: [] }))).toBe(
      "not_hook_enforceable",
    );
  });

  it("is invalid for null, malformed JSON, or empty tools", () => {
    expect(classifyGuardSpec(null)).toBe("invalid");
    expect(classifyGuardSpec("{not json")).toBe("invalid");
    expect(classifyGuardSpec(JSON.stringify({ tools: [], paths: ["x"] }))).toBe("invalid");
  });
});

describe("guardrailPathViolations", () => {
  it("flags a changed path under a protected glob, independent of any tool", () => {
    const violations = guardrailPathViolations(
      [GENERATED_GUARD],
      ["src/generated/client.ts", "src/payments/service.ts"],
    );
    expect(violations).toEqual([{ ruleId: "rul_gen", path: "src/generated/client.ts" }]);
  });

  it("returns nothing when no path matches", () => {
    expect(guardrailPathViolations([GENERATED_GUARD], ["README.md"])).toEqual([]);
  });
});
