import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type CanonicalDocument, err, IrohaError, ok, type Result } from "@iroha/domain";
import { parseAndValidateCanonicalDocument } from "./parse-and-validate.js";
import { computeCanonicalPath } from "./write-canonical-document.js";

// `{7,}` (not `{7}`): Git increases conflict-marker length beyond 7
// characters for nested/recursive conflicts (`merge.conflictMarkerSize`),
// so a fixed-length match would miss those — confirmed by review. Requiring
// *both* an opening and a closing marker (checked separately below, not
// folded into one alternation) avoids misdiagnosing a document whose body
// legitimately contains a single `=======`-style divider line as an
// unresolved conflict.
const CONFLICT_START_PATTERN = /^<{7,}(?:\s|$)/m;
const CONFLICT_END_PATTERN = /^>{7,}(?:\s|$)/m;

export interface CanonicalFileEntry {
  /** Repository-root-relative path (POSIX separators), e.g. `decisions/dec_....md`. */
  path: string;
  document: CanonicalDocument;
  hash: string;
}

export interface CanonicalFileError {
  path: string;
  error: IrohaError;
}

export interface CanonicalDirectoryScan {
  entries: CanonicalFileEntry[];
  errors: CanonicalFileError[];
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Recursively reads and validates every `.md` file under `repositoryRoot`
 * (the `.iroha/` directory), the read side of canonical-schema.md §3's
 * layout. A file that fails to parse — or whose path disagrees with
 * `computeCanonicalPath(document)` (§4: "The file basename must equal
 * `<id>.md`"; WP-04 acceptance criteria: "filename/ID/path validation") —
 * is collected in `errors` rather than aborting the whole scan, so one
 * malformed document does not hide problems (or successes) in every other
 * one — matching WP-04's "malformed canonical file fails rebuild safely"
 * acceptance criterion at the directory-scan granularity, not just the
 * single-file one.
 */
export async function scanCanonicalDirectory(
  repositoryRoot: string,
): Promise<Result<CanonicalDirectoryScan, IrohaError>> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(repositoryRoot, {
      recursive: true,
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to read canonical directory", { cause }));
  }

  const entries: CanonicalFileEntry[] = [];
  const errors: CanonicalFileError[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) {
      continue;
    }
    const absolutePath = join(dirent.parentPath, dirent.name);
    const relativePath = toPosixPath(relative(repositoryRoot, absolutePath));

    let raw: Buffer;
    try {
      raw = await readFile(absolutePath);
    } catch (cause) {
      errors.push({
        path: relativePath,
        error: new IrohaError("INTERNAL_ERROR", "Failed to read canonical file", { cause }),
      });
      continue;
    }
    // Hash the raw bytes, not the UTF-8-decoded string: decoding lossily
    // replaces invalid byte sequences with U+FFFD, which would make two
    // files with genuinely different bytes hash identically — confirmed by
    // review. `diffCanonicalFiles` depends on this hash to detect real
    // on-disk changes.
    const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const content = raw.toString("utf8");

    const parsed = parseAndValidateCanonicalDocument(content);
    if (!parsed.ok) {
      errors.push({ path: relativePath, error: describeParseFailure(content, parsed.error) });
      continue;
    }

    const expectedPath = toPosixPath(computeCanonicalPath(parsed.value));
    if (expectedPath !== relativePath) {
      errors.push({
        path: relativePath,
        error: new IrohaError(
          "INVALID_INPUT",
          "Canonical file's location does not match its id/type (expected a different path)",
          { details: { expectedPath, actualPath: relativePath } },
        ),
      });
      continue;
    }

    entries.push({ path: relativePath, document: parsed.value, hash });
  }

  return ok({ entries, errors });
}

/**
 * Distinguishes an unresolved Git merge conflict (a specific, actionable
 * diagnostic — canonical-schema.md §13: "Git content conflicts are never
 * semantically auto-merged") from a generic parse failure. Requires *both*
 * an opening (`<<<<<<<`) and closing (`>>>>>>>`) marker to be present, not
 * just one — a document body containing a single marker-length banner/
 * divider line is far more plausible than one containing both paired
 * markers by coincidence.
 */
function describeParseFailure(content: string, original: IrohaError): IrohaError {
  if (CONFLICT_START_PATTERN.test(content) && CONFLICT_END_PATTERN.test(content)) {
    return new IrohaError(
      "INVALID_INPUT",
      "Canonical file has unresolved Git merge conflict markers",
      { cause: original },
    );
  }
  return original;
}
