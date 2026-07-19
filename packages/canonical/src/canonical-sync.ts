import { basename } from "node:path";
import type { CanonicalDirectoryScan, CanonicalFileEntry } from "./scan-canonical-directory.js";

export interface CanonicalSyncDiff {
  added: CanonicalFileEntry[];
  changed: CanonicalFileEntry[];
  unchanged: CanonicalFileEntry[];
  /** Repository-root-relative paths present in `baseline` but no longer on disk. */
  deletedPaths: string[];
}

/**
 * Classifies each currently-scanned canonical file against a caller-
 * supplied baseline (e.g. `canonical_documents.content_hash`/`.path` from
 * `@iroha/storage`, which this package cannot depend on — see
 * decision-log.md ID-025). This is the "changed-file sync" half of WP-04's
 * deliverable; the caller decides what to do with each bucket (queue
 * import for `added`, re-index for `changed`, ignore `unchanged`, raise a
 * tombstone for `deletedPaths`).
 */
export function diffCanonicalFiles(
  scan: CanonicalDirectoryScan,
  baseline: ReadonlyMap<string, string>,
): CanonicalSyncDiff {
  const added: CanonicalFileEntry[] = [];
  const changed: CanonicalFileEntry[] = [];
  const unchanged: CanonicalFileEntry[] = [];
  const seenPaths = new Set<string>();

  for (const entry of scan.entries) {
    seenPaths.add(entry.path);
    const previousHash = baseline.get(entry.path);
    if (previousHash === undefined) {
      added.push(entry);
    } else if (previousHash !== entry.hash) {
      changed.push(entry);
    } else {
      unchanged.push(entry);
    }
  }

  const deletedPaths = [...baseline.keys()].filter((path) => !seenPaths.has(path));
  return { added, changed, unchanged, deletedPaths };
}

export interface TombstoneReference {
  /** The deleted document's id, derived from its former file basename (canonical-schema.md §4: basename must equal `<id>.md`). */
  deletedId: string;
  referencedBy: Array<{ path: string; id: string; relationType: string }>;
}

/**
 * canonical-schema.md §13: "A Git deletion is imported as a local tombstone
 * and requires explicit reconciliation if another document still
 * references the ID." Surfaces exactly that — which deleted ids remain
 * referenced, and by what — for a caller to present to a human rather than
 * silently dropping or auto-fixing the dangling relation.
 */
export function findTombstoneReferences(
  scan: CanonicalDirectoryScan,
  deletedPaths: readonly string[],
): TombstoneReference[] {
  const deletedIds = new Set(deletedPaths.map((path) => basename(path, ".md")));
  const referencedByDeletedId = new Map<string, TombstoneReference["referencedBy"]>();

  for (const entry of scan.entries) {
    for (const relation of entry.document.frontmatter.relations) {
      if (deletedIds.has(relation.target)) {
        const list = referencedByDeletedId.get(relation.target) ?? [];
        list.push({
          path: entry.path,
          id: entry.document.frontmatter.id,
          relationType: relation.type,
        });
        referencedByDeletedId.set(relation.target, list);
      }
    }
  }

  return [...referencedByDeletedId.entries()].map(([deletedId, referencedBy]) => ({
    deletedId,
    referencedBy,
  }));
}
