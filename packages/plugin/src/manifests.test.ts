import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("hook coverage", () => {
  it("registers every P0 hook event on both platforms", () => {
    const claude = buildClaudeHooks();
    const codex = buildCodexHooks().hooks;
    for (const { event } of HOOK_EVENTS) {
      expect(claude[event], `Claude missing ${event}`).toBeDefined();
      expect(codex[event], `Codex missing ${event}`).toBeDefined();
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
