import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, runInit, SystemClock } from "@iroha/core";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchTool } from "./dispatch.js";
import type { McpEnvelope } from "./envelope.js";
import { buildServer, SERVER_INSTRUCTIONS } from "./server.js";
import { TOOLS } from "./tools/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const ctx = { cwd: "/nonexistent-cwd", clock: new SystemClock(), random: new CryptoRandomSource() };

function envelopeOf(result: { structuredContent?: unknown }): McpEnvelope<unknown> {
  return result.structuredContent as McpEnvelope<unknown>;
}

async function removeDir(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === 5) return;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

describe("dispatchTool", () => {
  it("returns a NOT_FOUND envelope for an unknown tool", async () => {
    const result = await dispatchTool("does_not_exist", {}, ctx);
    const env = envelopeOf(result);
    expect(result.isError).toBe(true);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("NOT_FOUND");
    }
    expect(env.traceId).toMatch(/^trc_[0-9a-f]{32}$/);
  });

  it("rejects an oversize request with LIMIT_EXCEEDED before running the tool", async () => {
    const result = await dispatchTool(
      "get_session_state",
      { sessionToken: `ist_${"A".repeat(300 * 1024)}` },
      ctx,
    );
    const env = envelopeOf(result);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("LIMIT_EXCEEDED");
    }
  });

  it("rejects an unknown input field with INVALID_INPUT", async () => {
    const result = await dispatchTool(
      "get_session_state",
      { sessionToken: `ist_${"A".repeat(43)}`, unexpected: true },
      ctx,
    );
    const env = envelopeOf(result);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("INVALID_INPUT");
      expect(env.error.message).toContain("unexpected");
    }
  });

  it("wraps a valid request that resolves no repository as a typed failure envelope", async () => {
    const result = await dispatchTool(
      "get_session_state",
      { sessionToken: `ist_${"A".repeat(43)}` },
      ctx,
    );
    const env = envelopeOf(result);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(typeof env.error.code).toBe("string");
      expect(env.error.message).not.toContain("ist_");
    }
  });

  it("attaches degraded-mode warnings to a successful search envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iroha-mcp-dispatch-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      const init = await runInit(dir, MIGRATIONS_DIR);
      expect(init.ok).toBe(true);

      const result = await dispatchTool(
        "search",
        { query: "anything", mode: "hybrid" },
        { cwd: dir, clock: new SystemClock(), random: new CryptoRandomSource() },
      );
      const env = envelopeOf(result);
      expect(env.ok).toBe(true);
      if (env.ok) {
        expect(env.warnings.some((warning) => warning.code === "degraded")).toBe(true);
      }
    } finally {
      await removeDir(dir);
    }
  }, 15000);
});

describe("tool registry", () => {
  it("exposes the eight agent tools and no human-approval operation", () => {
    const names = TOOLS.map((tool) => tool.name);
    for (const expected of [
      "search",
      "get_context",
      "get_active_rules",
      "get_relations",
      "get_session_state",
      "create_checkpoint",
      "propose_knowledge",
      "link_entities",
    ]) {
      expect(names).toContain(expected);
    }
    for (const forbidden of [
      "approve",
      "reject",
      "publish",
      "delete",
      "activate",
      "edit_canonical",
    ]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});

describe("server", () => {
  it("has self-contained instructions within the 512-character budget", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS).toContain("iroha");
    expect(SERVER_INSTRUCTIONS.slice(0, 512)).toContain("Human approval");
  });

  it("builds without throwing", () => {
    expect(() => buildServer(ctx)).not.toThrow();
  });
});
