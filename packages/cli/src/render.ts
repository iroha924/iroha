/**
 * Terminal rendering — the dashboard's editorial identity, in a surface that does
 * not own its own background.
 *
 * Only accents carry colour; body text stays unstyled and de-emphasis uses ANSI
 * `dim`. The brand's ink (`#2E2A22`) is near-black and would vanish on a dark
 * theme, and ink-muted loses contrast on one of the two.
 */
import { Ansis } from "ansis";
import stringWidth from "string-width";

/**
 * Which colour level to render at, given an environment and whether stdout is a
 * terminal. Pure so the branches can actually be tested — the module-level
 * instance below is captured once at load and cannot be re-exercised in-process.
 *
 * ansis reads `COLORTERM` as an outright capability declaration, ahead of both
 * `stdout.isTTY` and `TERM=dumb`. Measured with ansis 4.3.1: with
 * `COLORTERM=truecolor` set — which ghostty, iTerm2, kitty, WezTerm and VS Code all
 * do — output piped to a file still carried escapes, and so did `TERM=dumb`. Left
 * to that detection, `iroha search | grep …` would fail to match across a styled
 * span. So the gate is explicit: `NO_COLOR` wins outright, `FORCE_COLOR` is
 * honoured either way (a demo can force colour through a pipe), and otherwise
 * colour needs a TTY that is not `dumb`.
 *
 * `undefined` means "let ansis detect", which is what `FORCE_COLOR` needs so its
 * 0/1/2/3 values keep their meaning.
 */
export function colorLevel(
  env: {
    NO_COLOR?: string | undefined;
    FORCE_COLOR?: string | undefined;
    TERM?: string | undefined;
  },
  isTTY: boolean,
): 0 | undefined {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return 0;
  }
  if (env.FORCE_COLOR !== undefined) {
    return undefined;
  }
  return isTTY && env.TERM !== "dumb" ? undefined : 0;
}

function terminalStyles(): Ansis {
  const level = colorLevel(process.env, process.stdout.isTTY === true);
  return level === undefined ? new Ansis() : new Ansis(level);
}

const styles = terminalStyles();

const MATCHA = "#6E7B57";
const CLAY = "#BC9870";
const PERSIMMON = "#C26A3C";
const AMBER = "#A8823F";

/**
 * At 16 colours the brand hexes cannot be preserved, and quantizing them is worse
 * than replacing them: ansis maps matcha to SGR 30 — ANSI black — so every ok
 * glyph would disappear on a dark background, the exact failure the palette exists
 * to avoid, and amber and clay both collapse onto SGR 33, merging warning with
 * decoration. At this depth the roles matter and the hues cannot, so each role
 * takes a distinct named colour. Level 1 is not exotic: it is what ansis selects
 * for a TTY with `TERM=xterm` or `TERM=screen` and no `COLORTERM` (the default
 * inside plain screen and tmux), and for `FORCE_COLOR=1`.
 */
const SIXTEEN_COLOUR = styles.level === 1;

export const accent = SIXTEEN_COLOUR ? styles.green : styles.hex(MATCHA);
export const danger = SIXTEEN_COLOUR ? styles.red : styles.hex(PERSIMMON);
export const caution = SIXTEEN_COLOUR ? styles.yellow : styles.hex(AMBER);
export const muted = styles.dim;

const decoration = SIXTEEN_COLOUR ? styles.magenta : styles.hex(CLAY);
const strong = styles.bold;

/**
 * Strip control characters from a value that came from outside this process.
 *
 * Canonical titles, doctor messages and scanned filenames all reach the terminal
 * verbatim, and `.iroha/` is git-tracked — so an approved document is a write
 * primitive for whatever its title contains. An escape sequence there can move the
 * cursor over output this CLI already wrote, turn a line into an OSC 8 hyperlink,
 * or drive an OSC 52 clipboard write on terminals that honour it. Since this module
 * now emits legitimate escapes of its own, an injected one is otherwise
 * indistinguishable from the tool's.
 *
 * C0, DEL and C1 all go: none of them has a meaning inside a single cell, and C1
 * matters because a lone 0x9B is an equivalent CSI introducer on some terminals.
 *
 * Written with `\\u` escapes rather than literal bytes: a literal control character
 * in the source makes the file itself scan as binary to grep. The lint rule that
 * bans control characters in a regex is inverted here — matching them is the point.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to strip them.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/**
 * Wrapping width. A non-TTY (piped output, CI) has no columns, so it gets a stable
 * 80 rather than a value that varies by environment. Capped so a very wide terminal
 * does not produce unreadably long measures — the same reason the dashboard caps
 * its content width.
 */
export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return columns !== undefined && columns > 0 ? Math.min(columns, 100) : 80;
}

/** Content width inside the two-space page indent, shared by the rule and rows. */
function contentWidth(): number {
  return terminalWidth() - 2;
}

