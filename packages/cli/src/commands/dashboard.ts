import { spawn } from "node:child_process";
import { startDashboardServer } from "@iroha/api";
import { resolveInitializedRepository } from "@iroha/core";
import { define } from "gunshi";
import { printError } from "../output.js";

/** Best-effort open of the loopback URL in the default browser; never fails the command. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort — the URL is always printed for manual opening
  }
}

/** Resolves when the process receives SIGINT/SIGTERM, so the dashboard runs until interrupted. */
function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

/**
 * Launches the local dashboard (dashboard-api.md §3). Validates the repository
 * is initialized first, then binds the Hono API to `127.0.0.1` on a random
 * port and prints the loopback URL with the one-time launch token. Runs until
 * SIGINT/SIGTERM, then closes the listener.
 */
export const dashboardCommand = define({
  name: "dashboard",
  description: "Launch the local dashboard on 127.0.0.1",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
    "no-open": { type: "boolean", description: "Do not open the browser" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;

    const repo = await resolveInitializedRepository(process.cwd());
    if (!repo.ok) {
      printError(json, repo.error);
      return;
    }

    const server = await startDashboardServer({ cwd: process.cwd() });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, url: server.url, port: server.port })}\n`);
    } else {
      process.stdout.write(`iroha dashboard listening at ${server.url}\n`);
      process.stdout.write("Press Ctrl+C to stop.\n");
    }

    if (ctx.values["no-open"] !== true) {
      openBrowser(server.url);
    }

    await waitForShutdown();
    await server.close();
  },
});
