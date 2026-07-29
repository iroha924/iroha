import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { deriveSummary, scanForSecrets } from "@iroha/canonical";
import {
  type Clock,
  type IrohaError,
  makeDeterministicTypedId,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import { toRepoRelativePath } from "@iroha/git";
import {
  type Database,
  enqueueEmbeddingJob,
  getEntityById,
  getSearchDocumentByEntityId,
  listEntitiesBySourceKind,
  updateEntityStatus,
  upsertEntity,
  upsertKnowledgeItem,
  upsertSearchDocument,
  withTransaction,
} from "@iroha/storage";
import { parse as parseYaml } from "yaml";
import { EMBEDDING_MODEL, EMBEDDING_PROVIDER } from "./sync-canonical.js";

/**
 * contracts/canonical.md §14: the documents `iroha init`/`iroha sync` import.
 * "User-selected docs" needs an interactive doc-picker this non-interactive CLI
 * does not have — an accepted scope cut, not implemented here.
 */
const ROOT_DOC_FILENAMES = ["AGENTS.md", "CLAUDE.md"];
const RULES_SUBDIRECTORY = join(".claude", "rules");

/**
 * Outside the `approved` set on purpose (contracts/canonical.md §14): these
 * documents are the repository's own, already binding on whoever works in it,
 * so there is nothing to approve — and `get_active_rules` filters on
 * `approved`, which keeps iroha from re-delivering text the agent harness
 * already auto-loads.
 */
const IMPORTED_STATUS = "imported";

/** Matches `syncCanonicalToDatabase`; the FTS candidate query excludes only this status. */
const TOMBSTONED_STATUS = "tombstoned";

/** contracts/database.md §6: same tier as a verified Git/Forge artifact. */
const IMPORTED_AUTHORITY = 80;

interface DiscoveredDoc {
  /** Repository-root-relative and POSIX-normalized, resolved through symlinks. */
  relativePath: string;
  absolutePath: string;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Absent, unreadable, a broken symlink, or a symlink loop — all mean "no
    // document here". Which of those it is does not change what we do, and the
    // errno carries an absolute path we must not surface.
    return false;
  }
}

export interface ImportRepositoryDocsResult {
  docsImported: string[];
  entitiesWritten: number;
  /** Discovered documents that resolve outside the repository, so were not read. */
  docsSkipped: number;
  /** Documents left out of the index because their text tripped the secret scan. */
  docsWithheld: number;
  /** Previously imported documents whose source file is gone. */
  entitiesTombstoned: number;
}

function candidateRootDocs(repositoryRoot: string): string[] {
  return ROOT_DOC_FILENAMES.map((filename) => join(repositoryRoot, filename));
}

async function candidateRuleDocs(
  repositoryRoot: string,
): Promise<{ paths: string[]; listed: boolean; escaped: boolean }> {
  const rulesDir = join(repositoryRoot, RULES_SUBDIRECTORY);
  // Containment-check the directory *before* traversing it. `readdir` follows a
  // symlinked `.claude/rules` and walks the whole real target first, so with the
  // check left to the per-file pass, a link to `/` would enumerate the entire
  // filesystem before a single path could be rejected — on `init`, with no
  // opt-in. Reject the traversal itself, not its results.
  const contained = await toRepoRelativePath(repositoryRoot, rulesDir);
  if (!contained.ok) {
    return { paths: [], listed: true, escaped: true };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(rulesDir, { recursive: true, withFileTypes: true, encoding: "utf8" });
  } catch (cause) {
    // An absent `.claude/rules` is the ordinary case and a complete answer:
    // there are no rule documents. Anything else means the directory may hold
    // documents we could not see, and reporting that as "none" would let the
    // caller tombstone every rule it imported last time.
    return {
      paths: [],
      listed: (cause as NodeJS.ErrnoException).code === "ENOENT",
      escaped: false,
    };
  }
  return {
    escaped: false,
    // A symlink dirent is neither `isFile()` nor followed by `readdir`, so
    // filtering on `isFile()` alone silently drops a rule file that is a link
    // to another path in the repository. Let the containment check below decide
    // — it resolves the link and rejects only what actually leaves the tree.
    paths: entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name)),
    listed: true,
  };
}

