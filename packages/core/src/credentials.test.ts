import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsLocation, hasApiKey, readApiKey, writeApiKey } from "./credentials.js";
import { useTempHome } from "./test-helpers/credentials-home.js";

/**
 * `credentialsLocation` resolves from the home directory, so each test gets its
 * own — the credentials file is machine-scoped by design and has no repository
 * to be seeded under.
 */
let restoreHome: (() => Promise<void>) | undefined;

beforeEach(async () => {
  restoreHome = (await useTempHome()).restore;
});

afterEach(async () => {
  await restoreHome?.();
  restoreHome = undefined;
});

describe("credentials", () => {
  it("reports no key before anything is stored", async () => {
    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBeNull();
    const present = await hasApiKey("voyage");
    expect(present.ok && present.value).toBe(false);
  });

  it("stores a key and reads it back", async () => {
    const written = await writeApiKey("voyage", "pa-example");
    expect(written.ok).toBe(true);

    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBe("pa-example");
  });

  it("creates the file 0600 and the directory 0700", async () => {
    await writeApiKey("voyage", "pa-example");
    const { dir, file } = credentialsLocation();

    // Under the default umask a plain write lands 0644. A secret must not be
    // readable by every account on the machine.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reads the current value rather than one cached from an earlier call", async () => {
    await writeApiKey("voyage", "pa-first");
    const first = await readApiKey("voyage");
    expect(first.ok && first.value).toBe("pa-first");

    // Rotating the key has to take effect without restarting anything — the
    // whole reason the key does not live in an environment variable (ADR-018).
    await writeApiKey("voyage", "pa-second");

    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBe("pa-second");
  });

  it("keeps the key out of the error when the file is unreadable", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, "{ not json", { encoding: "utf8", mode: 0o600 });

    const key = await readApiKey("voyage");

    expect(key.ok).toBe(false);
    if (key.ok) return;
    // The message names neither the absolute path nor the body: a malformed file
    // could hold a real key, and an error is exactly where it must not surface.
    expect(key.error.message).not.toContain(file);
    expect(key.error.message).not.toContain("not json");
  });

  it("rejects an empty key rather than storing one that cannot work", async () => {
    const written = await writeApiKey("voyage", "   ");

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.code).toBe("INVALID_INPUT");
    const present = await hasApiKey("voyage");
    expect(present.ok && present.value).toBe(false);
  });

  it("trims surrounding whitespace, which a paste routinely carries", async () => {
    await writeApiKey("voyage", "  pa-example\n");

    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBe("pa-example");
  });

  it("rejects a file whose shape does not match instead of ignoring the key", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A silently ignored key reads exactly like a missing one, which is the
    // failure this change exists to remove.
    await writeFile(file, JSON.stringify({ voyage: { api_key: "pa-x" } }), "utf8");

    const key = await readApiKey("voyage");
    expect(key.ok).toBe(false);
  });

  it("leaves another provider's entry alone when one is written", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ voyage: { apiKey: "pa-old" } }), "utf8");
    await chmod(file, 0o600);

    await writeApiKey("voyage", "pa-new");

    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, { apiKey: string }>;
    expect(raw.voyage?.apiKey).toBe("pa-new");
  });
});
