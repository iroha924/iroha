import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type CanonicalDocument, err, IrohaError, ok, type Result } from "@iroha/domain";
import { parseAndValidateCanonicalDocument } from "./parse-and-validate.js";

const GIT_CONFLICT_MARKER_PATTERN = /^(<{7}|={7}|>{7})(?:\s|$)/m;

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

/**
 * Recursively reads and validates every `.md` file under `repositoryRoot`
 * (the `.iroha/` directory), the read side of canonical-schema.md §3's
 * layout. A file that fails to parse is collected in `errors` rather than
 * aborting the whole scan, so one malformed document does not hide
 * problems (or successes) in every other one — matching WP-04's "malformed
 * canonical file fails rebuild safely" acceptance criterion at the
 * directory-scan granularity, not just the single-file one.
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
    const relativePath = relative(repositoryRoot, absolutePath).split("\\").join("/");

    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (cause) {
      errors.push({
        path: relativePath,
        error: new IrohaError("INTERNAL_ERROR", "Failed to read canonical file", { cause }),
      });
      continue;
    }

    const parsed = parseAndValidateCanonicalDocument(content);
    if (!parsed.ok) {
      errors.push({ path: relativePath, error: describeParseFailure(content, parsed.error) });
      continue;
    }

    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    entries.push({ path: relativePath, document: parsed.value, hash });
  }

  return ok({ entries, errors });
}

/**
 * Distinguishes an unresolved Git merge conflict (a specific, actionable
 * diagnostic — canonical-schema.md §13: "Git content conflicts are never
 * semantically auto-merged") from a generic parse failure, since a file
 * containing `<<<<<<<`/`=======`/`>>>>>>>` markers is not simply malformed
 * YAML/Markdown — it needs manual conflict resolution, not a validation fix.
 */
function describeParseFailure(content: string, original: IrohaError): IrohaError {
  if (GIT_CONFLICT_MARKER_PATTERN.test(content)) {
    return new IrohaError(
      "INVALID_INPUT",
      "Canonical file has unresolved Git merge conflict markers",
      { cause: original },
    );
  }
  return original;
}
