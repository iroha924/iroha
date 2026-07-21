import { CryptoRandomSource, SystemClock } from "@iroha/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

/** mcp-contract.md §2: SIGINT/SIGTERM closes connections within 500ms. */
const SHUTDOWN_GRACE_MS = 500;

/**
 * Build the iroha MCP server, connect it over stdio, and install SIGINT/SIGTERM
 * handlers that close it within the grace window. Resolves once the transport is
 * connected; the process then stays alive serving the agent host. Reused by both
 * the standalone `main.ts` entrypoint and the `iroha __mcp` binary dispatch
 * (WP-11), so the stdio wiring exists in exactly one place.
 */
export async function startStdioServer(): Promise<void> {
  const server = buildServer({
    cwd: process.cwd(),
    clock: new SystemClock(),
    random: new CryptoRandomSource(),
  });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    const timer = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    timer.unref();
    void server.close().finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}
