import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/**
 * Parses `content` as YAML, then validates it against `schema`.
 *
 * `migrate` runs between the two, for a document an older version wrote in a
 * shape the schema no longer accepts. It sees raw YAML output, so it must not
 * assume any structure — the schema, not the migration, is what rejects a
 * malformed file.
 */
export function parseYamlDocument<T extends z.ZodType>(
  content: string,
  schema: T,
  fallbackMessage: string,
  migrate?: (document: unknown) => unknown,
): Result<z.infer<T>, IrohaError> {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (cause) {
    return err(new IrohaError("INVALID_INPUT", `${fallbackMessage}: invalid YAML`, { cause }));
  }
  const result = schema.safeParse(migrate === undefined ? parsed : migrate(parsed));
  if (!result.success) {
    return err(
      new IrohaError("INVALID_INPUT", fallbackMessage, {
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      }),
    );
  }
  return ok(result.data);
}
