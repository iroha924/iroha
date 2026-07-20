import { claudeHookAdapter } from "@iroha/adapter-claude";
import { codexHookAdapter } from "@iroha/adapter-codex";
import type { Clock, RandomSource } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import type { HookAdapter } from "@iroha/platform";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { dispatchHookEvent } from "./dispatch.js";
import { createNormalizationContext } from "./normalization-context.js";

export type HookPlatform = "claude_code" | "codex";

export interface HookInvocation {
  platform: HookPlatform;
  raw: unknown;
  cwd: string;
}

export interface HookDeps {
  clock: Clock;
  random: RandomSource;
}

export interface HookResult {
  /** The single platform-valid JSON object to write to stdout, or `undefined` for none. */
  stdout: string | undefined;
}

const ADAPTERS: Record<HookPlatform, HookAdapter> = {
  claude_code: claudeHookAdapter,
  codex: codexHookAdapter,
};

/**
 * Execute one hook invocation end to end: resolve the repository from `cwd`,
 * normalize the raw input, run the event use case, and return the platform
 * output. Outside an initialized repository it returns no output. Every internal
 * failure is fail-open (hooks-contract.md §2/§7): the hook never blocks the agent
 * on an iroha error — it returns no output and lets the agent proceed.
 */
export async function runHook(invocation: HookInvocation, deps: HookDeps): Promise<HookResult> {
  const repo = await resolveInitializedRepository(invocation.cwd);
  if (!repo.ok) {
    // NOT_INITIALIZED and any other resolution failure are both fail-open:
    // a hook outside an initialized iroha repository is a silent no-op.
    return { stdout: undefined };
  }

  const salt = await ensureRepositorySalt(repo.value.irohaStateDir, deps.random);
  if (!salt.ok) {
    return { stdout: undefined };
  }

  const db = await openDatabase(repo.value.dbPath);
  if (!db.ok) {
    return { stdout: undefined };
  }

  try {
    const ctx = createNormalizationContext(salt.value, deps.clock, deps.random);
    const adapter = ADAPTERS[invocation.platform];
    const parsed = adapter.parseEvent(invocation.raw, ctx);
    if (!parsed.ok || parsed.value === null) {
      return { stdout: undefined };
    }
    const event = parsed.value;
    const output = await dispatchHookEvent(event, {
      db: db.value,
      repo: repo.value,
      salt: salt.value,
      clock: deps.clock,
      random: deps.random,
    });
    return { stdout: adapter.renderOutput(output, event) };
  } catch {
    // Any unexpected internal error is fail-open, never surfaced to the agent.
    return { stdout: undefined };
  } finally {
    await closeDatabase(db.value);
  }
}