/**
 * The three-circle mark, recurring from the dashboard's loader, empty state and
 * active nav — the one brand signature the terminal can carry verbatim.
 */
function mark(): string {
  return `${accent("●")}${decoration("●")}${danger("●")}`;
}

/** The rule beneath a title. One weight, never stacked (depth comes from tone). */
function rule(): string {
  return muted("━".repeat(contentWidth()));
}

export function title(text: string): string {
  return `  ${mark()}  ${strong(text)}\n  ${rule()}`;
}

/** An editorial section label: uppercase, de-emphasised, no border. */
export function sectionLabel(text: string): string {
  return `  ${muted(text.toUpperCase())}`;
}

/**
 * Pad to a width measured in terminal cells rather than code units. A CJK glyph is
 * one `.length` but two cells, so `String.padEnd` misaligns every column in a
 * repository whose canonical titles are Japanese. `stringWidth` also strips ANSI,
 * so an already-styled cell pads to its visible width.
 */
export function padCell(text: string, width: number): string {
  const gap = width - stringWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

/** Right-align `tail` against the content edge, leaving at least one space. */
export function spread(head: string, tail: string): string {
  const gap = contentWidth() - stringWidth(head) - stringWidth(tail);
  return `  ${head}${" ".repeat(Math.max(gap, 1))}${tail}`;
}

/** The four statuses this module draws. Kept local so `render` owns no domain type. */
export type GlyphStatus = "ok" | "warning" | "error" | "blocked";

interface StatusStyle {
  glyph: string;
  paint: (text: string) => string;
}

/**
 * A `Map`, not an object literal: an object lookup resolves through
 * `Object.prototype`, so a status of `"toString"` or `"constructor"` returns a
 * truthy method, walks past an `undefined` guard, and throws on `style.paint`. A
 * `Map` has no such chain, which is what makes the fallback below reachable for
 * every value rather than only for own-property misses.
 */
const STATUS_STYLES = new Map<GlyphStatus, StatusStyle>([
  ["ok", { glyph: "✓", paint: accent }],
  ["warning", { glyph: "○", paint: caution }],
  ["error", { glyph: "✗", paint: danger }],
  ["blocked", { glyph: "✗", paint: danger }],
]);

export function statusGlyph(status: GlyphStatus): string {
  const style = STATUS_STYLES.get(status);
  return style === undefined ? muted("·") : style.paint(style.glyph);
}

/**
 * Break `text` to `width` cells. Splits on spaces and hard-breaks a token wider
 * than the column — which is also what makes this work for Japanese, where there is
 * no space to split on.
 *
 * Callers must pass unstyled text: the split lands on raw space indices, so a break
 * inside an SGR span would leave the style open across the wrap. Style the result,
 * not the input.
 */
export function wrapCell(text: string, width: number): string[] {
  if (width < 1) {
    return [text];
  }
  const lines: string[] = [];
  let line = "";
  for (const token of text.split(" ")) {
    const candidate = line === "" ? token : `${line} ${token}`;
    if (stringWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line !== "") {
      lines.push(line);
      line = "";
    }
    let rest = token;
    while (stringWidth(rest) > width) {
      let cut = "";
      for (const char of rest) {
        if (cut !== "" && stringWidth(cut + char) > width) {
          break;
        }
        cut += char;
        if (stringWidth(cut) >= width) {
          break;
        }
      }
      lines.push(cut);
      rest = rest.slice(cut.length);
    }
    line = rest;
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

/** Indent of the value column: `    ` + glyph + `  ` + label + `  `. */
const VALUE_GUTTER = 9;

/** Indent of the detail column: `    ` + term + `  `. */
const DETAIL_GUTTER = 6;

function hanging(head: string, column: number, value: string): string {
  const lines = wrapCell(value, Math.max(terminalWidth() - column, 20));
  const hang = " ".repeat(column);
  return lines.map((line, index) => (index === 0 ? head + line : hang + line)).join("\n");
}

/**
 * `glyph  label  value`, with the value wrapped under a hanging indent. With no
 * label the second gap is dropped too, so a glyph-only line sits two spaces from
 * its text rather than four.
 */
export function row(glyph: string, label: string, value: string, labelWidth: number): string {
  if (labelWidth === 0 && label === "") {
    return hanging(`    ${glyph}  `, 7, value);
  }
  return hanging(`    ${glyph}  ${padCell(label, labelWidth)}  `, VALUE_GUTTER + labelWidth, value);
}

/** `term  detail` — the same layout without a status glyph. */
export function definition(term: string, detail: string, termWidth: number): string {
  return hanging(`    ${padCell(term, termWidth)}  `, DETAIL_GUTTER + termWidth, detail);
}

/** The widest label in a set, so a caller can align one block without guessing. */
export function labelColumn(labels: readonly string[]): number {
  return labels.reduce((widest, label) => Math.max(widest, stringWidth(label)), 0);
}
