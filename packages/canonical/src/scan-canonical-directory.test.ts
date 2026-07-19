import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { scanCanonicalDirectory } from "./scan-canonical-directory.js";
import { writeCanonicalDocument } from "./write-canonical-document.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const idRandom = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const repositoryId = makeTypedId("repo", clock, idRandom);
const sessionId = makeTypedId("ses", clock, idRandom);

const decisionBody = `# A decision

## Context

Context.

## Decision

Decision.

## Rationale

Rationale.

## Consequences

Consequences.

## Alternatives considered

Alternatives.`;

function decisionCandidate(id: string, title: string) {
  return {
    frontmatter: {
      schema_version: 1,
      id,
      type: "decision",
      title,
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
    },
    body: decisionBody.replace("A decision", title),
  };
}

describe("scanCanonicalDirectory", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("finds and validates every canonical document under the root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-scan-"));
    // FixedRandomSource + FixedClock together produce the *same* ULID on
    // every call, so distinct fixture ids need real randomness here.
    const idA = makeTypedId("dec", clock, new CryptoRandomSource());
    const idB = makeTypedId("dec", clock, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A"),
      tempDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(idB, "Decision B"),
      tempDir,
      new CryptoRandomSource(),
    );

    const result = await scanCanonicalDirectory(tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.errors).toEqual([]);
      expect(result.value.entries.map((e) => e.path).sort()).toEqual(
        [`decisions/${idA}.md`, `decisions/${idB}.md`].sort(),
      );
    }
  });

  it("reports a generic parse error for a malformed file, without aborting the whole scan", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-scan-"));
    const idA = makeTypedId("dec", clock, idRandom);
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A"),
      tempDir,
      new CryptoRandomSource(),
    );
    await mkdir(join(tempDir, "decisions"), { recursive: true });
    await writeFile(
      join(tempDir, "decisions", "dec_broken.md"),
      "not a canonical document\n",
      "utf8",
    );

    const result = await scanCanonicalDirectory(tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries.length).toBe(1);
      expect(result.value.errors.length).toBe(1);
      expect(result.value.errors[0]?.path).toBe("decisions/dec_broken.md");
    }
  });

  it("recognizes unresolved Git merge conflict markers as a distinct diagnostic", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-scan-"));
    await mkdir(join(tempDir, "decisions"), { recursive: true });
    const conflicted = `---\n<<<<<<< HEAD\nschema_version: 1\n=======\nschema_version: 1\n>>>>>>> branch\n---\n\n# Title\n`;
    await writeFile(join(tempDir, "decisions", "dec_conflict.md"), conflicted, "utf8");

    const result = await scanCanonicalDirectory(tempDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.errors.length).toBe(1);
      expect(result.value.errors[0]?.error.message).toContain("Git merge conflict");
    }
  });
});
