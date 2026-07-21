import { startStdioServer } from "./start.js";

startStdioServer().catch((error: unknown) => {
  // Protocol frames own stdout; diagnostics go to stderr only (mcp-contract.md §2).
  process.stderr.write(
    `iroha mcp server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
