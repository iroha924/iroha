import { type ServerType, serve } from "@hono/node-server";
import { CryptoRandomSource, SystemClock } from "@iroha/core";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";

export interface DashboardServer {
  /** `http://127.0.0.1:<port>/#token=<launchToken>` — opened in the browser unless `--no-open`. */
  url: string;
  port: number;
  launchToken: string;
  close(): Promise<void>;
}

export interface StartDashboardOptions {
  cwd: string;
  /** Fixed port for tests/repeatability; `0` (default) binds an available random port. */
  port?: number;
  /** Fixed launch token for tests; otherwise a fresh 256-bit token per start. */
  launchToken?: string;
}

/**
 * Starts the dashboard's local API bound to `127.0.0.1` on a random port
 * (dashboard-api.md §3). Never binds `0.0.0.0`. Returns the loopback URL with
 * the one-time launch token in the fragment plus a `close()` that stops the
 * listener.
 */
export async function startDashboardServer(
  options: StartDashboardOptions,
): Promise<DashboardServer> {
  const random = new CryptoRandomSource();
  const clock = new SystemClock();
  const auth = createAuth(random, options.launchToken);
  const app = createApp({ cwd: options.cwd, clock, random, auth });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port ?? 0 }, () =>
      resolve(s),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  const url = `http://127.0.0.1:${port}/#token=${encodeURIComponent(auth.launchToken)}`;

  return {
    url,
    port,
    launchToken: auth.launchToken,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
