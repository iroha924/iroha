import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepositoryPeople } from "./people.js";
import { runGit } from "./run-git.js";
import { commitFile, createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

async function commitAs(dir: string, name: string, email: string, file: string): Promise<void> {
  await runGit(["config", "user.name", name], { cwd: dir });
  await runGit(["config", "user.email", email], { cwd: dir });
  await commitFile(dir, file, name);
}

/** Every case sets the identity last, so `self` never doubles as an author under test. */
const IDENTITY = "the-reviewer";

async function setIdentity(dir: string, name: string): Promise<void> {
  await runGit(["config", "user.name", name], { cwd: dir });
}

describe("readRepositoryPeople", () => {
  it("returns distinct commit authors in code-unit order, with the configured identity as self", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "zoe", "zoe@example.com", "a.txt");
      await commitAs(dir, "alice", "alice@example.com", "b.txt");
      await commitAs(dir, "zoe", "zoe@example.com", "c.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["alice", IDENTITY, "zoe"]);
      expect(result.value.self).toBe(IDENTITY);
    } finally {
      await removeTempDir(dir);
    }
  });

  // The identity is distinct from every author, so this fails if the author
  // loop stops collecting — it cannot pass on `names.add(self)` alone.
  it("excludes forge app authors while still collecting the human ones", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "dependabot[bot]", "dependabot[bot]@example.com", "a.txt");
      await commitAs(dir, "iroha924", "iroha924@example.com", "b.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["iroha924", IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("keeps a forge app identity out of the list and out of the prefill", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await setIdentity(dir, "ci-runner[bot]");

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["alice"]);
      expect(result.value.self).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("includes the configured identity even when it has never committed", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await setIdentity(dir, "newcomer");

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["alice", "newcomer"]);
      expect(result.value.self).toBe("newcomer");
    } finally {
      await removeTempDir(dir);
    }
  });

  // `--all` rather than the HEAD-only default: exit 0 with no output, not 128.
  it("reports no authors on a repository with no commits", async () => {
    const dir = await createTempGitRepo();
    try {
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual([IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("sees an author who has only committed on another branch", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await runGit(["checkout", "-q", "-b", "feature"], { cwd: dir });
      await commitAs(dir, "bob", "bob@example.com", "b.txt");
      await runGit(["checkout", "-q", "main"], { cwd: dir });
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toContain("bob");
    } finally {
      await removeTempDir(dir);
    }
  });

  // `log.showSignature` makes Git write verification text to the same stdout as
  // the formatted output; without --no-show-signature those lines become people,
  // and in a real checkout they carry the absolute path of the signers file.
  it("does not read signature-verification output as author names", async () => {
    const dir = await createTempGitRepo();
    try {
      await runGit(["config", "gpg.format", "ssh"], { cwd: dir });
      const keyPath = join(dir, "signing-key");
      await runGit(["config", "user.signingkey", `${keyPath}.pub`], { cwd: dir });
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], (error) =>
          error ? reject(error) : resolve(),
        );
      });
      await runGit(["config", "commit.gpgsign", "true"], { cwd: dir });
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await runGit(["config", "log.showSignature", "true"], { cwd: dir });
      await setIdentity(dir, IDENTITY);

      // Confirms the contamination this guards against is actually present here.
      const raw = await runGit(["log", "--all", "--format=%aN"], { cwd: dir });
      expect(raw.ok).toBe(true);
      if (raw.ok) {
        expect(raw.value.split("\n").length).toBeGreaterThan(1);
      }

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["alice", IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("drops a name longer than the reviewer field accepts", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "x".repeat(121), "long@example.com", "a.txt");
      await commitAs(dir, "y".repeat(120), "ok@example.com", "b.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual([IDENTITY, "y".repeat(120)]);
    } finally {
      await removeTempDir(dir);
    }
  });

  // Every fixture here is mixed case and accented on purpose: with lowercase
  // ASCII only, code-unit order and localeCompare agree and the assertion
  // cannot tell which comparator is in use.
  it("orders by code unit, which localeCompare would not produce", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "Zoe", "zoe.upper@example.com", "a.txt");
      await commitAs(dir, "alice", "alice@example.com", "b.txt");
      await commitAs(dir, "zoe", "zoe@example.com", "c.txt");
      await commitAs(dir, "Ärger", "arger@example.com", "d.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const withoutSelf = result.value.names.filter((n) => n !== IDENTITY);
      expect(withoutSelf).toEqual(["Zoe", "alice", "zoe", "Ärger"]);
      // The comparator this replaced would sort them this other way.
      expect(withoutSelf).not.toEqual([...withoutSelf].sort((a, b) => a.localeCompare(b)));
    } finally {
      await removeTempDir(dir);
    }
  });

  // `i18n.logOutputEncoding` re-encodes the author ident on the same stdout,
  // producing a mojibake twin that passes every other filter. `git config` is
  // not re-encoded, which is why the corrupted spelling shows up as a duplicate.
  it("is not fooled by i18n.logOutputEncoding", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "José Müller", "jose@example.com", "a.txt");
      await runGit(["config", "i18n.logOutputEncoding", "ISO-8859-1"], { cwd: dir });
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["José Müller", IDENTITY]);
      expect(result.value.names.join("")).not.toContain("�");
    } finally {
      await removeTempDir(dir);
    }
  });

  // `--all` widens the failure surface: any unresolvable ref fails the walk.
  // The picker is a suggestion, so that must not take the endpoint down.
  it("falls back to HEAD when a broken ref fails the all-refs walk", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice", "alice@example.com", "a.txt");
      await setIdentity(dir, IDENTITY);
      await writeFile(join(dir, ".git", "refs", "heads", "broken"), `${"0".repeat(39)}1\n`, "utf8");

      // Confirms the walk this falls back from genuinely fails here.
      const allRefs = await runGit(["log", "--all", "--format=%aN"], { cwd: dir });
      expect(allRefs.ok).toBe(false);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["alice", IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("drops a name carrying bidi or zero-width characters", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "alice\u202Edrowssap", "rlo@example.com", "a.txt");
      await commitAs(dir, "bo\u200Bb", "zwsp@example.com", "b.txt");
      await commitAs(dir, "carol", "carol@example.com", "c.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["carol", IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  // ZWNJ and ZWJ are inside \p{Cf} but spell real names in Persian and Indic
  // scripts, so the filter must stop short of the whole category.
  it("keeps a name whose zero-width joiner is part of its spelling", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(
        dir,
        "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
        "fa@example.com",
        "a.txt",
      );
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toContain("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("drops a name carrying control characters", async () => {
    const dir = await createTempGitRepo();
    try {
      await commitAs(dir, "ev\u001b[31mil", "evil@example.com", "a.txt");
      await commitAs(dir, "human", "human@example.com", "b.txt");
      await setIdentity(dir, IDENTITY);

      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.names).toEqual(["human", IDENTITY]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("reports a genuine Git failure instead of an empty list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iroha-not-a-repo-"));
    try {
      const result = await readRepositoryPeople(dir);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INTERNAL_ERROR");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
