/**
 * `--help`, rendered by iroha rather than by gunshi's default usage block.
 *
 * gunshi takes these as `renderHeader` / `renderUsage` / `renderValidationErrors`
 * overrides returning a plain string, which is why the CLI needs no TUI runtime:
 * every surface here is composed once and written once.
 */
import type { CommandContext } from "gunshi";
import { danger, definition, labelColumn, muted, sectionLabel, title } from "./render.js";

/** The declared shape of one argument, narrowed from gunshi's generic arg record. */
interface ArgSpec {
  type?: string;
  short?: string;
  description?: string;
}

function optionTerm(name: string, spec: ArgSpec): string {
  return spec.short === undefined ? `    --${name}` : `-${spec.short}, --${name}`;
}

/** Positional args are named in the usage line, not listed as options. */
function partition(args: Record<string, ArgSpec>): {
  options: [string, ArgSpec][];
  positionals: string[];
} {
  const options: [string, ArgSpec][] = [];
  const positionals: string[] = [];
  for (const [name, spec] of Object.entries(args)) {
    if (spec.type === "positional") {
      positionals.push(name);
    } else {
      options.push([name, spec]);
    }
  }
  return { options, positionals };
}

function optionsBlock(args: Record<string, ArgSpec>): string[] {
  const { options } = partition(args);
  if (options.length === 0) {
    return [];
  }
  const terms = options.map(([name, spec]) => optionTerm(name, spec));
  const width = labelColumn(terms);
  return [
    "",
    sectionLabel("Options"),
    ...options.map(([, spec], index) =>
      definition(terms[index] as string, spec.description ?? "", width),
    ),
  ];
}

function usageLine(binary: string, command: string | undefined, args: Record<string, ArgSpec>) {
  const { positionals } = partition(args);
  const parts = [binary];
  if (command !== undefined) {
    parts.push(command);
  }
  parts.push(...positionals.map((name) => `<${name}>`), "[options]");
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
    ...(ctx.description === undefined ? [] : [`  ${muted(ctx.description)}`]),
    "",
    sectionLabel("Usage"),
    usageLine(binary, isRoot ? "<command>" : ctx.name, args),
    ...(isRoot ? subCommandRows(ctx) : []),
    ...optionsBlock(args),
  ];
  if (isRoot) {
    lines.push("", `  ${muted(`Run any command with --help for its own options.`)}`);
  }
  return lines.join("\n");
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
  const binary = ctx.env.name ?? "iroha";
  const command = ctx.name === undefined || ctx.name === binary ? binary : `${binary} ${ctx.name}`;
  const messages = (error.errors as unknown[]).map((inner) =>
    inner instanceof Error ? inner.message : String(inner),
  );
  return [
    `  ${danger("✗")}  ${messages.length === 1 ? "Invalid argument" : "Invalid arguments"}`,
    ...messages.map((message) => `     ${message}`),
    "",
    `  ${muted(`Run \`${command} --help\` to see the accepted options.`)}`,
  ].join("\n");
}
