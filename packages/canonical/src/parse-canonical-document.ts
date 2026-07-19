import {
  type CanonicalDocument,
  canonicalDocumentSchema,
  err,
  IrohaError,
  ok,
  type Result,
} from "@iroha/domain";
import { parse as parseYaml } from "yaml";

/**
 * Splits raw file content into its frontmatter YAML text and Markdown body,
 * per canonical-schema.md §5: LF line endings, no BOM, `---` delimiters.
 * These two format properties are rejected outright rather than silently
 * normalized — a CRLF or BOM'd file is malformed input, not a cosmetic
 * variation, and canonical-schema.md's own acceptance criteria require a
 * malformed canonical file to fail safely rather than be "fixed" on read.
 */
function splitFrontmatter(content: string): Result<{ yamlText: string; body: string }, IrohaError> {
  if (content.includes("\r")) {
    return err(
      new IrohaError("INVALID_INPUT", "Canonical document must use LF line endings, not CRLF"),
    );
  }
  if (content.startsWith("﻿")) {
    return err(new IrohaError("INVALID_INPUT", "Canonical document must not have a UTF-8 BOM"));
  }
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        "Canonical document must start with a '---' frontmatter delimiter",
      ),
    );
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        "Canonical document is missing the closing '---' frontmatter delimiter",
      ),
    );
  }
  const yamlText = lines.slice(1, closingIndex).join("\n");
  // The delimiters — and the file's own mandatory single final newline
  // (canonical-schema.md §11 step 8) — are a serialization concern, not
  // part of the parsed envelope (§5: "The Markdown delimiters are a
  // serialization concern and are not included in the JSON Schema
  // instance"). Leading blank lines separating the closing delimiter from
  // the body are stripped the same way (a well-formed body always starts
  // with `# <title>`, never a blank line), so this parser is the exact
  // inverse of what the serializer produces on both ends.
  const body = lines
    .slice(closingIndex + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return ok({ yamlText, body });
}

/**
 * Parses raw canonical document file content into a validated
 * `CanonicalDocument`. Matches canonical-schema.md §5-§6: split
 * frontmatter/body, parse the frontmatter as YAML, then validate the whole
 * envelope against the same Zod schema (`@iroha/domain`'s
 * `canonicalDocumentSchema`) that mirrors `canonical-v1.schema.json`.
 */
export function parseCanonicalDocument(content: string): Result<CanonicalDocument, IrohaError> {
  const split = splitFrontmatter(content);
  if (!split.ok) {
    return split;
  }
  const { yamlText, body } = split.value;

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(yamlText);
  } catch (cause) {
    return err(
      new IrohaError("INVALID_INPUT", "Canonical document frontmatter is not valid YAML", {
        cause,
      }),
    );
  }

  const result = canonicalDocumentSchema.safeParse({ frontmatter, body });
  if (!result.success) {
    return err(
      new IrohaError("INVALID_INPUT", "Canonical document failed schema validation", {
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
