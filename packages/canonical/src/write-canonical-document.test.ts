import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { computeCanonicalPath, writeCanonicalDocument } from "./write-canonical-document.js";

const clock = new FixedClock(new Date("2026-03-15T00:00:00.000Z"));
const idRandom = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const decisionId = makeTypedId("dec", clock, idRandom);
const repositoryId = makeTypedId("repo", clock, idRandom);
const sessionId = makeTypedId("ses", clock, idRandom);

const decisionBody = `# Use libSQL as the local index

## Context

Some context.

## Decision

Use libSQL.

## Rationale

Reasons.

## Consequences

Effects.

## Alternatives considered

Other options.`;

function decisionCandidate(overrides: Record<string, unknown> = {}) {
  return {
    frontmatter: {
      schema_version: 1,
      id: decisionId,
      type: "decision",
      title: "Use libSQL as the local index",
      status: "approved",
      revision: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: { provider: "git", display_name: "Example Developer" },
      approved_by: { provider: "git", display_name: "Example Reviewer" },
      approved_at: "2026-01-01T00:00:00.000Z",
      labels: [],
      scope: { repository: repositoryId, paths: [], symbols: [] },
      sources: [{ type: "session", ref: sessionId }],
      relations: [],
      decision: { kind: "architecture" },
      ...overrides,
    },
    body: decisionBody,
  };
}

describe("computeCanonicalPath", () => {
  it("places a decision under decisions/<id>.md", () => {
    const candidate = decisionCandidate();
    // computeCanonicalPath needs an already-validated CanonicalDocument;
    // reuse serializeCanonicalDocument's own validation for that.
    const path = computeCanonicalPath(candidate as never);
    expect(path).toBe(join("decisions", `${decisionId}.md`));
  });

  it("places a session summary under sessions/YYYY/MM/<id>.md, from created_at", () => {
    const sessionSummaryId = makeTypedId("ses", clock, idRandom);
    const document = {
      frontmatter: {
        type: "session_summary",
        id: sessionSummaryId,
        created_at: "2026-03-15T12:00:00.000Z",
      },
    };
    const path = computeCanonicalPath(document as never);
    expect(path).toBe(join("sessions", "2026", "03", `${sessionSummaryId}.md`));
  });
});

describe("writeCanonicalDocument", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("writes a valid candidate to its computed path", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    const result = await writeCanonicalDocument(
      decisionCandidate(),
      tempDir,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe(join(tempDir, "decisions", `${decisionId}.md`));
      const onDisk = await readFile(result.value.path, "utf8");
      expect(onDisk).toBe(result.value.content);
      expect(result.value.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("does not leave a stray temp file behind after a successful write", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    await writeCanonicalDocument(decisionCandidate(), tempDir, new CryptoRandomSource());
    const entries = await readdir(join(tempDir, "decisions"));
    expect(entries).toEqual([`${decisionId}.md`]);
  });

  it("overwrites the same document in place on a second (revision) write", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    await writeCanonicalDocument(decisionCandidate(), tempDir, new CryptoRandomSource());
    const second = await writeCanonicalDocument(
      decisionCandidate({ revision: 2 }),
      tempDir,
      new CryptoRandomSource(),
    );
    expect(second.ok).toBe(true);
    const entries = await readdir(join(tempDir, "decisions"));
    expect(entries).toEqual([`${decisionId}.md`]);
    if (second.ok) {
      expect(second.value.document.frontmatter.revision).toBe(2);
    }
  });

  it("rejects an invalid candidate without writing anything", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    const result = await writeCanonicalDocument(
      decisionCandidate({ status: "not-a-real-status" }),
      tempDir,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(false);
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("rejects a body missing a required section without writing anything", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    const candidate = {
      frontmatter: decisionCandidate().frontmatter,
      body: decisionBody.replace("## Rationale\n\nReasons.\n\n", ""),
    };
    const result = await writeCanonicalDocument(candidate, tempDir, new CryptoRandomSource());
    expect(result.ok).toBe(false);
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("rejects a document containing a detected secret without writing anything", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    const base64Body =
      "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
    const candidate = {
      frontmatter: decisionCandidate().frontmatter,
      body: `${decisionBody}\n\n-----BEGIN RSA PRIVATE KEY-----\n${base64Body}\n-----END RSA PRIVATE KEY-----`,
    };
    const result = await writeCanonicalDocument(candidate, tempDir, new CryptoRandomSource());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    await expect(readdir(tempDir)).resolves.toEqual([]);
  });

  it("cleans up the temp file when the final rename fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    // Make "decisions" (the target directory a real write would create)
    // already exist as a *file*, not a directory — mkdir(recursive) then
    // fails with ENOTDIR, exercising the cleanup path with a real I/O
    // failure rather than a mock.
    await writeFile(join(tempDir, "decisions"), "not a directory", "utf8");

    const result = await writeCanonicalDocument(
      decisionCandidate(),
      tempDir,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(false);
    const entries = await readdir(tempDir);
    expect(entries).toEqual(["decisions"]);
  });

  it("rejects a write whose target directory escapes the repository root via a symlink", async () => {
    // Regression test (confirmed by review): `.iroha/` is git-tracked and
    // shared, so a merged commit could replace a type subdirectory with a
    // symlink pointing outside the repository. mkdir/open/rename all
    // follow symlinks for intermediate path components by default, so
    // without an explicit boundary check this would silently write
    // outside `repositoryRoot`.
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-write-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "iroha-canonical-outside-"));
    await symlink(outsideDir, join(tempDir, "decisions"));

    const result = await writeCanonicalDocument(
      decisionCandidate(),
      tempDir,
      new CryptoRandomSource(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    const outsideEntries = await readdir(outsideDir);
    expect(outsideEntries).toEqual([]);
    await rm(outsideDir, { recursive: true, force: true });
  });
});
