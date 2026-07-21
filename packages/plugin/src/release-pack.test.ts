/**
 * Release-package smoke test (WP-11c `test:package`). Assembles the publishable
 * `@iroha-labs/iroha` package and verifies, via `npm pack --dry-run`, that the
 * tarball is correct and installable: the right name, the plugin config + binary
 * + skills present, no source/tooling/workspace leakage, concrete dependency
 * versions, and no developer home path embedded in any shipped file
 * (compatibility.md §5). Runs only under `test:package` (needs the built `dist/`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./build-archive.js";
import { assembleRelease } from "./build-release.js";
import { PLUGIN_VERSION, PUBLISHED_PACKAGE_NAME } from "./metadata.js";

const execFileAsync = promisify(execFile);

let releaseDir: string;
let tarballPaths: string[];
let publishManifest: { name: string; version: string; dependencies: Record<string, string> };

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

beforeAll(async () => {
  releaseDir = await mkdtemp(join(tmpdir(), "iroha-release-"));
  await assembleRelease(releaseDir);
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: releaseDir,
  });
  const [meta] = JSON.parse(stdout) as [{ files: { path: string }[] }];
  tarballPaths = meta.files.map((f) => f.path);
  publishManifest = JSON.parse(await readFile(join(releaseDir, "package.json"), "utf8"));
}, 60_000);

afterAll(async () => {
  await rm(releaseDir, { recursive: true, force: true });
});

describe("published package.json", () => {
  it("is named @iroha-labs/iroha at the plugin version", () => {
    expect(publishManifest.name).toBe(PUBLISHED_PACKAGE_NAME);
    expect(publishManifest.version).toBe(PLUGIN_VERSION);
  });

  it("declares no workspace or unresolved dependency", () => {
    for (const [name, spec] of Object.entries(publishManifest.dependencies)) {
      expect(name.startsWith("@iroha/"), `workspace dep leaked: ${name}`).toBe(false);
      expect(spec, `unresolved spec for ${name}`).not.toMatch(/^(catalog:|workspace:)/);
    }
    expect(Object.keys(publishManifest.dependencies).length).toBeGreaterThan(0);
  });
});

describe("tarball contents", () => {
  it("ships the binary, both manifests, hook/MCP config, skills, and LICENSE", () => {
    for (const required of [
      "package.json",
      "LICENSE",
      "dist/bin.mjs",
      "migrations/001_initial.sql",
      "dashboard/index.html",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      "hooks/claude.json",
      "hooks/codex.json",
      ".mcp.json",
      "mcp.codex.json",
      "skills/init/SKILL.md",
      "skills/checkpoint/SKILL.md",
    ]) {
      expect(tarballPaths, `missing ${required}`).toContain(required);
    }
  });

  it("excludes source, tests, tooling, type declarations, and node_modules", () => {
    for (const path of tarballPaths) {
      expect(path, `leaked source/test: ${path}`).not.toMatch(/\.test\.|\/src\/|node_modules/);
      expect(path, `leaked type declaration: ${path}`).not.toMatch(/\.d\.mts$/);
      expect(path, `leaked build tooling: ${path}`).not.toMatch(/build-.*-cli|\/index\.mjs$/);
    }
  });
});

describe("no build-machine path leaks (compatibility.md §5)", () => {
  it("embeds no absolute build path (the repo root) in any shipped file", async () => {
    // §5 forbids exposing the developer's directory (e.g. via a source-map path);
    // authored placeholder examples like `/Users/alice` in bundled comments are
    // not that. The precise check is the actual build machine's absolute path.
    for (const file of await walk(releaseDir)) {
      const text = await readFile(file, "utf8");
      expect(text, `build path leaked in ${file}`).not.toContain(REPO_ROOT);
    }
  });
});

describe("assembled release is self-contained", () => {
  it("carries no node_modules", async () => {
    let hasNodeModules = true;
    try {
      await stat(join(releaseDir, "node_modules"));
    } catch {
      hasNodeModules = false;
    }
    expect(hasNodeModules).toBe(false);
  });
});

describe("the published binary runs from an installed layout", () => {
  it("runs `iroha init` and `doctor` — shipped assets resolve at package-relative paths", async () => {
    // A fresh staging package plus a `node_modules` linked to the plugin's own
    // (it declares exactly the runtime deps, including the native
    // `@libsql/client`) reproduces what `npm i -g @iroha-labs/iroha` provides,
    // WITHOUT the monorepo layout that masked the shipped-asset gap. Proves the
    // bundled CLI finds `migrations/` at `../migrations` (`iroha init`) and the
    // shipped platform manifests (`iroha doctor`) — the checks that would have
    // caught `iroha init` being dead on arrival in the published package.
    const stage = await mkdtemp(join(tmpdir(), "iroha-installed-"));
    const repo = await mkdtemp(join(tmpdir(), "iroha-init-"));
    const link = join(stage, "node_modules");
    const bin = join(stage, "dist", "bin.mjs");
    try {
      await assembleRelease(stage);
      await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), link);
      await execFileAsync("git", ["init", "-q"], { cwd: repo });
      await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "iroha test"], { cwd: repo });
      await execFileAsync("node", [bin, "init"], { cwd: repo });
      expect(existsSync(join(repo, ".iroha", "config.yaml"))).toBe(true);

      // `iroha doctor` validates the shipped platform manifests from the same
      // installed layout (doctor exits non-zero only on an `error` check, so
      // capture stdout either way).
      const { stdout } = await execFileAsync("node", [bin, "doctor", "--json"], {
        cwd: repo,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
      const report = JSON.parse(stdout) as {
        doctor: { checks: { name: string; status: string; message: string }[] };
      };
      const manifests = report.doctor.checks.find((c) => c.name === "plugin-manifests");
      expect(manifests?.status).toBe("ok");
      expect(manifests?.message).toContain("iroha@0.1.0");
    } finally {
      await rm(link, { force: true }); // unlink the symlink only, never its target
      await rm(stage, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
