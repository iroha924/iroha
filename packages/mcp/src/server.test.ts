import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, SystemClock } from "@iroha/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const APPROVAL_SUBSTRINGS = [
  "approve",
  "reject",
  "publish",
  "delete",
  "activate",
  "edit_canonical",
];

interface WireEnvelope {
  ok: boolean;
  error?: { code: string; message: string };
}

describe("MCP server over the wire (in-memory transport)", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function connectedClient(cwd: string): Promise<Client> {
    const server = buildServer({ cwd, clock: new SystemClock(), random: new CryptoRandomSource() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("lists all eight tools with input schemas and no approval operation", async () => {
    dir = await mkdtemp(join(tmpdir(), "iroha-mcp-wire-"));
    const client = await connectedClient(dir);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(8);
      expect(names).toContain("create_checkpoint");
      expect(names).toContain("get_session_state");
      for (const substring of APPROVAL_SUBSTRINGS) {
        expect(names.some((name) => name.includes(substring))).toBe(false);
      }
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
    }
  });

  it("returns a typed failure envelope for a call against an uninitialized repository", async () => {
    dir = await mkdtemp(join(tmpdir(), "iroha-mcp-wire-"));
    const client = await connectedClient(dir);
    try {
      const result = await client.callTool({
        name: "get_session_state",
        arguments: { sessionToken: `ist_${"A".repeat(43)}` },
      });
      const envelope = result.structuredContent as WireEnvelope;
      expect(result.isError).toBe(true);
      expect(envelope.ok).toBe(false);
      expect(typeof envelope.error?.code).toBe("string");
    } finally {
      await client.close();
    }
  });

  it("rejects an unknown input field as INVALID_INPUT over the wire", async () => {
    dir = await mkdtemp(join(tmpdir(), "iroha-mcp-wire-"));
    const client = await connectedClient(dir);
    try {
      const result = await client.callTool({
        name: "get_session_state",
        arguments: { sessionToken: `ist_${"A".repeat(43)}`, unexpected: true },
      });
      const envelope = result.structuredContent as WireEnvelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("INVALID_INPUT");
    } finally {
      await client.close();
    }
  });
});
