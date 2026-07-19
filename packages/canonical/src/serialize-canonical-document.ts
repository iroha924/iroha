import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type CanonicalDocument,
  canonicalDocumentSchema,
  err,
  IrohaError,
  ok,
  type Result,
} from "@iroha/domain";
import { stringify as stringifyYaml } from "yaml";
import { parseCanonicalDocument } from "./parse-canonical-document.js";

type Frontmatter = CanonicalDocument["frontmatter"];

/** Picks `keys` out of `obj`, in that order, omitting any key absent from `obj` (never inserting `undefined`). */
function orderedPick<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
  const result = {} as T;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Field orders below mirror schemas/canonical-v1.schema.json's `properties`
// declaration order for each `$defs` entry — "the contract order" that
// canonical-schema.md §11 step 3 requires.

const ACTOR_REF_ORDER = ["provider", "id", "display_name"] as const;
const SCOPE_ORDER = ["repository", "paths", "symbols", "languages"] as const;
const SOURCE_ORDER = [
  "type",
  "ref",
  "url",
  "path",
  "line_start",
  "line_end",
  "quote_hash",
  "captured_at",
] as const;
const RELATION_ORDER = ["type", "target", "note"] as const;
const GUARD_ORDER = ["tools", "paths", "deny_commands"] as const;
const SESSION_ORDER = ["platforms", "run_count", "outcome"] as const;

function orderActorRef(actor: Frontmatter["created_by"]) {
  return orderedPick(actor, ACTOR_REF_ORDER);
}

function orderScope(scope: Frontmatter["scope"]) {
  return orderedPick(scope, SCOPE_ORDER);
}

/** canonical-schema.md §11 step 5: sort sources by `(type, ref, path, line_start)`. */
function orderSources(sources: Frontmatter["sources"]) {
  const sorted = [...sources].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    const aPath = a.path ?? "";
    const bPath = b.path ?? "";
    if (aPath !== bPath) return aPath < bPath ? -1 : 1;
    const aLine = a.line_start ?? 0;
    const bLine = b.line_start ?? 0;
    return aLine - bLine;
  });
  return sorted.map((source) => orderedPick(source, SOURCE_ORDER));
}

/** canonical-schema.md §11 step 6: sort relations by `(type, target)`. */
function orderRelations(relations: Frontmatter["relations"]) {
  const sorted = [...relations].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
  return sorted.map((relation) => orderedPick(relation, RELATION_ORDER));
}

/** canonical-schema.md §11 step 7: UTC with milliseconds — `Date#toISOString()` always produces this exact shape. */
function formatTimestamp(iso: string): string {
  return new Date(iso).toISOString();
}

function orderTypeSpecific(frontmatter: Frontmatter): Record<string, unknown> {
  switch (frontmatter.type) {
    case "session_summary":
      return { session: orderedPick(frontmatter.session, SESSION_ORDER) };
    case "decision":
      return { decision: frontmatter.decision };
    case "rule": {
      const rule = orderedPick(frontmatter.rule, ["enforcement", "severity", "guard"] as const);
      if (rule.guard !== undefined) {
        return { rule: { ...rule, guard: orderedPick(rule.guard, GUARD_ORDER) } };
      }
      return { rule };
    }
    case "concept":
      return { concept: frontmatter.concept };
    case "insight":
      return { insight: frontmatter.insight };
    case "incident":
      return { incident: frontmatter.incident };
    case "pattern":
      return { pattern: frontmatter.pattern };
    case "review_learning":
      return { review_learning: frontmatter.review_learning };
  }
}

/**
 * canonical-schema.md §11 step 3: the common frontmatter fields in exactly
 * the order the §5 example shows them (schema_version, id, type, title,
 * status, revision, created_at, updated_at, created_by, approved_by,
 * approved_at, labels, scope, sources, relations), followed by the single
 * type-specific object.
 */
