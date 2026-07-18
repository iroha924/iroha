import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRealpath, toRepoRelativePath } from "./paths.js";
import { removeTempDir } from "./test-helpers/tmp-repo.js";

describe("toRepoRelativePath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-paths-test-"));
    outside = await mkdtemp(join(tmpdir(), "iroha-paths-outside-"));
    await mkdir(join(root, "nested", "空 folder with spaces"), { recursive: true });
    await writeFile(join(root, "nested", "空 folder with spaces", "file.txt"), "hi", "utf8");
  });

  afterEach(async () => {
    await removeTempDir(root);
    await removeTempDir(outside);
  });

  it("returns a posix-style relative path for a normal nested file", async () => {
    const target = join(root, "nested", "空 folder with spaces", "file.txt");

    const result = await toRepoRelativePath(root, target);

    expect(result).toEqual({
      ok: true,
      value: "nested/空 folder with spaces/file.txt",
    });
  });

  it("returns an empty string for the root itself", async () => {
    const result = await toRepoRelativePath(root, root);

    expect(result).toEqual({ ok: true, value: "" });
  });

  it("accepts a not-yet-existing path under an existing directory", async () => {
    const target = join(root, "nested", "not-created-yet.txt");

    const result = await toRepoRelativePath(root, target);

    expect(result).toEqual({ ok: true, value: "nested/not-created-yet.txt" });
  });

  it("rejects a literal ../ traversal outside the root", async () => {
    const target = join(root, "..", "etc", "passwd");

    const result = await toRepoRelativePath(root, target);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("accepts a legitimate filename that merely starts with two dots", async () => {
    await writeFile(join(root, "..config"), "not traversal", "utf8");

    const result = await toRepoRelativePath(root, join(root, "..config"));

    expect(result).toEqual({ ok: true, value: "..config" });
  });

  it("accepts a legitimate directory name that starts with two dots", async () => {
    await mkdir(join(root, "..foo"), { recursive: true });
    await writeFile(join(root, "..foo", "file.txt"), "not traversal", "utf8");

    const result = await toRepoRelativePath(root, join(root, "..foo", "file.txt"));

    expect(result).toEqual({ ok: true, value: "..foo/file.txt" });
  });

  it("rejects a symlink inside the root that escapes to outside it", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret", "utf8");
    const escapeLink = join(root, "escape");
    await symlink(outside, escapeLink);

    const result = await toRepoRelativePath(root, join(escapeLink, "secret.txt"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a dangling symlink inside the root whose target is outside it", async () => {
    // The target does not exist yet (e.g. a file about to be written through
    // the symlink) — fs.realpath fails with ENOENT for the link itself, which
    // must not be mistaken for "this path doesn't exist yet, treat it as a
    // literal in-repo path".
    const danglingLink = join(root, "escape-dangling");
    await symlink(join(outside, "not-created-yet.txt"), danglingLink);

    const result = await toRepoRelativePath(root, danglingLink);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("returns an error Result instead of throwing on a symlink cycle", async () => {
    const a = join(root, "cycle-a");
    const b = join(root, "cycle-b");
    await symlink(b, a);
    await symlink(a, b);

    const result = await toRepoRelativePath(root, a);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("accepts a symlink inside the root that stays inside it", async () => {
    const realDir = join(root, "real-target");
    await mkdir(realDir);
    await writeFile(join(realDir, "file.txt"), "hi", "utf8");
    const innerLink = join(root, "inner-link");
    await symlink(realDir, innerLink);

    const result = await toRepoRelativePath(root, join(innerLink, "file.txt"));

    expect(result).toEqual({ ok: true, value: "real-target/file.txt" });
  });
});

describe("safeRealpath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "iroha-safe-realpath-test-"));
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("resolves an existing path exactly like fs.realpath", async () => {
    const result = await safeRealpath(root);
    expect(result).toBe(await realpath(root));
  });

  it("resolves a deeply non-existent path by walking up to the nearest real ancestor", async () => {
    const target = join(root, "a", "b", "c.txt");

    const result = await safeRealpath(target);

    expect(result).toBe(join(await realpath(root), "a", "b", "c.txt"));
  });

  it("follows a dangling symlink to its (also nonexistent) target instead of treating it literally", async () => {
    const link = join(root, "dangling-link");
    await symlink(join(root, "nested", "missing.txt"), link);

    const result = await safeRealpath(link);

    expect(result).toBe(join(await realpath(root), "nested", "missing.txt"));
  });

  it("throws instead of looping forever on a symlink cycle", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await symlink(b, a);
    await symlink(a, b);

    await expect(safeRealpath(a)).rejects.toThrow(/symbolic links/);
  });
});
