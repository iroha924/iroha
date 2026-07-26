import { describe, expect, it } from "vitest";
import {
  colorLevel,
  definition,
  type GlyphStatus,
  labelColumn,
  padCell,
  row,
  sanitize,
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

  // The guard only rejected width < 1, so at width 1 a leading double-width glyph
  // produced an empty cut: `rest` never shrank and the loop never ended. A
  // synchronous loop cannot be interrupted by a per-test timeout, so the failure
  // mode was a wedged run rather than a red assertion — hence the explicit bound.
  it("makes progress at width 1 even when a glyph is wider than the column", {
    timeout: 2000,
  }, () => {
    expect(wrapCell("日本語", 1)).toEqual(["日", "本", "語"]);
    expect(wrapCell("日a語", 1)).toEqual(["日", "a", "語"]);
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

  // With an object literal the lookup resolves through Object.prototype, so
  // `statusGlyph("toString")` found the prototype's method, walked past the
  // `undefined` guard and threw on `style.paint`. The earlier test for the fallback
  // only ever passed an own-property miss, so it certified a guarantee the code did
  // not have. These are the keys that broke it.
  it("falls back for an inherited Object.prototype key, not just an own-property miss", () => {
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(plain(statusGlyph(key as GlyphStatus)), key).toBe("·");
    }
  });

  it("uses no emoji", () => {
    for (const status of ["ok", "warning", "error", "blocked"] as const) {
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

// The gate exists because ansis reads COLORTERM ahead of both isTTY and TERM=dumb,
// so its own detection leaves escapes in `iroha search | grep …` and in redirected
// output. The module-level instance is captured once at load and cannot be
// re-exercised in-process, which is why the decision is a pure function.
describe("colorLevel", () => {
  it("disables colour when stdout is not a terminal", () => {
    expect(colorLevel({ TERM: "xterm-ghostty" }, false)).toBe(0);
  });

  it("disables colour for a dumb terminal even on a TTY", () => {
    expect(colorLevel({ TERM: "dumb" }, true)).toBe(0);
  });

  it("lets ansis detect on a normal TTY", () => {
    expect(colorLevel({ TERM: "xterm-256color" }, true)).toBeUndefined();
  });

  it("honours NO_COLOR ahead of everything else", () => {
    expect(colorLevel({ NO_COLOR: "1", FORCE_COLOR: "3", TERM: "xterm" }, true)).toBe(0);
  });

  it("treats an empty NO_COLOR as unset, per the convention", () => {
    expect(colorLevel({ NO_COLOR: "", TERM: "xterm" }, true)).toBeUndefined();
  });

  it("lets FORCE_COLOR through a pipe so a demo can force colour", () => {
    expect(colorLevel({ FORCE_COLOR: "3" }, false)).toBeUndefined();
    expect(colorLevel({ FORCE_COLOR: "0" }, false)).toBeUndefined();
  });
});

describe("sanitize", () => {
  it("strips the escape sequences a canonical title can carry", () => {
    const ESC = String.fromCharCode(27);
    const hostile = `libSQL${ESC}[1A${ESC}[2K${ESC}[G  ${ESC}]8;;https://attacker.example${String.fromCharCode(7)}`;

    const clean = sanitize(hostile);

    expect(clean).not.toContain(ESC);
    expect(clean).toBe("libSQL[1A[2K[G  ]8;;https://attacker.example");
  });

  it("strips DEL and the C1 range, where a lone 0x9B is also a CSI introducer", () => {
    expect(sanitize(`a${String.fromCharCode(0x7f)}b${String.fromCharCode(0x9b)}c`)).toBe("abc");
  });

  it("leaves ordinary text, including CJK, untouched", () => {
    expect(sanitize("日本語のタイトル — ok")).toBe("日本語のタイトル — ok");
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
