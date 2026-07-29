import { Readable } from "node:stream";
import { credentialsLocation, readApiKey } from "@iroha/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../index.js";

/**
 * `credentialsLocation()` resolves from the environment, so each test points it
 * at a temp directory: a test that overwrote a developer's real key would be a
 * defect no assertion could catch.
 */
let restore: (() => void) | undefined;
let out: string;

function pipeStdin(content: string | null): void {
  const stream =
    content === null ? Object.assign(Readable.from([]), { isTTY: true }) : Readable.from([content]);
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

beforeEach(() => {
  out = "";
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const home = `${process.env.TMPDIR ?? "/tmp"}/iroha-cli-cred-${process.pid}-${Math.trunc(performance.now() * 1000)}`;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = `${home}/.config`;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
    vi.restoreAllMocks();
  };
});

afterEach(() => {
  restore?.();
  restore = undefined;
  process.exitCode = undefined;
});

describe("iroha credentials", () => {
  it("stores the key piped on stdin and prints the file, not the key", async () => {
    pipeStdin("pa-piped-key\n");

    // `--json`, because the human renderer wraps the path across lines.
    await runCli(["credentials", "voyage", "--json"]);

    const stored = await readApiKey("voyage");
    expect(stored.ok && stored.value).toBe("pa-piped-key");
    expect(JSON.parse(out).file).toBe(credentialsLocation().file);
    // The point of reading stdin is that the key reaches no other surface.
    expect(out).not.toContain("pa-piped-key");
  });

  it("refuses an unknown provider without echoing what was typed", async () => {
    pipeStdin("pa-unused");

    // The mistake this guard exists for is typing the key as the argument;
    // printing it back would put it in a terminal recording or a CI log.
    await runCli(["credentials", "pa-mistyped-as-provider"]);

    expect(out).not.toContain("pa-mistyped-as-provider");
    expect(process.exitCode).toBe(1);
  });

  it("tells the user how to pipe instead of hanging on a terminal", async () => {
    pipeStdin(null);

    await runCli(["credentials", "voyage"]);

    expect(out).toContain("iroha credentials voyage");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a key an HTTP header cannot carry", async () => {
    pipeStdin("pa-one\npa-two\n");

    await runCli(["credentials", "voyage"]);

    expect(process.exitCode).toBe(1);
    const stored = await readApiKey("voyage");
    expect(stored.ok && stored.value).toBeNull();
  });
});
