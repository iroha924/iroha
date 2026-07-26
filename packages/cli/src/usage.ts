/**
 * `--help`, rendered by iroha rather than by gunshi's default usage block.
 *
 * gunshi takes these as `renderHeader` / `renderUsage` / `renderValidationErrors`
 * overrides returning a plain string, which is why the CLI needs no TUI runtime:
 * every surface here is composed once and written once.
 *
 * Replacing a renderer means inheriting everything it rendered. gunshi's default
 * derives four things from the arg schema that the description alone does not carry
 * — the enum's choices, a default value, a `<value>` placeholder that separates a
 * valued option from a boolean flag, and the positional's own description — and all
 * four are reproduced below, because dropping them makes `--type`'s accepted values
 * undiscoverable from the very screen `renderValidationErrors` points at.
 */
import type { CommandContext } from "gunshi";
import { danger, definition, labelColumn, muted, sanitize, sectionLabel, title } from "./render.js";

/** The declared shape of one argument, narrowed from gunshi's generic arg record. */
interface ArgSpec {
  type?: string;
  short?: string;
  description?: string;
  choices?: readonly unknown[];
  default?: unknown;
}

/** `-s, --name <name>` — the placeholder marks anything that takes a value. */
function optionTerm(name: string, spec: ArgSpec): string {
  const short = spec.short === undefined ? "    " : `-${spec.short}, `;
  const placeholder = spec.type === "boolean" || spec.type === undefined ? "" : ` <${name}>`;
  return `${short}--${name}${placeholder}`;
}

/**
 * `(default: hybrid, choices: hybrid | lexical | vector | graph)`, or nothing.
 *
 * Returned as plain text and concatenated into the description so it wraps with it.
 * `--type`'s sixteen choices are far wider than a terminal, and styling it
 * separately would either overflow the line or push a dim span through `wrapCell`,
 * which splits on raw space indices.
 */
function optionAnnotation(spec: ArgSpec): string {
  const parts: string[] = [];
  if (spec.default !== undefined) {
    parts.push(`default: ${String(spec.default)}`);
  }
  if (spec.choices !== undefined && spec.choices.length > 0) {
    parts.push(`choices: ${spec.choices.map((choice) => String(choice)).join(" | ")}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function partition(args: Record<string, ArgSpec>): {
  options: [string, ArgSpec][];
  positionals: [string, ArgSpec][];
} {
  const options: [string, ArgSpec][] = [];
  const positionals: [string, ArgSpec][] = [];
  for (const entry of Object.entries(args)) {
    (entry[1].type === "positional" ? positionals : options).push(entry);
  }
  return { options, positionals };
}

function describedRows(entries: [string, ArgSpec][], terms: string[]): string[] {
  const width = labelColumn(terms);
  return entries.map(([, spec], index) =>
    definition(terms[index] as string, `${spec.description ?? ""}${optionAnnotation(spec)}`, width),
  );
}

function optionsBlock(args: Record<string, ArgSpec>): string[] {
  const { options } = partition(args);
  if (options.length === 0) {
    return [];
  }
  return [
    "",
    sectionLabel("Options"),
    ...describedRows(
      options,
      options.map(([name, spec]) => optionTerm(name, spec)),
    ),
  ];
}

function argumentsBlock(args: Record<string, ArgSpec>): string[] {
  const { positionals } = partition(args);
  if (positionals.length === 0) {
    return [];
  }
  return [
    "",
    sectionLabel("Arguments"),
    ...describedRows(
      positionals,
      positionals.map(([name]) => name),
    ),
  ];
}

function usageLine(binary: string, command: string | undefined, args: Record<string, ArgSpec>) {
  const { positionals } = partition(args);
  const parts = [binary];
  if (command !== undefined) {
    parts.push(command);
  }
  parts.push(...positionals.map(([name]) => `<${name}>`), "[options]");
  return `    ${parts.join(" ")}`;
}

/**
 * `subCommands` includes the main command under its own name — that entry is the
 * root, not a subcommand, and listing it produces gunshi's default `[iroha]` row.
 */
function subCommandRows(ctx: Readonly<CommandContext>): string[] {
  const entries = [...(ctx.env.subCommands ?? new Map())].filter(([name]) => name !== ctx.env.name);
  if (entries.length === 0) {
    return [];
  }
  const width = labelColumn(entries.map(([name]) => name));
  return [
    "",
    sectionLabel("Commands"),
    ...entries.map(([name, command]) =>
      definition(name, (command as { description?: string }).description ?? "", width),
    ),
  ];
}

export async function renderUsage(ctx: Readonly<CommandContext>): Promise<string> {
  const binary = ctx.env.name ?? "iroha";
  const args = (ctx.args ?? {}) as Record<string, ArgSpec>;
  const isRoot = ctx.name === undefined || ctx.name === binary;
  const heading = isRoot ? `${binary} ${ctx.env.version ?? ""}`.trim() : `${binary} ${ctx.name}`;

  const lines = [
    title(heading),
    ...(ctx.description === undefined ? [] : [`  ${muted(sanitize(ctx.description))}`]),
    "",
    sectionLabel("Usage"),
    usageLine(binary, isRoot ? "<command>" : ctx.name, args),
    ...(isRoot ? subCommandRows(ctx) : argumentsBlock(args)),
    ...optionsBlock(args),
  ];
  if (isRoot) {
    lines.push("", `  ${muted("Run any command with --help for its own options.")}`);
  }
  return lines.join("\n");
}

/**
 * Set when this process has actually shown the user the validation errors, so the
 * entrypoint can tell gunshi's post-render rejection from an `AggregateError`
 * thrown anywhere else — which must not be swallowed, or it exits 1 in silence.
 */
let rendered = false;

export function validationErrorsRendered(): boolean {
  return rendered;
}

/**
 * A bad flag or value. gunshi hands over an `AggregateError`, and every inner
 * message is already the specific complaint, so they are listed verbatim under one
 * heading rather than reworded.
 */
export async function renderValidationErrors(
  ctx: Readonly<CommandContext>,
  error: AggregateError,
): Promise<string> {
  rendered = true;
  const binary = ctx.env.name ?? "iroha";
  const command = ctx.name === undefined || ctx.name === binary ? binary : `${binary} ${ctx.name}`;
  const messages = (error.errors as unknown[]).map((inner) =>
    sanitize(inner instanceof Error ? inner.message : String(inner)),
  );
  return [
    `  ${danger("✗")}  ${messages.length === 1 ? "Invalid argument" : "Invalid arguments"}`,
    ...messages.map((message) => `     ${message}`),
    "",
    `  ${muted(`Run \`${command} --help\` to see the accepted options.`)}`,
  ].join("\n");
}
