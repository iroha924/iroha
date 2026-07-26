/**
 * Terminal rendering — the dashboard's editorial identity, in a surface that does
 * not own its own background.
 *
 * Only accents carry a hex value; body text stays unstyled and de-emphasis uses
 * ANSI `dim`. The brand's ink (`#2E2A22`) is near-black and would vanish on a dark
 * theme, and ink-muted loses contrast on one of the two — the accents are mid-tone,
 * so they read against either. Below truecolor, ansis falls a hex back to the
 * nearest colour the terminal has.
 */
import { Ansis } from "ansis";
import stringWidth from "string-width";

/**
 * ansis reads `COLORTERM` as an outright capability declaration, ahead of both
 * `stdout.isTTY` and `TERM=dumb`. Measured with ansis 4.3.1: with
 * `COLORTERM=truecolor` set — which ghostty, iTerm2, kitty, WezTerm and VS Code all
 * do — `iroha doctor` piped to a file still emitted escapes, and so did
 * `TERM=dumb`. Left to that detection, `iroha search | grep …` would fail to match
 * across a styled span and a redirected report would be full of escapes.
 *
 * So the gate is explicit, and follows the conventional contract: `FORCE_COLOR` is
 * honoured either way (a demo can force colour through a pipe), and otherwise
 * colour needs a TTY that is not `dumb`. `NO_COLOR` needs no branch — ansis's own
 * detection already answers 0 for it, verified in both directions.
 */
function terminalStyles(): Ansis {
  if (process.env.FORCE_COLOR !== undefined) {
    return new Ansis();
  }
  const usable = process.stdout.isTTY === true && process.env.TERM !== "dumb";
  return usable ? new Ansis() : new Ansis(0);
}

const styles = terminalStyles();

const MATCHA = "#6E7B57";
const CLAY = "#BC9870";
const PERSIMMON = "#C26A3C";
const AMBER = "#A8823F";

export const accent = styles.hex(MATCHA);
export const danger = styles.hex(PERSIMMON);
export const caution = styles.hex(AMBER);
export const muted = styles.dim;

const decoration = styles.hex(CLAY);
const strong = styles.bold;

/** Width of the rule under a title, and the column the right-aligned tail sits at. */
const RULE_WIDTH = 62;

/**
 * The three-circle mark, recurring from the dashboard's loader, empty state, and
 * active nav — the one brand signature the terminal can carry verbatim.
 */
function mark(): string {
  return `${accent("●")}${decoration("●")}${danger("●")}`;
}

/** The rule beneath a title. One weight, never stacked (depth comes from tone). */
function rule(width = RULE_WIDTH): string {
  return muted("━".repeat(width));
}

export function title(text: string): string {
  return `  ${mark()}  ${strong(text)}\n  ${rule()}`;
}

/** An editorial section label: uppercase, de-emphasised, no border. */
export function sectionLabel(text: string): string {
  return `  ${muted(text.toUpperCase())}`;
}

/**
 * Pad to a width measured in terminal cells rather than code units. A CJK glyph
 * is one `.length` but two cells, so `String.padEnd` misaligns every column in a
 * repository whose canonical titles are Japanese. `stringWidth` also strips ANSI,
 * so an already-styled cell pads to its visible width.
 */
export function padCell(text: string, width: number): string {
  const gap = width - stringWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
}

/** Right-align `tail` against the rule, leaving at least one space before it. */
export function spread(head: string, tail: string): string {
  const gap = RULE_WIDTH - stringWidth(head) - stringWidth(tail);
  return `  ${head}${" ".repeat(Math.max(gap, 1))}${tail}`;
}

interface StatusStyle {
  glyph: string;
  paint: (text: string) => string;
}

/**
 * Glyphs map from the reported status and nothing else. Inferring a fourth,
 * "nothing configured" presentation from message text would be guessing at a
 * distinction the report does not carry.
 */
const STATUS_STYLES: Record<string, StatusStyle> = {
  ok: { glyph: "✓", paint: accent },
  warning: { glyph: "○", paint: caution },
  error: { glyph: "✗", paint: danger },
  blocked: { glyph: "✗", paint: danger },
};

export function statusGlyph(status: string): string {
  const style = STATUS_STYLES[status];
  return style === undefined ? muted("·") : style.paint(style.glyph);
}

/**
 * Wrapping width. A non-TTY (piped output, CI) has no columns, so it gets a
 * stable 80 rather than a value that varies by environment. Capped so a very wide
 * terminal does not produce unreadably long measures — the same reason the
 * dashboard caps its content width.
 */
export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return columns !== undefined && columns > 0 ? Math.min(columns, 100) : 80;
}

/**
 * Break `text` to `width` cells. Splits on spaces and hard-breaks a token wider
 * than the column — which is also what makes this work for Japanese, where there
 * is no space to split on.
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
        if (stringWidth(cut + char) > width) {
          break;
        }
        cut += char;
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

/** `glyph  label  value`, with the value wrapped under a hanging indent. */
export function row(glyph: string, label: string, value: string, labelWidth: number): string {
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
