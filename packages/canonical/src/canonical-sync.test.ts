import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { diffCanonicalFiles, findTombstoneReferences } from "./canonical-sync.js";
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

function decisionCandidate(
  id: string,
  title: string,
  relations: Array<{ type: string; target: string }> = [],
) {
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
      relations,
      decision: { kind: "architecture" },
    },
    body: decisionBody.replace("A decision", title),
  };
}

describe("diffCanonicalFiles", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("classifies added, changed, unchanged, and deleted files against a baseline", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-sync-"));
    // FixedRandomSource + FixedClock together produce the *same* ULID on
    // every call, so distinct fixture ids need real randomness here.
    const idUnchanged = makeTypedId("dec", clock, new CryptoRandomSource());
    const idChanged = makeTypedId("dec", clock, new CryptoRandomSource());
    const idAdded = makeTypedId("dec", clock, new CryptoRandomSource());
    const idDeleted = makeTypedId("dec", clock, new CryptoRandomSource());

    await writeCanonicalDocument(
      decisionCandidate(idUnchanged, "Unchanged"),
      tempDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(idChanged, "Changed (old)"),
      tempDir,
      new CryptoRandomSource(),
    );

    const scanBefore = await scanCanonicalDirectory(tempDir);
    if (!scanBefore.ok) throw new Error("scan failed");
    const baseline = new Map<string, string>();
    for (const entry of scanBefore.value.entries) {
      baseline.set(entry.path, entry.hash);
    }
    // Simulate a baseline that also knows about a file since deleted from disk.
    baseline.set(join("decisions", `${idDeleted}.md`), "sha256:0".padEnd(71, "0"));

    // Now mutate the directory: rewrite `idChanged`'s document and add a new one.
    await writeCanonicalDocument(
      decisionCandidate(idChanged, "Changed (new)"),
      tempDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(idAdded, "Added"),
      tempDir,
      new CryptoRandomSource(),
    );

    const scanAfter = await scanCanonicalDirectory(tempDir);
    if (!scanAfter.ok) throw new Error("scan failed");
    const diff = diffCanonicalFiles(scanAfter.value, baseline);

    expect(diff.added.map((e) => e.document.frontmatter.id)).toEqual([idAdded]);
    expect(diff.changed.map((e) => e.document.frontmatter.id)).toEqual([idChanged]);
    expect(diff.unchanged.map((e) => e.document.frontmatter.id)).toEqual([idUnchanged]);
    expect(diff.deletedPaths).toEqual([join("decisions", `${idDeleted}.md`)]);
  });
});

describe("findTombstoneReferences", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("flags a surviving document that still references a deleted id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-sync-"));
    const deletedId = makeTypedId("dec", clock, new CryptoRandomSource());
    const survivorId = makeTypedId("dec", clock, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(survivorId, "Survivor", [{ type: "RELATED_TO", target: deletedId }]),
      tempDir,
      new CryptoRandomSource(),
    );

    const scan = await scanCanonicalDirectory(tempDir);
    if (!scan.ok) throw new Error("scan failed");
    const deletedPath = join("decisions", `${deletedId}.md`);

    const references = findTombstoneReferences(scan.value, [deletedPath]);
    expect(references).toEqual([
      {
        deletedId,
        referencedBy: [
          {
            path: join("decisions", `${survivorId}.md`),
            id: survivorId,
            relationType: "RELATED_TO",
          },
        ],
      },
    ]);
  });

  it("reports no dangling references when nothing points at the deleted id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-sync-"));
    const deletedId = makeTypedId("dec", clock, new CryptoRandomSource());
    const survivorId = makeTypedId("dec", clock, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(survivorId, "Survivor"),
      tempDir,
      new CryptoRandomSource(),
    );

    const scan = await scanCanonicalDirectory(tempDir);
    if (!scan.ok) throw new Error("scan failed");
    const deletedPath = join("decisions", `${deletedId}.md`);

    const references = findTombstoneReferences(scan.value, [deletedPath]);
    expect(references).toEqual([]);
  });
});
