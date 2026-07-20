import { type Clock, CryptoRandomSource, type RandomSource, SystemClock } from "@iroha/domain";
import { type HookInvocation, type HookPlatform, runHook } from "./run-hook.js";

/** hooks-contract.md §2: at most 1 MiB of UTF-8 JSON is read from stdin. */
export const MAX_STDIN_BYTES = 1024 * 1024;

/** Maps the `<claude|codex>` entrypoint argument to a platform, or `null` if unknown. */
export function toHookPlatform(arg: string | undefined): HookPlatform | null {
  if (arg === "claude") {
    return "claude_code";
  }
  if (arg === "codex") {
    return "codex";
  }
  return null;
}

export interface HookEntryInput {
  /** The `<claude|codex>` argv value. */
  arg: string | undefined;
  /** Raw stdin text. */
  stdin: string;
  cwd: string;
  deps?: { clock: Clock; random: RandomSource };
}

/**
 * The logic behind `node hook.mjs <claude|codex>`: choose the platform, bound
 * and parse stdin, and run the hook. Unknown platform, oversize input, and
 * malformed JSON are all fail-open — they return no output rather than erroring,
 * so the hook never blocks the agent (hooks-contract.md §2). Returns the stdout
 * string to write, or `undefined` for none.
 */
export async function runHookEntry(input: HookEntryInput): Promise<string | undefined> {
  const platform = toHookPlatform(input.arg);
  if (platform === null) {
    return undefined;
  }
  if (Buffer.byteLength(input.stdin, "utf8") > MAX_STDIN_BYTES) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.stdin);
  } catch {
    return undefined;
  }
  const deps = input.deps ?? { clock: new SystemClock(), random: new CryptoRandomSource() };
  const invocation: HookInvocation = { platform, raw, cwd: input.cwd };
  const result = await runHook(invocation, deps);
  return result.stdout;
}

async function readStdinBounded(max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    total += buf.length;
    if (total > max) {
      // Stop reading past the limit; `runHookEntry` rejects the oversize input.
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Process entrypoint: read stdin, run the hook, write at most one JSON object to
 * stdout, and let the process exit 0. WP-11 bundles this into the plugin's
 * `dist/hook.mjs`.
 */
export async function main(): Promise<void> {
  const stdin = await readStdinBounded(MAX_STDIN_BYTES + 1);
  const output = await runHookEntry({ arg: process.argv[2], stdin, cwd: process.cwd() });
  if (output !== undefined) {
    process.stdout.write(output);
  }
}
