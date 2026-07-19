import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  type CanonicalDocument,
  err,
  IrohaError,
  ok,
  type RandomSource,
  type Result,
} from "@iroha/domain";
import { validateBodyTemplate } from "./body-template.js";
import { scanForSecrets } from "./secret-scan.js";
import { serializeCanonicalDocument } from "./serialize-canonical-document.js";

/**
 * canonical-schema.md §3-4: the path (relative to the `.iroha/` root) for a
 * validated document — `id`/`type` have already passed Zod's strict ULID
 * pattern by this point, so building a path from them with `path.join`
 * carries none of the `..`-traversal risk that applies to untrusted
 * strings (see `.claude/rules/path-and-symlink-safety.md`).
 */
export function computeCanonicalPath(document: CanonicalDocument): string {
  const { id, type } = document.frontmatter;
  switch (type) {
    case "session_summary": {
      const created = new Date(document.frontmatter.created_at);
      const year = created.getUTCFullYear().toString().padStart(4, "0");
      const month = (created.getUTCMonth() + 1).toString().padStart(2, "0");
      return join("sessions", year, month, `${id}.md`);
    }
    case "decision":
      return join("decisions", `${id}.md`);
    case "rule":
      return join("rules", `${id}.md`);
    case "concept":
      return join("knowledge", "concepts", `${id}.md`);
    case "insight":
      return join("knowledge", "insights", `${id}.md`);
    case "incident":
      return join("knowledge", "incidents", `${id}.md`);
    case "pattern":
      return join("knowledge", "patterns", `${id}.md`);
    case "review_learning":
      return join("knowledge", "reviews", `${id}.md`);
  }
}

export interface WriteCanonicalDocumentResult {
  /** Absolute path the document was written to. */
  path: string;
  content: string;
  hash: string;
  document: CanonicalDocument;
}

/**
 * canonical-schema.md §12 steps 3-7 of the approval transaction: validate
 * (Zod + body-template + secret scan), write to a sibling temp file, flush,
 * atomically rename into place, fsync the parent directory. Steps
 * 1/2/8/9/10 (write lock, candidate reload/concurrency check, DB commit,
 * audit record, unlock) need `@iroha/storage`/`@iroha/git`, which this
 * package cannot depend on (compatibility.md §4 restricts `@iroha/canonical`
 * to `domain`/`config`) — see decision-log.md for this layering split. The
 * caller (CLI/dashboard-api) composes this function with those.
 */
export async function writeCanonicalDocument(
  candidate: unknown,
  repositoryRoot: string,
  random: RandomSource,
): Promise<Result<WriteCanonicalDocumentResult, IrohaError>> {
  const serialized = serializeCanonicalDocument(candidate);
  if (!serialized.ok) {
    return serialized;
  }

  const bodyResult = validateBodyTemplate(serialized.value.document);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  const scanResult = await scanForSecrets(serialized.value.content);
  if (!scanResult.ok) {
    return scanResult;
  }
  if (!scanResult.value.clean) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        "Canonical document contains a detected secret and was not written",
        { details: { findings: scanResult.value.findings } },
      ),
    );
  }

  const relativePath = computeCanonicalPath(serialized.value.document);
  const targetPath = join(repositoryRoot, relativePath);
  const targetDir = dirname(targetPath);
  const tempSuffix = Buffer.from(random.bytes(8)).toString("hex");
  const tempPath = join(
    targetDir,
    `.${serialized.value.document.frontmatter.id}.${tempSuffix}.tmp`,
  );

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to create canonical directory", { cause }));
  }

  // Reject a symlink escape: `.iroha/` is git-tracked and shared, so a type
  // subdirectory (e.g. `decisions/`) could be replaced by a symlink
  // pointing outside `repositoryRoot` via any merged commit. `mkdir`/
  // `open`/`rename` all follow symlinks for intermediate path components
  // under normal POSIX semantics, so this has to be checked explicitly —
  // it is not something those calls fail closed on by themselves.
  let realRoot: string;
  let realTargetDir: string;
  try {
    realRoot = await realpath(repositoryRoot);
    realTargetDir = await realpath(targetDir);
  } catch (cause) {
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to resolve canonical write path", { cause }),
    );
  }
  if (realTargetDir !== realRoot && !realTargetDir.startsWith(realRoot + sep)) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        "Canonical write target escapes the repository root (symlink?)",
      ),
    );
  }

  try {
    const fileHandle = await open(tempPath, "w");
    try {
      await fileHandle.writeFile(serialized.value.content, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    await rename(tempPath, targetPath);
  } catch (cause) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return err(new IrohaError("INTERNAL_ERROR", "Failed to write canonical document", { cause }));
  }

  // fsync the parent directory "where supported" (canonical-schema.md §12
  // step 7) — POSIX only; Windows cannot open a directory as a file
  // handle, so a failure here is a best-effort durability gap, not a
  // reason to fail a write that has already atomically landed.
  try {
    const dirHandle = await open(targetDir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // best effort
  }

  return ok({
    path: targetPath,
    content: serialized.value.content,
    hash: serialized.value.hash,
    document: serialized.value.document,
  });
}
