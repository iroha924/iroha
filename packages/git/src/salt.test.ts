import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
