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

/** Collapse the hanging indent so an assertion survives a wrapped line. */
function flat(text: string): string {
  return plain(text).replace(/\s+/g, " ");
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
    mode: {
      type: "enum",
      choices: ["hybrid", "lexical", "vector", "graph"],
      default: "hybrid",
      description: "Retrieval mode",
    },
    limit: { type: "number", description: "Maximum number of results" },
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
  async function errorsFor(argv: string[]): Promise<string> {
    let captured = "";
    await cli(argv, main, {
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
    return captured;
  }

  // The input matters: gunshi does not reject an unknown option at all (`--nope`
  // is simply ignored, and consumes the next token as its value), so driving it
  // with one rendered only the unrelated missing-positional error and never
  // exercised the path the test appeared to cover.
  it("names the single failing argument", async () => {
    const text = await errorsFor(["search", "--mode=nope", "q"]);

    expect(text).toContain("Invalid argument");
    expect(text).not.toContain("Invalid arguments");
    expect(text).toContain("--mode");
    expect(text).toContain("iroha search --help");
  });

  it("switches to the plural heading and lists every message", async () => {
    const text = await errorsFor(["search", "--mode=nope", "--limit=x", "q"]);

    expect(text).toContain("Invalid arguments");
    expect(text).toContain("--mode");
    expect(text).toContain("--limit");
  });

  it("uses no emoji", async () => {
    expect(EMOJI.test(await errorsFor(["search", "--mode=nope", "q"]))).toBe(false);
  });
});

describe("renderUsage — restored gunshi metadata", () => {
  // Replacing gunshi's renderer silently dropped four things its default derived
  // from the arg schema. Each is asserted here because the description alone
  // carries none of them, and `renderValidationErrors` points the user at this
  // very screen for the values gunshi's error message does list.
  it("lists an enum's choices", async () => {
    // Asserted against the unwrapped text: the sixteen real `--type` choices are
    // wider than any terminal, so this annotation is meant to wrap.
    expect(flat(await usageFor(["search", "--help"]))).toContain(
      "choices: hybrid | lexical | vector | graph",
    );
  });

  it("marks a valued option with a placeholder, and a boolean without one", async () => {
    const text = await usageFor(["search", "--help"]);

    expect(flat(text)).toContain("--mode <mode>");
    expect(flat(text)).toContain("--json Output JSON");
  });

  it("shows a default value", async () => {
    expect(flat(await usageFor(["search", "--help"]))).toContain("default: hybrid");
  });

  it("describes the positional in its own block", async () => {
    const text = await usageFor(["search", "--help"]);

    expect(text).toContain("ARGUMENTS");
    expect(flat(text)).toContain("query Search query");
  });
});
