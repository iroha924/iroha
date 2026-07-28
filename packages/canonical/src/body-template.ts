import { type CanonicalDocument, err, IrohaError, ok, type Result } from "@iroha/domain";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export type CanonicalType = CanonicalDocument["frontmatter"]["type"];

/** Required H2 section headings per canonical type, per contracts/canonical.md §7. */
const REQUIRED_H2_SECTIONS: Record<CanonicalType, readonly string[]> = {
  session_summary: [
    "Objective",
    "Outcome",
    "Changes",
    "Validation",
    "Decisions",
    "Unresolved",
    "References",
  ],
  decision: ["Context", "Decision", "Rationale", "Consequences", "Alternatives considered"],
  rule: ["Rule", "Scope", "Rationale", "Examples", "Exceptions"],
  concept: ["Definition", "Domain context", "Examples", "Related concepts"],
  insight: ["Observation", "Evidence", "Implication", "Recommended action"],
  incident: ["Summary", "Impact", "Timeline", "Root cause", "Resolution", "Prevention"],
  pattern: ["Problem", "Pattern", "When to use", "When not to use", "Examples"],
  review_learning: ["Review finding", "Why it matters", "Resolution", "Generalized learning"],
};

interface Heading {
  depth: number;
  text: string;
}

function collectHeadings(body: string): Heading[] {
  const tree = fromMarkdown(body);
  const headings: Heading[] = [];
  visit(tree, "heading", (node) => {
    headings.push({ depth: node.depth, text: mdastToString(node) });
  });
  return headings;
}

/**
 * The heading is caller-supplied and may fill the body's 20,000-character budget,
 * and this text reaches the model through the MCP envelope's `content` item, which
 * §4 requires to stay concise. `details` keeps the untruncated value.
 */
const MAX_ECHOED_HEADING = 120;

function excerpt(text: string): string {
  return text.length > MAX_ECHOED_HEADING ? `${text.slice(0, MAX_ECHOED_HEADING)}…` : text;
}

/**
 * Validates the Markdown body template, per contracts/canonical.md §7: "The
 * first H1 must equal `title`. Required H2 sections are validated by the
 * canonical parser after JSON Schema validation." Uses an actual Markdown
 * AST (not line/regex scanning) so a `#`-prefixed line inside a fenced
 * code block is never mistaken for a heading.
 */
export function validateBodyTemplate(document: CanonicalDocument): Result<void, IrohaError> {
  return validateBodyForType(document.frontmatter.type, document.frontmatter.title, document.body);
}

/**
 * The same check against a type/title/body triple, for callers that hold a
 * candidate rather than a parsed document — the MCP write path, which rejects a
 * non-conforming body at the moment it is written instead of leaving it to fail
 * at approval, when the agent that could fix it is long gone.
 *
 * The messages name the sections the body is missing: they are the only thing an
 * agent gets back, and "missing a section" is not enough to rewrite from.
 */
export function validateBodyForType(
  type: CanonicalType,
  title: string,
  body: string,
): Result<void, IrohaError> {
  const headings = collectHeadings(body);
  const required = REQUIRED_H2_SECTIONS[type] ?? [];

  // Both sides of the H1 comparison are trimmed, so a whitespace-only title would
  // match a bare `#` and approve a blank-titled document. The schemas only bound
  // the raw length, so this is the check that keeps §7's equality meaningful.
  if (title.trim().length === 0) {
    return err(new IrohaError("INVALID_INPUT", "Canonical document title is blank"));
  }

  const firstH1 = headings.find((heading) => heading.depth === 1);
  if (firstH1 === undefined) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `Canonical document body has no H1 heading. It must open with "# ${title}"` +
          (required.length > 0 ? `, followed by the H2 sections: ${required.join(", ")}` : ""),
        { details: { expected: title, required } },
      ),
    );
  }
  // Normalize to NFC before comparing: the same visible title in precomposed
  // vs. combining-character form is byte-different but semantically equal, and
  // a raw `!==` would falsely reject a genuinely matching title.
  // Trimmed on both sides: a Markdown heading cannot carry leading or trailing
  // whitespace, and `title` is not trimmed by its schema, so a padded title would
  // otherwise make the template unsatisfiable rather than merely unmet.
  if (firstH1.text.trim().normalize("NFC") !== title.trim().normalize("NFC")) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        // Both values go in the message, not only in `details`: the MCP failure
        // envelope drops `details`, and without them the caller is told the
        // headings disagree but not how. The heading is compared as rendered
        // text, so inline Markdown in a title must be backslash-escaped to match.
        `Canonical document body's first H1 must equal the title. Expected "${title}", got "${excerpt(firstH1.text)}"` +
          " (a title containing inline Markdown must be backslash-escaped in the H1)",
        { details: { expected: title, actual: firstH1.text } },
      ),
    );
  }

  const h2Texts = new Set(headings.filter((heading) => heading.depth === 2).map((h) => h.text));
  const missing = required.filter((section) => !h2Texts.has(section));
  if (missing.length > 0) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `Canonical document body is missing required section(s): ${missing.join(", ")}. ` +
          `A ${type} body needs the H2 sections: ${required.join(", ")}`,
        { details: { type, missing, required } },
      ),
    );
  }

  return ok(undefined);
}
