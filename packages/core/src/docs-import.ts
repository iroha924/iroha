import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
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
import {
  type Database,
  getEntityById,
  upsertEntity,
  upsertKnowledgeItem,
  upsertSearchDocument,
} from "@iroha/storage";
import { parse as parseYaml } from "yaml";

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

/** contracts/database.md §6: same tier as a verified Git/Forge artifact. */
const IMPORTED_AUTHORITY = 80;

interface DiscoveredDoc {
  /** Repository-root-relative, POSIX-normalized. */
  relativePath: string;
  absolutePath: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

async function discoverRootDocs(repositoryRoot: string): Promise<DiscoveredDoc[]> {
  const found: DiscoveredDoc[] = [];
  for (const filename of ROOT_DOC_FILENAMES) {
    const absolutePath = join(repositoryRoot, filename);
    if (await pathExists(absolutePath)) {
      found.push({ relativePath: filename, absolutePath });
    }
  }
  return found;
}

async function discoverRuleDocs(repositoryRoot: string): Promise<DiscoveredDoc[]> {
  const rulesDir = join(repositoryRoot, RULES_SUBDIRECTORY);
  let entries: Dirent[];
  try {
    entries = await readdir(rulesDir, { recursive: true, withFileTypes: true, encoding: "utf8" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw cause;
  }
  const found: DiscoveredDoc[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const absolutePath = join(entry.parentPath, entry.name);
    found.push({
      relativePath: toPosixPath(relative(repositoryRoot, absolutePath)),
      absolutePath,
    });
  }
  return found;
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
 */
function splitOptionalFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | undefined;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: undefined, body: content };
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return { frontmatter: undefined, body: content };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, closingIndex).join("\n"));
  } catch {
    return { frontmatter: undefined, body: content };
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

export interface ImportRepositoryDocsResult {
  docsImported: string[];
  entitiesWritten: number;
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
 * re-run costs one read per document and writes nothing.
 */
export async function importRepositoryDocs(
  db: Database,
  repositoryRoot: string,
  repositoryId: TypedId<"repo">,
  clock: Clock,
  random: RandomSource,
): Promise<Result<ImportRepositoryDocsResult, IrohaError>> {
  const docs = [
    ...(await discoverRootDocs(repositoryRoot)),
    ...(await discoverRuleDocs(repositoryRoot)),
  ];
  const now = clock.now().toISOString();
  const docsImported: string[] = [];
  let entitiesWritten = 0;

  for (const doc of docs) {
    const content = await readFile(doc.absolutePath, "utf8");
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    docsImported.push(doc.relativePath);

    const entityId = entityIdForDoc(doc.relativePath);
    const existing = await getEntityById(db, entityId);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value?.contentHash === contentHash) {
      continue;
    }

    const { frontmatter, body } = splitOptionalFrontmatter(content);

    const entityResult = await upsertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "rule",
      title: `Project instructions from ${doc.relativePath}`,
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

    const knowledgeResult = await upsertKnowledgeItem(db, {
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

    // Lexical index only — no embedding job is enqueued. Embedding these would
    // pay a provider per token to vectorize text the agent harness already
    // auto-loads into the same session; FTS is enough to find them, and
    // lexical-only entries are an already-supported state.
    const searchResult = await upsertSearchDocument(db, {
      id: makeTypedId("sdoc", clock, random),
      entityId,
      documentKind: "rule",
      title: `Project instructions from ${doc.relativePath}`,
      body,
      codeTerms: "",
      authority: IMPORTED_AUTHORITY,
      contentHash,
      indexedAt: now,
    });
    if (!searchResult.ok) {
      return searchResult;
    }

    entitiesWritten += 1;
  }

  return ok({ docsImported, entitiesWritten });
}
