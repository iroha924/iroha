import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
    await writeApiKey("voyage", "pa-old");

    await writeApiKey("github", "gh-new");

    const voyage = await readApiKey("voyage");
    expect(voyage.ok && voyage.value).toBe("pa-old");
    const github = await readApiKey("github");
    expect(github.ok && github.value).toBe("gh-new");
  });

  it("does not live in a directory the product tells the user to commit", () => {
    const { dir } = credentialsLocation();

    // `.iroha` is the canonical directory iroha creates and README instructs the
    // reader to commit. Anyone keeping dotfiles in a repository rooted at $HOME
    // would then have the key in a tracked file.
    expect(basename(dir)).not.toBe(".iroha");
    expect(basename(dirname(dir))).not.toBe(".iroha");
  });

  it("ignores itself in Git, wherever it ends up", async () => {
    await writeApiKey("voyage", "pa-example");
    const { dir } = credentialsLocation();

    // ~/.config is itself commonly tracked in a dotfiles repository, so moving
    // out of .iroha removes the instruction to commit but not every way this
    // directory reaches a working tree.
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  it("keeps the concurrent writes of two providers, and leaves no temp file", async () => {
    // The dashboard's Settings page has one Save button per provider, so both
    // writes come from one process and can overlap. An unsynchronized
    // read-modify-write drops whichever key lost the race while reporting ok.
    const [voyage, github] = await Promise.all([
      writeApiKey("voyage", "pa-concurrent"),
      writeApiKey("github", "gh-concurrent"),
    ]);

    expect(voyage.ok && github.ok).toBe(true);
    const storedVoyage = await readApiKey("voyage");
    const storedGithub = await readApiKey("github");
    expect(storedVoyage.ok && storedVoyage.value).toBe("pa-concurrent");
    expect(storedGithub.ok && storedGithub.value).toBe("gh-concurrent");

    const { dir } = credentialsLocation();
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects a key an HTTP header cannot carry, rather than storing it", async () => {
    // Stored, this throws while undici builds `Authorization: Bearer <key>`,
    // which the provider cannot tell apart from a socket failure — so it is
    // reported as a retryable outage forever and the real cause never surfaces.
    for (const bad of ["pa-line-one\npa-line-two", "キー", "pa with space"]) {
      const written = await writeApiKey("voyage", bad);
      expect(written.ok, `must reject ${JSON.stringify(bad)}`).toBe(false);
    }

    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBeNull();
  });

  it("rejects a whole file pasted in place of a key", async () => {
    const written = await writeApiKey("voyage", "x".repeat(1001));

    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.code).toBe("INVALID_INPUT");
  });

  it("keeps a key a later version might add, instead of rejecting the whole file", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({ version: 1, voyage: { apiKey: "pa-good" }, gitlab: { apiKey: "x" } }),
      { encoding: "utf8", mode: 0o600 },
    );

    // A strict whole-file schema would make every install older than the version
    // that added `gitlab` report the voyage key it holds as missing.
    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBe("pa-good");

    await writeApiKey("github", "gh-new");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw.gitlab).toEqual({ apiKey: "x" });
    expect(raw.version).toBe(1);
  });

  it("can overwrite a corrupt file, so the dashboard is not a dead end", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, "{ not json", { encoding: "utf8", mode: 0o600 });

    // Refusing would leave the UI showing "Not set" with the only remedy — paste
    // the key again — failing on the same unreadable file.
    const written = await writeApiKey("voyage", "pa-repaired");

    expect(written.ok, written.ok ? "" : written.error.message).toBe(true);
    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBe("pa-repaired");
  });

  it("tightens a pre-existing directory rather than trusting its mode", async () => {
    const { dir } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);

    await writeApiKey("voyage", "pa-example");

    // ~/.config is usually 0755, and mkdir's mode applies only when it creates.
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  it("keeps a valid entry when the other provider's entry is malformed", async () => {
    const { dir, file } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({ voyage: { api_key: "wrong-field" }, github: { apiKey: "gh-valid" } }),
      { encoding: "utf8", mode: 0o600 },
    );

    // One bad entry must not make the other unreadable...
    const github = await readApiKey("github");
    expect(github.ok && github.value).toBe("gh-valid");
    const voyage = await readApiKey("voyage");
    expect(voyage.ok).toBe(false);

    // ...nor may repairing it delete the good one.
    const repaired = await writeApiKey("voyage", "pa-repaired");
    expect(repaired.ok, repaired.ok ? "" : repaired.error.message).toBe(true);
    const after = await readApiKey("github");
    expect(after.ok && after.value).toBe("gh-valid");
  });

  it("refuses to store a key when it cannot install the Git ignore", async () => {
    const { dir } = credentialsLocation();
    await mkdir(join(dir, ".gitignore"), { recursive: true, mode: 0o700 });

    // A directory named `.gitignore` cannot be created as a file and does not
    // ignore anything. Storing the key anyway is what lets a dotfiles worktree
    // commit it on the next `git add -A`.
    const written = await writeApiKey("voyage", "pa-example");

    expect(written.ok).toBe(false);
    const key = await readApiKey("voyage");
    expect(key.ok && key.value).toBeNull();
  });

  it("does not follow a symlinked .gitignore", async () => {
    const { dir } = credentialsLocation();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const shared = join(dir, "..", "shared-gitignore");
    await writeFile(shared, "node_modules\n", "utf8");
    await symlink(shared, join(dir, ".gitignore"));

    const written = await writeApiKey("voyage", "pa-example");

    // Overwriting the symlink's target would corrupt an unrelated file merely
    // because someone saved an API key.
    expect(await readFile(shared, "utf8")).toBe("node_modules\n");
    expect(written.ok).toBe(false);
  });

  it("ignores an XDG_CONFIG_HOME that would fold a .. before a symlink", () => {
    const withoutDots = credentialsLocation().dir;
    process.env.XDG_CONFIG_HOME = `${process.env.XDG_CONFIG_HOME}/link/..`;

    // `join` collapses `..` lexically, before the filesystem follows `link`, so
    // honouring this would place the key somewhere the user never named
    // (.claude/rules/path-and-symlink-safety.md).
    expect(credentialsLocation().dir).not.toContain("link");
    expect(credentialsLocation().dir).toBe(
      withoutDots.replace(/\.config[/\\]iroha$/, ".config/iroha"),
    );
  });
});
