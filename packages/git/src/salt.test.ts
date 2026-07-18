import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedRandomSource } from "@iroha/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRepositorySalt } from "./salt.js";
import { removeTempDir } from "./test-helpers/tmp-repo.js";

describe("ensureRepositorySalt", () => {
  let tempRoot: string;
  let irohaDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "iroha-salt-test-"));
    irohaDir = join(tempRoot, "iroha");
  });

  afterEach(async () => {
    await removeTempDir(tempRoot);
  });

  it("generates and persists a 32-byte salt on first call", async () => {
    const result = await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(32);
    }

    const written = JSON.parse(await readFile(join(irohaDir, "local-config.json"), "utf8"));
    expect(typeof written.repositorySalt).toBe("string");
  });

  it("creates the salt file readable/writable by the owner only", async () => {
    await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    // Windows has no POSIX rwxrwxrwx permission model, so this is only
    // meaningful — and only tested — on POSIX platforms.
    if (process.platform !== "win32") {
      const fileStat = await stat(join(irohaDir, "local-config.json"));
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("returns the same salt on a second call instead of regenerating", async () => {
    const first = await ensureRepositorySalt(
      irohaDir,
      new FixedRandomSource(new Uint8Array(32).fill(1)),
    );
    const second = await ensureRepositorySalt(
      irohaDir,
      new FixedRandomSource(new Uint8Array(32).fill(2)),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
    }
  });

  it("preserves unrelated fields already present in local-config.json", async () => {
    await mkdir(irohaDir, { recursive: true });
    await writeFile(
      join(irohaDir, "local-config.json"),
      JSON.stringify({ someOtherField: "keep-me" }),
      "utf8",
    );

    await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    const written = JSON.parse(await readFile(join(irohaDir, "local-config.json"), "utf8"));
    expect(written.someOtherField).toBe("keep-me");
    expect(typeof written.repositorySalt).toBe("string");
  });

  it("fails instead of silently rotating the salt when local-config.json is malformed", async () => {
    await mkdir(irohaDir, { recursive: true });
    const configPath = join(irohaDir, "local-config.json");
    await writeFile(configPath, "{ not valid json", "utf8");

    const result = await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    expect(result.ok).toBe(false);
    // The malformed file must be left untouched, not overwritten with a
    // freshly rotated salt that would break digest comparability with any
    // prior session that already used the original (unreadable) salt.
    expect(await readFile(configPath, "utf8")).toBe("{ not valid json");
  });

  it("fails instead of silently rotating the salt when repositorySalt is present but undecodable", async () => {
    await mkdir(irohaDir, { recursive: true });
    const configPath = join(irohaDir, "local-config.json");
    // Wrong length after base64url decode (not the required 32 bytes) —
    // syntactically valid JSON, but semantically corrupt.
    await writeFile(configPath, JSON.stringify({ repositorySalt: "not-a-valid-salt" }), "utf8");

    const result = await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    expect(result.ok).toBe(false);
    // A silently minted replacement salt would fork future digests from
    // rows already hashed with the old (now-lost) key with no error raised.
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.repositorySalt).toBe("not-a-valid-salt");
  });

  it.each([
    ["null", "null"],
    ["a bare string", '"just a string"'],
    ["an array", "[1, 2, 3]"],
  ])(
    "fails instead of silently rotating the salt when local-config.json is %s",
    async (_label, jsonContent) => {
      await mkdir(irohaDir, { recursive: true });
      const configPath = join(irohaDir, "local-config.json");
      await writeFile(configPath, jsonContent, "utf8");

      const result = await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

      expect(result.ok).toBe(false);
      // Silently treating this as "no config yet" would mint and persist a
      // new salt over content that was never actually verified absent.
      expect(await readFile(configPath, "utf8")).toBe(jsonContent);
    },
  );

  it("does not embed the absolute irohaDir path in the error", async () => {
    await mkdir(irohaDir, { recursive: true });
    await writeFile(join(irohaDir, "local-config.json"), "{ not valid json", "utf8");

    const result = await ensureRepositorySalt(irohaDir, new CryptoRandomSource());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // mcp-contract.md §8: filesystem absolute paths are never returned to
      // the model, and IrohaError.message/details can reach MCP responses.
      expect(result.error.message.includes(irohaDir)).toBe(false);
      expect(JSON.stringify(result.error.details ?? {}).includes(irohaDir)).toBe(false);
    }
  });
});
