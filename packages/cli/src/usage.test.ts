import { cli, define } from "gunshi";
import { describe, expect, it } from "vitest";
import { renderUsage, renderValidationErrors } from "./usage.js";

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

const main = define({
  name: "iroha",
  description: "Local-first Engineering Memory Graph",
  run: () => {},
});

const doctor = define({
  name: "doctor",
  description: "Diagnose the local environment",
  args: { json: { type: "boolean", description: "Output JSON" } },
  run: () => {},
});

const search = define({
  name: "search",
  description: "Search approved knowledge",
  args: {
    json: { type: "boolean", description: "Output JSON" },
    query: { type: "positional", description: "Search query" },
  },
  run: () => {},
});

/**
 * Drives the real `cli()` so the context is the one gunshi actually builds —
 * `env.subCommands` in particular includes the root command under its own name,
 * which a hand-made fixture would not reproduce.
 */
async function usageFor(argv: string[]): Promise<string> {
  let captured = "";
  await cli(argv, main, {
    name: "iroha",
    version: "9.9.9",
    subCommands: { doctor, search },
    renderHeader: null,
    renderUsage: async (ctx) => {
      captured = await renderUsage(ctx);
      return "";
    },
  });
  return plain(captured);
}

describe("renderUsage — root", () => {
  it("lists every subcommand with its description", async () => {
    const text = await usageFor(["--help"]);

    expect(text).toContain("doctor");
    expect(text).toContain("Diagnose the local environment");
    expect(text).toContain("search");
    expect(text).toContain("Search approved knowledge");
  });

  it("does not list the root command as one of its own subcommands", async () => {
    // gunshi puts the root into `subCommands` under its own name, which is what
    // produced the default help's `[iroha] <OPTIONS>` row.
    const commands = (await usageFor(["--help"])).split("COMMANDS")[1] ?? "";

    expect(commands).not.toMatch(/^\s+iroha\s/m);
  });

  it("shows the version in the title and a generic usage line", async () => {
    const text = await usageFor(["--help"]);

    expect(text).toContain("iroha 9.9.9");
    expect(text).toContain("iroha <command> [options]");
  });

  it("uses no emoji", async () => {
    expect(EMOJI.test(await usageFor(["--help"]))).toBe(false);
  });
});

describe("renderUsage — subcommand", () => {
  it("titles the subcommand and omits the command list", async () => {
    const text = await usageFor(["doctor", "--help"]);

    expect(text).toContain("iroha doctor");
    expect(text).not.toContain("COMMANDS");
  });

  it("names a positional in the usage line instead of listing it as an option", async () => {
    const text = await usageFor(["search", "--help"]);

    expect(text).toContain("iroha search <query> [options]");
    expect(text).not.toContain("--query");
  });

  it("lists the subcommand's own options", async () => {
    const text = await usageFor(["doctor", "--help"]);

    expect(text).toContain("--json");
    expect(text).toContain("Output JSON");
  });
});

describe("renderValidationErrors", () => {
  it("lists every inner message and points at the right --help", async () => {
    let captured = "";
    await cli(["search", "--nope"], main, {
      name: "iroha",
      version: "9.9.9",
      subCommands: { doctor, search },
      renderHeader: null,
      renderValidationErrors: async (ctx, error) => {
        captured = plain(await renderValidationErrors(ctx, error));
        return "";
      },
    }).catch(() => {
      // gunshi rejects after rendering; `runCli` is what turns that into exit 1.
    });

    expect(captured).toContain("Invalid argument");
    expect(captured).toContain("iroha search --help");
    expect(EMOJI.test(captured)).toBe(false);
  });
});
