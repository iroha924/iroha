import type { Clock, RandomSource, TypedId } from "@iroha/domain";
import { makeTypedId } from "@iroha/domain";
import { type CandidateType, closeDatabase, insertCandidate, openDatabase } from "@iroha/storage";
import type { CandidateDraft } from "../dashboard/build-canonical.js";

/** A decision body that already satisfies the canonical decision template (H1 + required H2s). */
export const VALID_DECISION_BODY = `# Use libSQL as the local index

## Context

We need a rebuildable local index.

## Decision

Use libSQL.

## Rationale

It is embeddable and rebuildable.

## Consequences

- None

## Alternatives considered

- Native SQLite`;

export function decisionDraft(overrides: Partial<CandidateDraft> = {}): CandidateDraft {
  return {
    type: "decision",
    title: "Use libSQL as the local index",
    summary: "libSQL was chosen as the local index",
    body: VALID_DECISION_BODY,
    labels: [],
    scope: { paths: [], symbols: [] },
    sources: [{ type: "commit", ref: "abc1234" }],
    ...overrides,
  };
}

/** Inserts a pending candidate directly and returns its id and optimistic token. */
export async function seedCandidate(
  dbPath: string,
  repositoryId: TypedId<"repo">,
  candidateType: CandidateType,
  draft: CandidateDraft,
  clock: Clock,
  random: RandomSource,
): Promise<{ candidateId: TypedId<"cand">; revisionToken: string }> {
  const opened = await openDatabase(dbPath);
  if (!opened.ok) {
    throw new Error(`open: ${opened.error.code}`);
  }
  const candidateId = makeTypedId("cand", clock, random);
  const revisionToken = Buffer.from(random.bytes(16)).toString("base64url");
  const inserted = await insertCandidate(opened.value, {
    id: candidateId,
    repositoryId,
    candidateType,
    payloadJson: JSON.stringify(draft),
    revisionToken,
    createdAt: clock.now().toISOString(),
  });
  await closeDatabase(opened.value);
  if (!inserted.ok) {
    throw new Error(`insert candidate: ${inserted.error.code}`);
  }
  return { candidateId, revisionToken };
}
