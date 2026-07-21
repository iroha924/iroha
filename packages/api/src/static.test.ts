import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

function makeApp(staticRoot: string): Hono {
  return createApp({
    cwd: process.cwd(),
    clock,
    random,
    auth: createAuth(random, "launch-token"),
    staticRoot,
  }) as unknown as Hono;
}

describe("static SPA serving", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      dir = undefined;
    }
  });

  it("serves assets and falls back to index.html for direct client routes", async () => {
    dir = await mkdtemp(join(tmpdir(), "iroha-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><div id=root>iroha app</div>");
    await writeFile(join(dir, "app.js"), "export const x = 1;");

    const app = makeApp(dir);

    const asset = await app.request("/app.js", { headers: { Host: "127.0.0.1" } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    // Static responses still carry the security headers.
    expect(asset.headers.get("content-security-policy")).toContain("default-src 'self'");

    // A client-side route (no matching file) falls back to index.html.
    const route = await app.request("/review/cand_123", { headers: { Host: "127.0.0.1" } });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("iroha app");

    // An unknown API path is handled by the API layer (401 without a cookie),
    // never falling through to the SPA index.
    const apiPath = await app.request("/api/v1/nope", { headers: { Host: "127.0.0.1" } });
    expect(apiPath.status).toBe(401);
  });
});
