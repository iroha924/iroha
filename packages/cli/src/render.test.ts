import { describe, expect, it } from "vitest";
import {
  definition,
  labelColumn,
  padCell,
  row,
  spread,
  statusGlyph,
  terminalWidth,
  wrapCell,
} from "./render.js";

/**
 * `\p{Emoji_Presentation}` alone misses a text-default character forced to an
 * emoji rendering by U+FE0F (`⚠️`), so the variation selector is matched too. None
 * of the glyphs this module uses (`✓ ✗ ○ ● · ━`) match either half.
 */
const EMOJI = /\p{Emoji_Presentation}|️/u;

/** Styles are only applied when the terminal supports them; strip for exact assertions. */
/**
 * Strip SGR sequences for exact assertions. Built from a string rather than a
 * regex literal, because a literal ESC inside one is a lint error
 * (`noControlCharactersInRegex`).
 */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function plain(text: string): string {
  return text.replace(SGR, "");
}

describe("padCell", () => {
  it("pads by terminal cells, not code units", () => {
    // `.padEnd(10)` would add 7 spaces here — the label is 3 code units but 6
    // cells — leaving every column after a Japanese label misaligned.
    expect(plain(padCell("日本語", 10))).toBe("日本語    ");
    expect(padCell("日本語", 10)).toHaveLength(3 + 4);
    expect("日本語".padEnd(10)).toHaveLength(10);
  });

  it("pads ASCII to the same visible width", () => {
    expect(padCell("node", 10)).toBe("node      ");
  });

  it("leaves text wider than the column untouched rather than truncating", () => {
    expect(padCell("storage-capabilities", 4)).toBe("storage-capabilities");
  });

  it("ignores ANSI styling when measuring", () => {
    const styled = `[2mnode[22m`;

    expect(plain(padCell(styled, 8))).toBe("node    ");
  });
});

describe("wrapCell", () => {
  it("wraps on spaces", () => {
    expect(wrapCell("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("hard-breaks unspaced Japanese at the cell boundary", () => {
    // There is no space to split on, so a space-only wrapper would emit one
    // overflowing line. Ten double-width glyphs is exactly 20 cells.
    expect(wrapCell("日本語のテキストは空白で区切られない", 20)).toEqual([
      "日本語のテキストは空",
      "白で区切られない",
    ]);
  });

  it("hard-breaks a single token longer than the column", () => {
    expect(wrapCell("packages/storage/src/repositories/digest.ts", 16)).toEqual([
      "packages/storage",
      "/src/repositorie",
      "s/digest.ts",
    ]);
  });

  it("returns one line when it already fits", () => {
    expect(wrapCell("disabled", 20)).toEqual(["disabled"]);
  });

  it("returns a single empty line for empty text", () => {
    expect(wrapCell("", 20)).toEqual([""]);
  });
});

describe("labelColumn", () => {
  it("measures the widest label in cells", () => {
    expect(labelColumn(["node", "git"])).toBe(4);
    expect(labelColumn(["node", "日本語"])).toBe(6);
  });

  it("is zero for no labels", () => {
    expect(labelColumn([])).toBe(0);
  });
});

describe("statusGlyph", () => {
  it("maps each reported status to a text-presentation glyph", () => {
    expect(plain(statusGlyph("ok"))).toBe("✓");
    expect(plain(statusGlyph("warning"))).toBe("○");
    expect(plain(statusGlyph("error"))).toBe("✗");
    expect(plain(statusGlyph("blocked"))).toBe("✗");
  });

  it("falls back rather than throwing on a status it does not know", () => {
    expect(plain(statusGlyph("something-new"))).toBe("·");
  });

  it("uses no emoji", () => {
    for (const status of ["ok", "warning", "error", "blocked", "unknown"]) {
      expect(EMOJI.test(statusGlyph(status)), status).toBe(false);
    }
  });
});

describe("row", () => {
  it("aligns the value column and hangs continuations under it", () => {
    const lines = plain(row("✓", "node", "a".repeat(200), 6)).split("\n");

    expect(lines.length).toBeGreaterThan(1);
    const valueColumn = (lines[0] as string).indexOf("a");
    for (const line of lines.slice(1)) {
      expect(line.indexOf("a")).toBe(valueColumn);
    }
  });

  it("keeps a short value on one line", () => {
    expect(plain(row("✓", "git", "resolved", 6))).toBe("    ✓  git     resolved");
  });
});

describe("definition", () => {
  it("aligns the detail column with no status glyph", () => {
    expect(plain(definition("repository", "repo_01", 14))).toBe("    repository      repo_01");
  });
});

describe("spread", () => {
  it("pushes the tail right, leaving at least one space", () => {
    const line = plain(spread("ok 12", "all clear"));

    expect(line.startsWith("  ok 12")).toBe(true);
    expect(line.endsWith("all clear")).toBe(true);
    expect(line).toMatch(/ok 12 {2,}all clear/);
  });

  it("still separates when head and tail exceed the rule", () => {
    expect(plain(spread("x".repeat(60), "y".repeat(20)))).toContain("x y");
  });
});

describe("terminalWidth", () => {
  it("is a usable width even with no TTY", () => {
    // vitest captures stdout, so `columns` is undefined here — the point is that
    // the fallback is a fixed 80 rather than something environment-dependent.
    expect(terminalWidth()).toBeGreaterThanOrEqual(20);
    expect(terminalWidth()).toBeLessThanOrEqual(100);
  });
});