function orderFrontmatter(frontmatter: Frontmatter): Record<string, unknown> {
  return {
    schema_version: frontmatter.schema_version,
    id: frontmatter.id,
    type: frontmatter.type,
    title: frontmatter.title,
    status: frontmatter.status,
    revision: frontmatter.revision,
    created_at: formatTimestamp(frontmatter.created_at),
    updated_at: formatTimestamp(frontmatter.updated_at),
    created_by: orderActorRef(frontmatter.created_by),
    approved_by: orderActorRef(frontmatter.approved_by),
    approved_at: formatTimestamp(frontmatter.approved_at),
    // Step 4: sort labels lexicographically.
    labels: [...frontmatter.labels].sort(),
    scope: orderScope(frontmatter.scope),
    sources: orderSources(frontmatter.sources).map((source) =>
      source.captured_at === undefined
        ? source
        : { ...source, captured_at: formatTimestamp(source.captured_at) },
    ),
    relations: orderRelations(frontmatter.relations),
    ...orderTypeSpecific(frontmatter),
  };
}

/** canonical-schema.md §11 step 8: trim trailing spaces per line, exactly one final newline. */
function normalizeWhitespace(text: string): string {
  const trimmedLines = text.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  return `${trimmedLines.join("\n").replace(/\n+$/, "")}\n`;
}

export interface SerializedCanonicalDocument {
  content: string;
  hash: string;
  document: CanonicalDocument;
}

/**
 * Deterministically serializes a canonical document candidate to its final
 * on-disk text, per canonical-schema.md §11 (steps 1, 3-10 — step 2,
 * secret scanning, is a separate concern composed by the write primitive,
 * since it needs to run on this function's *output* text and involves
 * async I/O this package's pure serializer should not require).
 *
 * "same semantic input produces byte-identical output" (WP-04 acceptance
 * criteria) requires every nested object's field order, label/source/
 * relation ordering, and timestamp formatting to be normalized here, not
 * left to whatever order the candidate happened to arrive in.
 */
export function serializeCanonicalDocument(
  candidate: unknown,
): Result<SerializedCanonicalDocument, IrohaError> {
  // Step 1: validate the parsed candidate with Zod.
  const parsedCandidate = canonicalDocumentSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return err(
      new IrohaError("INVALID_INPUT", "Canonical document candidate failed schema validation", {
        details: {
          issues: parsedCandidate.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      }),
    );
  }

  // Steps 3-7: normalize field order, label/source/relation sorting, timestamps.
  const orderedFrontmatter = orderFrontmatter(parsedCandidate.data.frontmatter);
  const yamlText = stringifyYaml(orderedFrontmatter).replace(/\n+$/, "");
  const rawContent = `---\n${yamlText}\n---\n\n${parsedCandidate.data.body}\n`;
  // Step 8: trim trailing spaces, exactly one final newline.
  const content = normalizeWhitespace(rawContent);

  // Steps 9-10: parse the serialized output again and assert semantic
  // equality; `parseCanonicalDocument` already re-validates against the
  // same schema that mirrors canonical-v1.schema.json.
  const reparsed = parseCanonicalDocument(content);
  if (!reparsed.ok) {
    return err(
      new IrohaError("INTERNAL_ERROR", "Serialized canonical document failed to round-trip parse", {
        cause: reparsed.error,
      }),
    );
  }
  // Structural (order-insensitive for object keys, order-sensitive for
  // arrays) equality — a JSON.stringify comparison would be fragile here
  // since it's not guaranteed that Zod's re-parsed object rebuilds keys in
  // exactly the same insertion order as `orderedFrontmatter`.
  if (!isDeepStrictEqual(reparsed.value.frontmatter, orderedFrontmatter)) {
    return err(
      new IrohaError(
        "INTERNAL_ERROR",
        "Serialized canonical document is not semantically equal to its source candidate after round-trip",
      ),
    );
  }
  if (reparsed.value.body !== parsedCandidate.data.body) {
    return err(
      new IrohaError(
        "INTERNAL_ERROR",
        "Serialized canonical document body changed after round-trip",
      ),
    );
  }

  const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return ok({ content, hash, document: reparsed.value });
}
