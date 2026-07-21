import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { checkPluginManifests, runDoctor } from "./doctor.js";
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

    const result = await runDoctor(repoDir);
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

    const result = await runDoctor(repoDir);
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

    const result = await runDoctor(bareDir);
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

    const result = await runDoctor(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("embedding-provider")?.message).toContain("key set");
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(secretValue);
  });

  async function enableForge(irohaCanonicalDir: string): Promise<void> {
    const configPath = join(irohaCanonicalDir, "config.yaml");
    const config = parse(await readFile(configPath, "utf8")) as { forge: { enabled: boolean } };
    config.forge.enabled = true;
    await writeFile(configPath, stringify(config), "utf8");
  }

  it("warns when forge is enabled but its token env var is not set", async () => {
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    vi.stubEnv("GITHUB_TOKEN", undefined);
    await enableForge(init.value.irohaCanonicalDir);

    const result = await runDoctor(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forge = new Map(result.value.checks.map((c) => [c.name, c])).get("forge-provider");
    expect(forge?.status).toBe("warning");
    expect(forge?.message).toContain("GITHUB_TOKEN is not set");
  });

  it("reports ok (and never leaks the token) when forge is enabled with its token set", async () => {
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const tokenValue = "forge-token-do-not-leak-9876";
    vi.stubEnv("GITHUB_TOKEN", tokenValue);
    await enableForge(init.value.irohaCanonicalDir);

    const result = await runDoctor(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forge = new Map(result.value.checks.map((c) => [c.name, c])).get("forge-provider");
    expect(forge?.status).toBe("ok");
    expect(forge?.message).toContain("token set");
    expect(JSON.stringify(result.value)).not.toContain(tokenValue);
  });

  it("reports a config error (not a silent 'nothing to check') when config.yaml cannot be read for a reason other than being absent", async () => {
    repoDir = await createTempGitRepo();
    const init = await initRepository(repoDir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    // A directory in place of the file reproduces a non-ENOENT readFile
    // failure (EISDIR) without relying on OS-specific permission bits.
    const configPath = join(init.value.irohaCanonicalDir, "config.yaml");
    await rm(configPath, { force: true });
    await mkdir(configPath);

    const result = await runDoctor(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.value.checks.map((c) => [c.name, c]));
    expect(byName.get("config")?.status).toBe("error");
  });
});

describe("checkPluginManifests", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function writeManifest(dir: string, name: string, body: string): Promise<void> {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "plugin.json"), body, "utf8");
  }

  it("reports ok with the plugin names when both manifests are well-formed", async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-pm-"));
    await writeManifest(
      root,
      ".claude-plugin",
      JSON.stringify({ name: "iroha", version: "0.1.0" }),
    );
    await writeManifest(root, ".codex-plugin", JSON.stringify({ name: "iroha", version: "0.1.0" }));
    const check = await checkPluginManifests(root);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("Claude iroha@0.1.0");
    expect(check.message).toContain("Codex iroha@0.1.0");
  });

  it("reports ok (not an error) when no manifest is present", async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-pm-"));
    const check = await checkPluginManifests(root);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("not running from an installed iroha plugin");
  });

  it("reports error when a present manifest is not valid JSON", async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-pm-"));
    await writeManifest(root, ".claude-plugin", "{ not json");
    const check = await checkPluginManifests(root);
    expect(check.status).toBe("error");
    expect(check.message).toContain("not valid JSON");
  });

  it("reports error when a present manifest is missing a required field", async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-pm-"));
    await writeManifest(root, ".codex-plugin", JSON.stringify({ version: "0.1.0" }));
    const check = await checkPluginManifests(root);
    expect(check.status).toBe("error");
    expect(check.message).toContain("missing a name");
  });
});
