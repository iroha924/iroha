import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { runDoctor } from "./doctor.js";
import { initRepository } from "./init-repository.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("runDoctor", () => {
  let repoDir: string | undefined;
  let bareDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
    if (bareDir) {
      await rm(bareDir, { recursive: true, force: true });
      bareDir = undefined;
    }
    vi.unstubAllEnvs();
  });

  it("reports node/git checks and a warning for an uninitialized repository", async () => {
    repoDir = await createTempGitRepo();

    const result = await runDoctor(repoDir, new CryptoRandomSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("node")?.status).toBe("ok");
    expect(byName.get("git")?.status).toBe("ok");
    expect(byName.get("git-repository")?.status).toBe("ok");
    expect(byName.get("iroha-init")?.status).toBe("warning");
    expect(byName.has("storage-capabilities")).toBe(false);
  });

  it("reports ok checks for an initialized repository", async () => {
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(init.ok).toBe(true);

    const result = await runDoctor(repoDir, new CryptoRandomSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("iroha-init")?.status).toBe("ok");
    expect(byName.get("storage-capabilities")?.status).toBe("ok");
    expect(byName.get("embedding-provider")?.message).toBe("disabled");
    expect(byName.get("forge-provider")?.message).toBe("disabled");
  });

  it("reports an error when run outside any Git repository", async () => {
    bareDir = await mkdtemp(join(tmpdir(), "iroha-doctor-no-git-"));

    const result = await runDoctor(bareDir, new CryptoRandomSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("git-repository")?.status).toBe("error");
    expect(byName.has("iroha-init")).toBe(false);
  });

  it("never includes the raw embedding API key value in the report", async () => {
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const secretValue = "voy-secret-do-not-leak-12345";
    vi.stubEnv("VOYAGE_API_KEY", secretValue);

    const configPath = join(init.value.irohaCanonicalDir, "config.yaml");
    const config = parse(await readFile(configPath, "utf8")) as {
      search: { embedding: { enabled: boolean } };
    };
    config.search.embedding.enabled = true;
    await writeFile(configPath, stringify(config), "utf8");

    const result = await runDoctor(repoDir, new CryptoRandomSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("embedding-provider")?.message).toContain("key set");
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(secretValue);
  });
});
