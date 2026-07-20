import { describe, expect, it } from "vitest";
import { formatSessionContext } from "./context.js";

describe("formatSessionContext", () => {
  it("includes the token, session, run, and the MCP checkpoint instruction", () => {
    const text = formatSessionContext({
      token: "ist_abc",
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      runId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(text.startsWith("[iroha]")).toBe(true);
    expect(text).toContain("session_token: ist_abc");
    expect(text).toContain("session: ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(text).toContain("run: run_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(text).toContain("Create a checkpoint");
    expect(text.trimEnd().endsWith("[/iroha]")).toBe(true);
    expect(text).not.toContain("Recent checkpoint");
  });

  it("renders a recent checkpoint with its unresolved line when present", () => {
    const text = formatSessionContext({
      token: "ist_abc",
      sessionId: "ses_x",
      runId: "run_x",
      recentCheckpoint: { id: "chk_1", summary: "wired the hook", unresolved: "cover Codex" },
    });
    expect(text).toContain("Recent checkpoint:");
    expect(text).toContain("- chk_1 — wired the hook");
    expect(text).toContain("unresolved: cover Codex");
  });

  it("renders the applicable approved knowledge section with ids and provenance", () => {
    const text = formatSessionContext({
      token: "ist_abc",
      sessionId: "ses_x",
      runId: "run_x",
      approvedKnowledge: [
        {
          id: "rul_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          title: "No direct edits to generated files",
          summary: "src/generated is owned by the codegen step",
          provenance: "why: path src/generated/**",
        },
      ],
    });
    expect(text).toContain("Applicable approved knowledge:");
    expect(text).toContain(
      "- rul_01ARZ3NDEKTSV4RRFFQ69G5FAV No direct edits to generated files — src/generated is owned by the codegen step (why: path src/generated/**)",
    );
  });

  it("bounds the output to 8000 characters", () => {
    const text = formatSessionContext({
      token: "ist_abc",
      sessionId: "ses_x",
      runId: "run_x",
      recentCheckpoint: { id: "chk_1", summary: "x".repeat(20000) },
    });
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});
