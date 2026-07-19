import type { IrohaError, Result } from "@iroha/domain";
import { parseYamlDocument } from "./parse-yaml-document.js";
import { type LabelsFile, labelsFileSchema } from "./schemas/labels.js";

/** Parses and validates `taxonomy/labels.yaml` (canonical-schema.md §10). */
export function parseLabelsFile(content: string): Result<LabelsFile, IrohaError> {
  return parseYamlDocument(content, labelsFileSchema, "Failed to parse taxonomy/labels.yaml");
}
