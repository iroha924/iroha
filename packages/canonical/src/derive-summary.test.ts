import { describe, expect, it } from "vitest";
import { deriveSummary } from "./derive-summary.js";

describe("deriveSummary", () => {
  it("joins a hard-wrapped paragraph instead of cutting at the source's wrap column", () => {
    // Verbatim from this repository's own CLAUDE.md, which wraps mid-sentence.
    // Reading the first *line* summarized it as "…and Codex. It ships as".
    const body = [
      "# iroha implementation instructions",
      "",
      "**iroha** is a local-first Engineering Memory Graph for Claude Code and Codex. It ships as",
      "`@irohalabs/iroha` on npm; every work package is implemented.",
    ].join("\n");

    expect(deriveSummary(body)).toBe(
      "iroha is a local-first Engineering Memory Graph for Claude Code and Codex. It ships as @irohalabs/iroha on npm; every work package is implemented.",
    );
  });

  it("drops emphasis and link syntax, so the field holds prose rather than markup", () => {
    const body = "Use **bold**, `code`, and [a link](https://example.com/x) freely.";

    expect(deriveSummary(body)).toBe("Use bold, code, and a link freely.");
  });

  it("skips headings and takes the first paragraph, not the first list item", () => {
    const body = ["## Rules", "", "- first bullet", "- second bullet", "", "The prose."].join("\n");

    // A list is not prose; running its items together would invent a sentence
    // the document never contained.
    expect(deriveSummary(body)).toBe("The prose.");
  });

  it("cuts an over-long paragraph at a sentence end rather than mid-word", () => {
    const sentence = `${"word ".repeat(40).trim()}. `;
    const summary = deriveSummary(sentence.repeat(6));

    expect(summary).toBeDefined();
    if (summary === undefined) return;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith(".")).toBe(true);
  });

  it("cuts a Japanese paragraph at a Japanese sentence end", () => {
    const body = `${"あ".repeat(200)}。${"い".repeat(200)}。${"う".repeat(200)}。`;

    const summary = deriveSummary(body);

    expect(summary).toBe(`${"あ".repeat(200)}。${"い".repeat(200)}。`);
  });

  it("keeps the ellipsis inside the limit when there is no boundary to cut at", () => {
    // CJK prose with no terminator has neither a space nor a period, so this is
    // the one branch with nothing to cut at — and the one that would overrun by
    // appending to a full-length slice.
    const summary = deriveSummary("あ".repeat(501));

    expect(summary).toBeDefined();
    if (summary === undefined) return;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("returns undefined for a document with no prose", () => {
    expect(deriveSummary("# Title\n\n## Section\n")).toBeUndefined();
    expect(deriveSummary("")).toBeUndefined();
  });
});
