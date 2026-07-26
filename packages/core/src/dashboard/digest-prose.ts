/**
 * The prose half of the Digest, and the boundary that keeps it honest.
 *
 * iroha never calls an external LLM to write this. The composer is the
 * developer's own Claude Code or Codex session, running the `/iroha:digest`
 * skill against `get_digest_data` / `save_digest_prose` — so there is no API key,
 * no cost, and no new outbound dependency (see ADR-016 in docs/architecture.md,
 * which records the non-violation explicitly because "iroha generates editorial
 * prose" invites exactly the opposite reading).
 *
 * The agent writes sentences and nothing else. Numbers reach the page only
 * through `{{factId}}` references that the renderer substitutes with iroha's own
 * values, so a fabricated figure is not something prose is able to express. What
 * the seam cannot prevent is prose that *contradicts* a correct number — calling
 * a denial spike a quiet week — which is why the page renders numbers as
 * authoritative and labels the prose unreviewed.
 */
import type { IrohaError, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import { z } from "zod";
import { redactField } from "../mcp/redact.js";
import type { DigestFact } from "./digest.js";

/**
 * The four sections of an issue, fixed rather than agent-chosen. A stable set
 * keeps the page layout predictable and stops an issue from growing an
 * editorialised section that has no facts behind it.
 */
export const DIGEST_SLOTS = ["stumbles", "codebase", "wins", "teaching"] as const;

export type DigestSlot = (typeof DIGEST_SLOTS)[number];

export const digestProseSchema = z.strictObject({
  headline: z.string().min(1).max(200),
  /** The deck under the headline — one sentence framing the period. */
  standfirst: z.string().min(1).max(500),
  sections: z
    .array(
      z.strictObject({
        slot: z.enum(DIGEST_SLOTS),
        heading: z.string().min(1).max(120),
        body: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(DIGEST_SLOTS.length),
});

export type DigestProse = z.infer<typeof digestProseSchema>;

export interface DigestProseIssue {
  prose: DigestProse;
  composedAt: string;
  /**
   * Always true. The page states it, because nothing reviewed this text — the
   * one thing the fact-ID seam cannot check is whether the sentences agree with
   * the numbers.
   */
  unreviewed: true;
}

/**
 * A `{{factId}}` reference. The character class matches the id vocabulary
 * `buildFacts` produces and nothing else, and there is no nested quantifier, so
 * matching is linear over an already length-bounded string.
 */
const FACT_REFERENCE = /\{\{([A-Za-z0-9._-]+)\}\}/g;

/** What an unresolvable reference renders as — an em dash, never a guessed number. */
const MISSING_VALUE = "—";

function factReferences(text: string): string[] {
  return [...text.matchAll(FACT_REFERENCE)].map((match) => match[1] as string);
}

/** Every distinct fact id the prose references, across all of its fields. */
export function referencedFactIds(prose: DigestProse): string[] {
  const ids = [
    ...factReferences(prose.headline),
    ...factReferences(prose.standfirst),
    ...prose.sections.flatMap((section) => [
      ...factReferences(section.heading),
      ...factReferences(section.body),
    ]),
  ];
  return [...new Set(ids)];
}

/**
 * Substitute each reference with iroha's value for that fact.
 *
 * An id that no longer exists renders as an em dash rather than being left as a
 * raw `{{…}}` or filled with a stale number. Validation at save time cannot
 * prevent this: facts are derived from live data, so a Rule deleted after an
 * issue was composed takes its `byRule` fact with it.
 */
export function renderProse(prose: DigestProse, facts: readonly DigestFact[]): DigestProse {
  const values = new Map(facts.map((fact) => [fact.id, String(fact.value)]));
  const substitute = (text: string): string =>
    text.replace(FACT_REFERENCE, (_match, id: string) => values.get(id) ?? MISSING_VALUE);
  return {
    headline: substitute(prose.headline),
    standfirst: substitute(prose.standfirst),
    sections: prose.sections.map((section) => ({
      slot: section.slot,
      heading: substitute(section.heading),
      body: substitute(section.body),
    })),
  };
}

/**
 * Reject prose that cites a fact this period does not have.
 *
 * This is the half of the seam that keeps narration tied to evidence: an agent
 * cannot invent `{{local.denials.total}}`-shaped authority for a number iroha
 * never issued. Reported with the offending ids so the composing agent can fix
 * its own output.
 */
export function validateFactReferences(
  prose: DigestProse,
  facts: readonly DigestFact[],
): Result<void, IrohaError> {
  const issued = new Set(facts.map((fact) => fact.id));
  const unknown = referencedFactIds(prose).filter((id) => !issued.has(id));
  if (unknown.length > 0) {
    return err(
      new IrohaErrorClass("INVALID_INPUT", "Digest prose references facts that were not issued", {
        details: { unknownFactIds: unknown },
      }),
    );
  }
  return ok(undefined);
}

/**
 * Scan every free-text field for secrets before the prose is stored.
 *
 * All four are unconstrained free text — `headline`, `standfirst`, and each
 * section's `heading` and `body`; `slot` is a Zod enum and so cannot carry a
 * value at all. The input is aggregates and approved-canonical titles, which
 * should hold no secret, but this is an at-rest store and
 * `secure-subprocess-and-credentials.md` requires the scan regardless — a
 * denylist cannot strip what it never saw, so the scan happens before the write
 * rather than on the way out.
 *
 * A scanner failure is an error, never a silent store: unscanned text must not
 * reach the database.
 */
export async function redactProse(prose: DigestProse): Promise<Result<DigestProse, IrohaError>> {
  const headline = await redactField("headline", prose.headline);
  if (!headline.ok) {
    return headline;
  }
  const standfirst = await redactField("standfirst", prose.standfirst);
  if (!standfirst.ok) {
    return standfirst;
  }
  const sections: DigestProse["sections"] = [];
  for (const [index, section] of prose.sections.entries()) {
    const heading = await redactField(`sections[${index}].heading`, section.heading);
    if (!heading.ok) {
      return heading;
    }
    const body = await redactField(`sections[${index}].body`, section.body);
    if (!body.ok) {
      return body;
    }
    sections.push({ slot: section.slot, heading: heading.value.value, body: body.value.value });
  }
  return ok({ headline: headline.value.value, standfirst: standfirst.value.value, sections });
}

/**
 * Parse a stored `prose_json` row. A row that no longer matches the schema is
 * treated as absent, not as an error: prose is decoration over authoritative
 * numbers, so a malformed issue should degrade to templated copy rather than
 * break the page.
 */
export function parseStoredProse(json: string, composedAt: string): DigestProseIssue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const validated = digestProseSchema.safeParse(parsed);
  return validated.success ? { prose: validated.data, composedAt, unreviewed: true } : null;
}