/**
 * Turns candidate absolute paths into repository-relative ones, dropping every
 * path that leaves the repository once symlinks are resolved.
 *
 * `readdir` follows a symlinked `.claude/rules` and walks the real target, and
 * `readFile` follows a symlinked `CLAUDE.md`, so without this a repository
 * could point either at anything the running user can read and have it indexed
 * — on `init` and on every `sync`, with no opt-in. `toRepoRelativePath`
 * resolves both sides and rejects the escape; taking the resolved path as the
 * recorded one also stops a link inside the repository from filing its content
 * under the link's name rather than the target's.
 */
async function resolveInsideRepository(
  repositoryRoot: string,
  absolutePaths: readonly string[],
): Promise<{ docs: DiscoveredDoc[]; skipped: number }> {
  const docs: DiscoveredDoc[] = [];
  let skipped = 0;
  for (const absolutePath of absolutePaths) {
    if (!(await isReadableFile(absolutePath))) {
      continue;
    }
    const relative = await toRepoRelativePath(repositoryRoot, absolutePath);
    if (!relative.ok || relative.value.length === 0) {
      skipped += 1;
      continue;
    }
    // Carry the *resolved* path forward, not the one just validated. Reading
    // through the original would re-traverse the symlink chain, so a link
    // repointed between the check and the read would be followed to its new
    // target while `source_ref` still named an in-repository path.
    docs.push({
      relativePath: relative.value,
      absolutePath: join(repositoryRoot, ...relative.value.split("/")),
    });
  }
  return { docs, skipped };
}

interface ParsedFrontmatter {
  paths: string[];
}

/**
 * A lightweight, best-effort `---`-delimited YAML frontmatter split for
 * `.claude/rules/*.md` files — not `@iroha/canonical`'s strict canonical-
 * document parser (CRLF/BOM rejection, schema validation): these are plain
 * instruction docs, not canonical documents, and frontmatter here is
 * optional. Any parse failure or unexpected shape falls back to "no
 * frontmatter, whole file is body" rather than failing the import.
 *
 * Unlike the canonical parser this accepts CRLF and a BOM instead of rejecting
 * them. A CRLF checkout is a supported Tier 1 configuration
 * (contracts/compatibility.md §6), and matching `"---"` against a line still
 * carrying its `\r` would silently drop the `paths:` scope §14 requires the
 * import to retain.
 */
function splitOptionalFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | undefined;
  body: string;
} {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontmatter: undefined, body: lines.join("\n") };
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return { frontmatter: undefined, body: lines.join("\n") };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, closingIndex).join("\n"));
  } catch {
    return { frontmatter: undefined, body: lines.join("\n") };
  }
  const body = lines.slice(closingIndex + 1).join("\n");
  if (typeof parsed !== "object" || parsed === null) {
    return { frontmatter: undefined, body };
  }
  const record = parsed as Record<string, unknown>;
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((value): value is string => typeof value === "string")
    : [];
  return { frontmatter: { paths }, body };
}

/**
 * Keyed on the repository-relative path, not the content: an edited document
 * must update its entity rather than accumulate a second one, and the path is
 * the only identity the source file carries across edits.
 */
function entityIdForDoc(relativePath: string): TypedId<"rul"> {
  const seed = createHash("sha256").update(`iroha:imported-doc-id:${relativePath}`).digest();
  return makeDeterministicTypedId("rul", seed);
}

