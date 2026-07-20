import { CryptoRandomSource, SystemClock } from "@iroha/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

/** mcp-contract.md §2: SIGINT/SIGTERM closes connections within 500ms. */
const SHUTDOWN_GRACE_MS = 500;

export async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  // Protocol frames own stdout; diagnostics go to stderr only (mcp-contract.md §2).
  process.stderr.write(
    `iroha mcp server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
