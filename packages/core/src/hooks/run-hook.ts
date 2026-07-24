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

// Half the §7 (hooks-contract.md) hook-timeout budget per event. Repository
// resolution runs up to five `git rev-parse` calls; capping each at half the
// budget bounds a hung `git` (stale mount, wedged fsmonitor) to well under the
// platform's hook kill deadline — resolution short-circuits on the first
// failure — instead of `runGit`'s 10s default, which is 20x the tightest budget.
const RESOLUTION_GIT_TIMEOUT_MS: Record<string, number> = {
  SessionStart: 1500,
  UserPromptSubmit: 750,
  PreToolUse: 250,
  PostToolUse: 375,
  PreCompact: 500,
  PostCompact: 500,
  Stop: 1000,
  SessionEnd: 750,
};
const DEFAULT_RESOLUTION_GIT_TIMEOUT_MS = 250;

function resolutionGitTimeoutMs(raw: unknown): number {
  const name = (raw as { hook_event_name?: unknown } | null)?.hook_event_name;
  // `Object.hasOwn` so a prototype-key name ("__proto__", "toString", ...) reads
  // the default, not an inherited non-number that would reach `runGit`'s timeout.
  if (typeof name !== "string" || !Object.hasOwn(RESOLUTION_GIT_TIMEOUT_MS, name)) {
    return DEFAULT_RESOLUTION_GIT_TIMEOUT_MS;
  }
  return RESOLUTION_GIT_TIMEOUT_MS[name] ?? DEFAULT_RESOLUTION_GIT_TIMEOUT_MS;
}

/**
 * Execute one hook invocation end to end: resolve the repository from `cwd`,
 * normalize the raw input, run the event use case, and return the platform
 * output. Outside an initialized repository it returns no output. Every internal
 * failure is fail-open (hooks-contract.md §2/§7): the hook never blocks the agent
 * on an iroha error — it returns no output and lets the agent proceed.
 */
export async function runHook(invocation: HookInvocation, deps: HookDeps): Promise<HookResult> {
  const repo = await resolveInitializedRepository(
    invocation.cwd,
    resolutionGitTimeoutMs(invocation.raw),
  );
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
      cwd: invocation.cwd,
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