/**
 * Imports the repository's own instruction documents into the local index
 * (contracts/canonical.md §14 / ADR-017). They land as `source_kind = 'import'`
 * rule entities at `status = 'imported'` — never as candidates, because a
 * committed `CLAUDE.md` has no meaningful approval decision left to make, and
 * never as canonical files, because that would duplicate a Git-tracked
 * document into a second one that goes stale on the next edit. §14's retention
 * list maps to `source_ref` (path), `content_hash`, `updated_at` (import
 * timestamp), and the rule's own `paths:` frontmatter (detected scope).
 *
 * Unchanged documents are skipped on the entity's stored content hash, so a
 * re-run costs one stat and one read per document and writes nothing.
 */
export async function importRepositoryDocs(
  db: Database,
  repositoryRoot: string,
  repositoryId: TypedId<"repo">,
  clock: Clock,
  random: RandomSource,
): Promise<Result<ImportRepositoryDocsResult, IrohaError>> {
  const rules = await candidateRuleDocs(repositoryRoot);
  const resolvedDocs = await resolveInsideRepository(repositoryRoot, [
    ...candidateRootDocs(repositoryRoot),
    ...rules.paths,
  ]);
  const docs = resolvedDocs.docs;
  // A `.claude/rules` that resolves outside the repository is itself one
  // rejected document, not zero: it never reaches the per-file pass.
  const skipped = resolvedDocs.skipped + (rules.escaped ? 1 : 0);
  const now = clock.now().toISOString();
  const docsImported: string[] = [];
  // Existence, not readability: a document we saw but could not read or index
  // is still present, and treating it as absent would have the reconcile below
  // retire a rule that a transient EACCES merely hid for one run.
  const presentPaths = new Set(docs.map((doc) => doc.relativePath));
  let entitiesWritten = 0;
  let docsWithheld = 0;

  for (const doc of docs) {
    let content: string;
    try {
      content = await readFile(doc.absolutePath, "utf8");
    } catch {
      // Vanished or became unreadable between the stat above and here. Skipping
      // one document is the proportionate response; failing would abort an
      // `iroha sync` whose canonical work has already committed.
      continue;
    }

    // The local database is an at-rest store, so a credential written into a
    // repository's prose must not be copied into it — the same reason
    // `create_checkpoint` redacts before writing. Withheld rather than
    // redacted: a wholesale-redacted rule is useless, and the agent harness
    // reads the file directly anyway, so declining to hold a copy costs the
    // reader nothing.
    const scan = await scanForSecrets(content);
    if (!scan.ok) {
      return scan;
    }
    if (!scan.value.clean) {
      docsWithheld += 1;
      // Dropped from the present set so the reconcile retires whatever earlier
      // revision is already indexed. Leaving it would keep serving the last
      // clean text as current instructions for as long as the secret stays in
      // the file — reported as withheld while retrieval says otherwise.
      presentPaths.delete(doc.relativePath);
      continue;
    }

    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    docsImported.push(doc.relativePath);

    const entityId = entityIdForDoc(doc.relativePath);
    const existing = await getEntityById(db, entityId);
    if (!existing.ok) {
      return existing;
    }
    // Also re-imports an entity a previous run tombstoned, whose file is back.
    if (existing.value?.contentHash === contentHash && existing.value.status === IMPORTED_STATUS) {
      continue;
    }

    const { frontmatter, body } = splitOptionalFrontmatter(content);
    const title = `Project instructions from ${doc.relativePath}`;
    const summary = deriveSummary(body);

    // One transaction for all three rows. The skip guard above reads
    // `entities.content_hash`, which the first write sets — so an interruption
    // between the writes would otherwise commit the new hash, abandon the body,
    // and make every later run skip the repair.
    const written = await withTransaction(db, "write", async (tx) => {
      const entityResult = await upsertEntity(tx, {
        id: entityId,
        repositoryId,
        entityType: "rule",
        title,
        ...(summary !== undefined ? { summary } : {}),
        status: IMPORTED_STATUS,
        authority: IMPORTED_AUTHORITY,
        sourceKind: "import",
        sourceRef: doc.relativePath,
        contentHash,
        createdAt: existing.value?.createdAt ?? now,
        updatedAt: now,
      });
      if (!entityResult.ok) {
        return entityResult;
      }

      const knowledgeResult = await upsertKnowledgeItem(tx, {
        id: entityId,
        knowledgeType: "rule",
        body,
        scopeJson: JSON.stringify({
          repository: repositoryId,
          paths: frontmatter?.paths ?? [],
          symbols: [],
        }),
        // Advisory even for a rule the repository treats as mandatory: a
        // guardrail needs a machine-evaluable guard spec, and a prose document
        // does not carry one.
        enforcement: "advisory",
      });
      if (!knowledgeResult.ok) {
        return knowledgeResult;
      }

      const searchResult = await upsertSearchDocument(tx, {
        id: makeTypedId("sdoc", clock, random),
        entityId,
        documentKind: "rule",
        title,
        body,
        codeTerms: "",
        authority: IMPORTED_AUTHORITY,
        contentHash,
        indexedAt: now,
      });
      if (!searchResult.ok) {
        return searchResult;
      }

      // Queued on the same terms as canonical knowledge. Leaving it lexical-only
      // would make `mode: "vector"` — which disables the FTS arm entirely —
      // silently unable to return a repository rule at all, and the semantic arm
      // is exactly what a repository whose harness does not auto-load
      // `.claude/rules/*.md` has to rely on. Enqueue only: no provider is called
      // here, and an unconfigured provider leaves the job pending.
      const stored = await getSearchDocumentByEntityId(tx, entityId);
      if (!stored.ok) {
        return stored;
      }
      if (stored.value === null) {
        return ok(undefined);
      }
      return enqueueEmbeddingJob(tx, {
        id: makeTypedId("job", clock, random),
        searchDocumentId: stored.value.id,
        provider: EMBEDDING_PROVIDER,
        model: EMBEDDING_MODEL,
        createdAt: now,
        updatedAt: now,
      });
    });
    if (!written.ok) {
      return written;
    }

    entitiesWritten += 1;
  }

  // Only reconcile against a complete picture. A `.claude/rules` we could not
  // list tells us nothing about which rules still exist, and acting on it would
  // retire every one of them over a directory that was briefly unreadable.
  const tombstoned = rules.listed
    ? await tombstoneDisappearedDocs(db, repositoryId, presentPaths, now)
    : ok(0);
  if (!tombstoned.ok) {
    return tombstoned;
  }

  return ok({
    docsImported,
    entitiesWritten,
    docsSkipped: skipped,
    docsWithheld,
    entitiesTombstoned: tombstoned.value,
  });
}

