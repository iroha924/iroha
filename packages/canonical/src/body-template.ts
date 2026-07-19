import { type CanonicalDocument, err, IrohaError, ok, type Result } from "@iroha/domain";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

type CanonicalType = CanonicalDocument["frontmatter"]["type"];

/** Required H2 section headings per canonical type, per canonical-schema.md §7. */
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
 * Validates the Markdown body template, per canonical-schema.md §7: "The
 * first H1 must equal `title`. Required H2 sections are validated by the
 * canonical parser after JSON Schema validation." Uses an actual Markdown
 * AST (not line/regex scanning) so a `#`-prefixed line inside a fenced
 * code block is never mistaken for a heading.
 */
export function validateBodyTemplate(document: CanonicalDocument): Result<void, IrohaError> {
  const headings = collectHeadings(document.body);

  const firstH1 = headings.find((heading) => heading.depth === 1);
  if (firstH1 === undefined) {
    return err(new IrohaError("INVALID_INPUT", "Canonical document body has no H1 heading"));
  }
  if (firstH1.text !== document.frontmatter.title) {
    return err(
      new IrohaError("INVALID_INPUT", "Canonical document body's first H1 must equal the title", {
        details: { expected: document.frontmatter.title, actual: firstH1.text },
      }),
    );
  }

  const h2Texts = new Set(headings.filter((heading) => heading.depth === 2).map((h) => h.text));
  const required = REQUIRED_H2_SECTIONS[document.frontmatter.type] ?? [];
  const missing = required.filter((section) => !h2Texts.has(section));
  if (missing.length > 0) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `Canonical document body is missing required section(s): ${missing.join(", ")}`,
        { details: { type: document.frontmatter.type, missing } },
      ),
    );
  }

  return ok(undefined);
}
