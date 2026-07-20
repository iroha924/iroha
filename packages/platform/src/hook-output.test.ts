import { describe, expect, it } from "vitest";
import {
  contextOutput,
  continuationOutput,
  denyOutput,
  type HookOutput,
  noOutput,
} from "./hook-output.js";

describe("hook output constructors", () => {
  it("noOutput is the empty side-effect-only variant", () => {
    expect(noOutput).toStrictEqual({ kind: "none" } satisfies HookOutput);
  });

  it("contextOutput carries the bounded additional context", () => {
    expect(contextOutput("[iroha]\n...")).toStrictEqual({
      kind: "context",
      additionalContext: "[iroha]\n...",
    } satisfies HookOutput);
  });

  it("denyOutput carries the rule id and reason", () => {
    expect(
      denyOutput("rul_01ARZ3NDEKTSV4RRFFQ69G5FAV", "generated files are read-only"),
    ).toStrictEqual({
      kind: "deny",
      ruleId: "rul_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      reason: "generated files are read-only",
    } satisfies HookOutput);
  });

  it("continuationOutput carries the continuation reason", () => {
    expect(continuationOutput("Save an iroha checkpoint")).toStrictEqual({
      kind: "continuation",
      reason: "Save an iroha checkpoint",
    } satisfies HookOutput);
  });
});