/**
 * Retires the entities whose source document is no longer there. An upsert-only
 * pass cannot see a deletion, so without this a renamed rule is served under
 * both names and a deleted one is served forever — the FTS candidate query
 * excludes `tombstoned` and nothing else. `syncCanonicalToDatabase` reconciles
 * its own deletions the same way.
 *
 * The row is retired rather than deleted so a file that comes back keeps its
 * identity and `created_at`, and so a rebuild and an incremental sync converge
 * on the same graph.
 */
async function tombstoneDisappearedDocs(
  db: Database,
  repositoryId: TypedId<"repo">,
  present: ReadonlySet<string>,
  now: string,
): Promise<Result<number, IrohaError>> {
  const existing = await listEntitiesBySourceKind(db, repositoryId, "import");
  if (!existing.ok) {
    return existing;
  }
  let tombstoned = 0;
  for (const entity of existing.value) {
    if (entity.status !== IMPORTED_STATUS || (entity.sourceRef ?? "") === "") {
      continue;
    }
    if (present.has(entity.sourceRef ?? "")) {
      continue;
    }
    const updated = await updateEntityStatus(db, entity.id, {
      status: TOMBSTONED_STATUS,
      updatedAt: now,
    });
    if (!updated.ok) {
      return updated;
    }
    tombstoned += 1;
  }
  return ok(tombstoned);
}
