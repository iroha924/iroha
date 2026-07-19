import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/** Parses `content` as YAML, then validates it against `schema`. */
export function parseYamlDocument<T extends z.ZodType>(
  content: string,
  schema: T,
  fallbackMessage: string,
): Result<z.infer<T>, IrohaError> {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (cause) {
    return err(new IrohaError("INVALID_INPUT", `${fallbackMessage}: invalid YAML`, { cause }));
  }
  const result = schema.safeParse(parsed);
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
