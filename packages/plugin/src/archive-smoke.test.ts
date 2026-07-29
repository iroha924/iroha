/**
 * Package smoke test (WP-11 `test:package`). Verifies the built `iroha` binary
 * and the assembled thin archive against the acceptance criteria: platform
 * manifests validate, the archive works without an install script or a source
 * workspace, the MCP surface exposes no approval tool, and the hook is fail-open.
 * Runs only under `test:package` (which builds the package first) so `dist/bin.mjs`
 * exists; it is excluded from the default `test` task.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleArchive } from "./build-archive.js";
import {
  claudeHooksSchema,
  claudeManifestSchema,
  claudeMcpConfigSchema,
  codexHooksSchema,
  codexManifestSchema,
  codexMcpConfigSchema,
} from "./manifests.js";
import { PLUGIN_VERSION, SKILL_NAMES } from "./metadata.js";

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

let archiveDir: string;

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(join(archiveDir, relativePath), "utf8"));
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(join(archiveDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  archiveDir = await mkdtemp(join(tmpdir(), "iroha-archive-"));
  await assembleArchive(archiveDir);
});

afterAll(async () => {
  await rm(archiveDir, { recursive: true, force: true });
});

describe("assembled archive — platform manifests validate", () => {
  it("Claude manifest, hooks, and MCP config", async () => {
    expect(
      claudeManifestSchema.safeParse(await readJson(".claude-plugin/plugin.json")).success,
    ).toBe(true);
    expect(claudeHooksSchema.safeParse(await readJson("hooks/claude.json")).success).toBe(true);
    expect(claudeMcpConfigSchema.safeParse(await readJson(".mcp.json")).success).toBe(true);
  });

  it("Codex manifest, hooks, and MCP config", async () => {
    expect(codexManifestSchema.safeParse(await readJson(".codex-plugin/plugin.json")).success).toBe(
      true,
    );
    expect(codexHooksSchema.safeParse(await readJson("hooks/codex.json")).success).toBe(true);
    expect(codexMcpConfigSchema.safeParse(await readJson("mcp.codex.json")).success).toBe(true);
  });

  it("both manifests match the package version", async () => {
    expect(await readJson(".claude-plugin/plugin.json")).toMatchObject({ version: PLUGIN_VERSION });
    expect(await readJson(".codex-plugin/plugin.json")).toMatchObject({ version: PLUGIN_VERSION });
  });
});

describe("assembled archive — shared skills", () => {
  it("ships every skill with name + description frontmatter", async () => {
    for (const name of SKILL_NAMES) {
      const body = await readFile(join(archiveDir, "skills", name, "SKILL.md"), "utf8");
      expect(body.startsWith("---\n"), `${name} missing frontmatter`).toBe(true);
      expect(body, `${name} missing name`).toMatch(/^name:\s*\S/m);
      expect(body, `${name} missing description`).toMatch(/^description:\s*\S/m);
    }
  });
});

describe("assembled archive — thin (Option A)", () => {
  it("carries no runtime dist, native binaries, or node_modules", async () => {
    expect(await exists("dist")).toBe(false);
    expect(await exists("node_modules")).toBe(false);
    const top = await readdir(archiveDir);
    expect(top).not.toContain("node_modules");
  });

  it("embeds no developer absolute path", async () => {
    for (const file of [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      "hooks/claude.json",
      "hooks/codex.json",
      ".mcp.json",
      "mcp.codex.json",
    ]) {
      const text = await readFile(join(archiveDir, file), "utf8");
      expect(text, `${file} leaks a home path`).not.toContain("/Users/");
    }
  });
});

describe("built binary — MCP surface", () => {
  it("lists the agent tools and exposes no approval operation", async () => {
    const transport = new StdioClientTransport({ command: "node", args: [BIN, "__mcp"] });
    const client = new Client({ name: "iroha-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const expected of [
        "search",
        "get_context",
        "get_active_rules",
        "get_session_state",
        "get_relations",
        "create_checkpoint",
        "propose_knowledge",
        "link_entities",
      ]) {
        expect(names, `missing tool ${expected}`).toContain(expected);
      }
      for (const name of names) {
        expect(name, `approval-shaped tool leaked: ${name}`).not.toMatch(
          /approv|reject|publish|delete|activate|supersede/i,
        );
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("built binary — hook is fail-open", () => {
  it("returns no output and exits 0 outside an initialized repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "iroha-hook-"));
    try {
      const payload = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "s",
        cwd,
        source: "startup",
      });
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn("node", [BIN, "__hook", "claude"], { cwd });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.end(payload);
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("still exits 0 when the working directory is removed mid-run", async () => {
    // A long-lived agent may delete the hook's cwd (worktree cleanup, branch
    // switch). A transitive dep (`rc-config-loader` via `secretlint`) calls
    // `process.cwd()` at module load, which then throws `ENOENT` — the hook
    // must still fail open (exit 0), not crash the agent with a stack trace.
    const cwd = await mkdtemp(join(tmpdir(), "iroha-gone-"));
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn("node", [BIN, "__hook", "claude"], { cwd });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.on("close", (code) => resolve({ code, stdout }));
      // Remove the cwd out from under the running child, then let it proceed.
      rm(cwd, { recursive: true, force: true }).finally(() => {
        child.stdin.end(
          JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: "s",
            cwd,
            source: "startup",
          }),
        );
      });
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  }, 30_000);
});
