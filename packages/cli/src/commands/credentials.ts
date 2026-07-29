import { type CredentialProvider, credentialsLocation, writeApiKey } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";
import { definition, labelColumn, muted, statusGlyph, title } from "../render.js";

const PROVIDERS: readonly CredentialProvider[] = ["voyage", "github"];

function isProvider(value: string): value is CredentialProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Reads the key from stdin — never from an argument.
 *
 * A key on the command line lands in the shell history and in every process
 * listing on the machine, which is the leak this whole change exists to close.
 * Piping is also the only input this needs to support: `gh auth login
 * --with-token` takes the same position, and it avoids hand-rolling raw-mode
 * terminal echo suppression (and its backspace/Ctrl-C/paste edge cases) for a
 * path the dashboard's Settings page already covers with a real password field.
 */
async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    // A stream with an encoding set yields strings, one without yields Buffers;
    // decoding at the end rather than per chunk keeps a multi-byte character
    // split across a chunk boundary intact.
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const credentialsCommand = define({
  name: "credentials",
  description: "Store a provider API key in ~/.config/iroha/credentials.json (read from stdin)",
  rendering: { header: null },
  args: {
    provider: {
      type: "positional",
      description: `Which key to store: ${PROVIDERS.join(" or ")}`,
    },
    json: { type: "boolean", description: "Output JSON" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const provider = String(ctx.values.provider ?? "");
    if (!isProvider(provider)) {
      // The value is not echoed: the mistake this guard exists for is typing the
      // key itself as the argument, and printing it back would put it in one more
      // place (a terminal recording, a CI log, an agent transcript).
      printError(json, {
        code: "INVALID_INPUT",
        message: `Unknown provider. Expected ${PROVIDERS.join(" or ")}.`,
      });
      return;
    }
    if (process.stdin.isTTY === true) {
      printError(json, {
        code: "INVALID_INPUT",
        message: `No key on stdin. Pipe it in, e.g. \`pbpaste | iroha credentials ${provider}\`, or use the dashboard's Settings page.`,
      });
      return;
    }

    const written = await writeApiKey(provider, await readSecretFromStdin());
    if (!written.ok) {
      printError(json, written.error);
      return;
    }
    // The path is printed, the key is not — the point of the line is telling the
    // reader which file to back up or delete.
    printSuccess(json, { provider, file: credentialsLocation().file }, (data) => {
      const facts: [string, string][] = [
        ["provider", data.provider],
        ["file", data.file],
      ];
      const width = labelColumn(facts.map(([term]) => term));
      return [
        title("iroha credentials"),
        "",
        `    ${statusGlyph("ok")}  Stored the ${data.provider} API key`,
        "",
        ...facts.map(([term, detail]) => definition(muted(term), detail, width)),
      ].join("\n");
    });
  },
});
