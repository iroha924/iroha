import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type Clock,
  type IrohaError,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import {
  type Database,
  getLocalSetting,
  insertCandidate,
  upsertLocalSetting,
} from "@iroha/storage";
import { parse as parseYaml } from "yaml";

/**
 * canonical-schema.md §14: "`iroha init --scan` creates local candidates
 * from `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**\/*.md`, and user-selected
 * docs." "User-selected docs" needs an interactive doc-picker this
 * non-interactive CLI flag does not have — recorded as an accepted scope
 * cut in decision-log.md ID-026, not implemented here.
 */
const ROOT_DOC_FILENAMES = ["AGENTS.md", "CLAUDE.md"];
const RULES_SUBDIRECTORY = join(".claude", "rules");

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
 * frontmatter, whole file is body" rather than failing the scan.
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

export interface ScanDocsIntoCandidatesResult {
  docsScanned: string[];
  candidatesCreated: number;
}

/**
 * `iroha init --scan` (canonical-schema.md §14). Each imported candidate
 * retains, per §14's list: source repository-relative path and content
 * hash (`source`), import timestamp (`imported_at`), line range (whole-file
 * — these docs are imported as one candidate each, not split into
 * sub-document extracts, so "when stable" always holds), detected scope
 * (`detected_scope.paths`, taken from a `.claude/rules/*.md` file's own
 * `paths:` frontmatter when present — the same field this repository's own
 * rules use to declare path-scoped auto-loading), and a link back to the
 * original document (`source.path` — a local file has no separate URL to
 * link to). Never writes to `.iroha/` — approval, not this scan, is what
 * creates a canonical document (§14: "does not copy them into `.iroha/`
 * automatically").
 */
export async function scanDocsIntoCandidates(
  db: Database,
  repositoryRoot: string,
  repositoryId: TypedId<"repo">,
  clock: Clock,
  random: RandomSource,
): Promise<Result<ScanDocsIntoCandidatesResult, IrohaError>> {
  const docs = [
    ...(await discoverRootDocs(repositoryRoot)),
    ...(await discoverRuleDocs(repositoryRoot)),
  ];
  const now = clock.now().toISOString();
  const docsScanned: string[] = [];
  let candidatesCreated = 0;

  for (const doc of docs) {
    const content = await readFile(doc.absolutePath, "utf8");
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    docsScanned.push(doc.relativePath);

    const settingKey = `docs_scan:${doc.relativePath}`;
    const existingSetting = await getLocalSetting(db, repositoryId, settingKey);
    if (!existingSetting.ok) {
      return existingSetting;
    }
    const previousHash =
      existingSetting.value === null
        ? undefined
        : (JSON.parse(existingSetting.value.valueJson) as { hash: string }).hash;
    if (previousHash === contentHash) {
      continue;
    }

    const { frontmatter, body } = splitOptionalFrontmatter(content);
    const lineRange = { start: 1, end: content.length === 0 ? 0 : content.split("\n").length };

    const inserted = await insertCandidate(db, {
      id: makeTypedId("cand", clock, random),
      repositoryId,
      candidateType: "rule",
      payloadJson: JSON.stringify({
        title: `Project instructions from ${doc.relativePath}`,
        body,
        source: {
          type: "document",
          path: doc.relativePath,
          content_hash: contentHash,
        },
        imported_at: now,
        line_range: lineRange,
        detected_scope: { paths: frontmatter?.paths ?? [] },
      }),
      revisionToken: contentHash,
      createdAt: now,
    });
    if (!inserted.ok) {
      return inserted;
    }
    candidatesCreated += 1;

    const settingUpdate = await upsertLocalSetting(db, {
      repositoryId,
      key: settingKey,
      valueJson: JSON.stringify({ hash: contentHash }),
      updatedAt: now,
    });
    if (!settingUpdate.ok) {
      return settingUpdate;
    }
  }

  return ok({ docsScanned, candidatesCreated });
}
