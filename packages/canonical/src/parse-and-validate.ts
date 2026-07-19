import type { CanonicalDocument, IrohaError, Result } from "@iroha/domain";
import { validateBodyTemplate } from "./body-template.js";
import { parseCanonicalDocument } from "./parse-canonical-document.js";

/**
 * Full read-side validation of a canonical document: schema (Zod) followed
 * by the body-template check, matching canonical-schema.md §7's stated
 * order ("validated by the canonical parser after JSON Schema
 * validation").
 */
export function parseAndValidateCanonicalDocument(
  content: string,
): Result<CanonicalDocument, IrohaError> {
  const parsed = parseCanonicalDocument(content);
  if (!parsed.ok) {
    return parsed;
  }
  const bodyResult = validateBodyTemplate(parsed.value);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  return parsed;
}
