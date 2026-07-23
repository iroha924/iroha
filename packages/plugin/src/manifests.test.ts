import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeHookAdapter } from "@iroha/adapter-claude";
import { codexHookAdapter } from "@iroha/adapter-codex";
import { describe, expect, it } from "vitest";
import {
  buildClaudeHooks,
  buildClaudeManifest,
  buildClaudeMcpConfig,
  buildCodexHooks,
  buildCodexManifest,
  buildCodexMcpConfig,
  claudeHooksSchema,
  claudeManifestSchema,
  claudeMcpConfigSchema,
  codexHooksSchema,
  codexManifestSchema,
  codexMcpConfigSchema,
} from "./manifests.js";
import { HOOK_EVENTS, PLUGIN_VERSION } from "./metadata.js";

describe("manifest generators produce schema-valid output", () => {
  it("Claude plugin manifest", () => {
    expect(claudeManifestSchema.safeParse(buildClaudeManifest()).success).toBe(true);
  });

  it("Codex plugin manifest", () => {
    expect(codexManifestSchema.safeParse(buildCodexManifest()).success).toBe(true);
  });

  it("Claude hook config", () => {
    expect(claudeHooksSchema.safeParse(buildClaudeHooks()).success).toBe(true);
  });

  it("Codex hook config", () => {
    expect(codexHooksSchema.safeParse(buildCodexHooks()).success).toBe(true);
  });

  it("Claude MCP config", () => {
    expect(claudeMcpConfigSchema.safeParse(buildClaudeMcpConfig()).success).toBe(true);
  });

  it("Codex MCP config", () => {
    expect(codexMcpConfigSchema.safeParse(buildCodexMcpConfig()).success).toBe(true);
  });
});

/**
 * Every platform event name in hooks-contract.md §3. A name the adapter
 * understands but the manifest does not subscribe is a hook that can never fire
 * in an installed plugin — the defect this list exists to catch.
 */
const PLATFORM_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "PostToolUseFailure",
  "StopFailure",
  "InstructionsLoaded",
  "TaskCreated",
  "TaskCompleted",
];

const PROBE_CONTEXT = {
  digest: () => "hmac-sha256:probe" as const,
  newEventId: () => "evt_probe",
  occurredAt: () => "2026-01-01T00:00:00.000Z",
};

/**
 * An adapter answers `ok(null)` for an event it has no case for, and an
 * `INVALID_INPUT` error for one it handles but whose payload is incomplete — so
 * a name-only payload separates "understood" from "ignored" without having to
 * construct a valid body per event.
 */
function understoodEvents(adapter: typeof claudeHookAdapter): string[] {
  return PLATFORM_EVENT_NAMES.filter((event) => {
    const parsed = adapter.parseEvent({ hook_event_name: event }, PROBE_CONTEXT);
    return !(parsed.ok && parsed.value === null);
  });
}

describe("hook coverage", () => {
  it("subscribes every event the Claude adapter understands", () => {
    const claude = buildClaudeHooks();
    const understood = understoodEvents(claudeHookAdapter);
    expect(understood).toContain("SessionEnd");
    for (const event of understood) {
      expect(claude[event], `Claude manifest does not subscribe ${event}`).toBeDefined();
    }
  });

  it("subscribes every event the Codex adapter understands, and nothing it does not", () => {
    const codex = buildCodexHooks().hooks;
    const understood = understoodEvents(codexHookAdapter);
    for (const event of understood) {
      expect(codex[event], `Codex manifest does not subscribe ${event}`).toBeDefined();
    }
    // Codex has no SessionEnd (hooks-contract.md §3); subscribing it would
    // register a handler for an event that never arrives.
    expect(Object.keys(codex)).not.toContain("SessionEnd");
  });

  it("registers every declared hook event on Claude, and the portable ones on Codex", () => {
    const claude = buildClaudeHooks();
    const codex = buildCodexHooks().hooks;
    for (const { event, claudeOnly } of HOOK_EVENTS) {
      expect(claude[event], `Claude missing ${event}`).toBeDefined();
      if (claudeOnly) {
        expect(codex[event], `Codex should not register ${event}`).toBeUndefined();
      } else {
        expect(codex[event], `Codex missing ${event}`).toBeDefined();
      }
    }
  });

  it("dispatches every hook through the iroha binary for the right platform", () => {
    expect(buildClaudeHooks().SessionStart?.[0]?.hooks[0]?.args).toEqual(["__hook", "claude"]);
    expect(buildCodexHooks().hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("iroha __hook codex");
  });
});

describe("version consistency", () => {
  it("keeps PLUGIN_VERSION and both manifests in lockstep with package.json", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(buildClaudeManifest()).toMatchObject({ version: pkg.version });
    expect(buildCodexManifest()).toMatchObject({ version: pkg.version });
  });
});
