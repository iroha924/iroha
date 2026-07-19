import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/** canonical-schema.md §3: `.iroha/schema-version` "contains exactly: `1`". */
export const SUPPORTED_SCHEMA_VERSION = "1";

/**
 * A cheap canary, independent of `.iroha/config.yaml` or the local DB: a
 * repository whose `.iroha/` predates a future incompatible schema bump can
 * be detected and refused before any write is attempted, without first
 * having to successfully parse the (possibly-changed) config schema.
 * `null` means no `.iroha/` exists yet at all (fresh init).
 */
export async function readSchemaVersion(
  irohaCanonicalDir: string,
): Promise<Result<string | null, IrohaError>> {
  try {
    const raw = await readFile(join(irohaCanonicalDir, "schema-version"), "utf8");
    return ok(raw.trim());
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(null);
    }
    return err(new IrohaError("INTERNAL_ERROR", "Failed to read .iroha/schema-version", { cause }));
  }
}

/** WP-05 acceptance: "unsupported schema blocks writes." */
export function assertSupportedSchemaVersion(version: string): Result<void, IrohaError> {
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    return err(
      new IrohaError(
        "SCHEMA_MISMATCH",
        `Unsupported .iroha/ schema version (found "${version}", expected "${SUPPORTED_SCHEMA_VERSION}")`,
      ),
    );
  }
  return ok(undefined);
}
