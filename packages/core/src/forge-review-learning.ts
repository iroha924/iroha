import { createHash } from "node:crypto";
import {
  type Clock,
  type IrohaError,
  type KnowledgeProposal,
  makeTypedId,
  ok,
  proposalSchema,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import {
  type CandidateRow,
  type Database,
  type InsertCandidateInput,
  insertCandidate,
  listCandidatesByType,
  listReviewCommentsByRepository,
  type ReviewCommentRow,
  withTransaction,
} from "@iroha/storage";
import { redactProposal } from "./mcp/redact.js";

/**
 * Light recurrence detection over synced GitHub review comments (WP-12): when
 * the same review feedback shows up across enough *distinct* pull requests, it
 * is likely a durable team lesson rather than a one-off, so we propose it as a
 * `review_learning` candidate for a human to approve (invariant: a candidate is
 * never authoritative until a human approves it). This never writes canonical
 * files itself — approval goes through the existing `approveCandidate` path.
 *
 * The whole step is non-fatal / fail-open: `detectReviewLearnings` returns a
 * `Result`, but `runForgeSync` treats a failure as "0 learnings", never as a
 * sync error (design.md §12: "Forge failure must not fail canonical/Git sync").
 */

/** Label prefix marking a review-recurrence fingerprint (used for dedup). */
const RECURRENCE_LABEL_PREFIX = "forge-recurrence-";
/** Proposal contract caps: `sources` ≤ 100, `scope.paths` ≤ 100. */
const MAX_SOURCES = 100;
const MAX_SCOPE_PATHS = 100;

interface RecurrenceGroup {
  normalized: string;
  comments: ReviewCommentRow[];
  distinctPullRequests: Set<string>;
}

/**
 * Collapse a review-comment body to a recurrence key: lowercase, drop fenced /
 * inline code and URLs (PR-specific detail, not the reusable lesson), and
 * collapse whitespace. Two comments that say the same thing in different PRs
 * map to the same key.
 */
function normalizeCommentBody(body: string): string {
  return (
    body
      .toLowerCase()
      // Strip fenced code blocks — CommonMark/GitHub accept both ``` and ~~~ fences.
      .replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Stable, label-safe fingerprint (`[a-z0-9-]`) of a normalized body. */
function recurrenceLabel(normalized: string): string {
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${RECURRENCE_LABEL_PREFIX}${digest}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  // Keep the result within `max` UTF-16 units (the proposal contract's `.max()`
  // is measured in code units) while never cutting through a surrogate pair,
  // which would leave a lone surrogate (a malformed emoji half) in the stored
  // title/body. If the boundary char is a high surrogate, drop it.
  const boundary = value.charCodeAt(max - 1);
  const end = boundary >= 0xd800 && boundary <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

/** Group comments by normalized body, keeping only groups recurring across ≥ `threshold` distinct PRs. */
function groupByRecurrence(comments: ReviewCommentRow[], threshold: number): RecurrenceGroup[] {
  const byKey = new Map<string, RecurrenceGroup>();
  for (const comment of comments) {
    const normalized = normalizeCommentBody(comment.bodySummary);
    // Skip only comments that normalize to nothing (e.g. a body that was solely a
    // code block or a URL) — there is no reusable lesson to fingerprint. A
    // length-based floor is deliberately avoided: it silently drops short but
    // meaningful non-Latin feedback (e.g. Japanese "テストを追加してください", 12
    // UTF-16 units), and triviality is already filtered by the distinct-PR
    // threshold plus the human-approval gate.
    if (normalized.length === 0) {
      continue;
    }
    let group = byKey.get(normalized);
    if (group === undefined) {
      group = { normalized, comments: [], distinctPullRequests: new Set() };
      byKey.set(normalized, group);
    }
    group.comments.push(comment);
    group.distinctPullRequests.add(comment.pullRequestId);
  }
  return [...byKey.values()].filter((group) => group.distinctPullRequests.size >= threshold);
}

/**
 * Recurrence labels already carried by existing `review_learning` candidates
 * (any status). Deduping against pending *and* human-acted (approved/rejected/
 * superseded) candidates means re-running detection never re-proposes a finding
 * the reviewer has already seen or decided on.
 */
function collectExistingRecurrenceLabels(candidates: CandidateRow[]): Set<string> {
  const labels = new Set<string>();
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.payloadJson);
    } catch {
      continue;
    }
    const candidateLabels = (parsed as { labels?: unknown }).labels;
    if (!Array.isArray(candidateLabels)) {
      continue;
    }
    for (const label of candidateLabels) {
      if (typeof label === "string" && label.startsWith(RECURRENCE_LABEL_PREFIX)) {
        labels.add(label);
      }
    }
  }
  return labels;
}

/**
 * Build a redacted `review_learning` candidate for a recurrence group, or
 * `null` if the proposal cannot be formed (a field violates the proposal
 * contract) or the secret scanner fails — both are skipped, never stored, and
 * never surfaced as an error (fail-open).
 */
async function buildCandidateInput(
  group: RecurrenceGroup,
  label: string,
  repositoryId: TypedId<"repo">,
  clock: Clock,
  random: RandomSource,
): Promise<InsertCandidateInput | null> {
  const representative = group.comments[0];
  if (representative === undefined) {
    return null;
  }
  const pullRequestCount = group.distinctPullRequests.size;
  const excerpt = truncate(collapseWhitespace(representative.bodySummary), 120);

  const paths = [
    ...new Set(
      group.comments.map((comment) => comment.path).filter((path): path is string => path !== null),
    ),
  ].slice(0, MAX_SCOPE_PATHS);

  const sources: KnowledgeProposal["sources"] = group.comments
    .slice(0, MAX_SOURCES)
    .map((comment) =>
      comment.url !== null
        ? { type: "review" as const, ref: comment.externalId, url: comment.url }
        : { type: "review" as const, ref: comment.externalId },
    );

  const occurrences = group.comments.map((comment) => {
    const location =
      comment.path !== null
        ? ` (${comment.path}${comment.line !== null ? `:${comment.line}` : ""})`
        : "";
    return `- ${comment.url ?? comment.externalId}${location}`;
  });

  const confidence = Math.min(0.9, pullRequestCount / 10);
  const proposal: KnowledgeProposal = {
    type: "review_learning",
    title: truncate(`Recurring review feedback: ${excerpt}`, 160),
    summary: truncate(
      `A review comment recurred across ${pullRequestCount} pull requests (${group.comments.length} comments); consider capturing it as a durable rule or guideline.`,
      1000,
    ),
    body: truncate(
      [
        `A similar review comment appeared in ${pullRequestCount} distinct pull requests.`,
        "",
        "Representative comment:",
        representative.bodySummary,
        "",
        "Occurrences:",
        ...occurrences,
      ].join("\n"),
      20000,
    ),
    confidence,
    labels: [label, "review-learning"],
    scope: { paths, symbols: [] },
    sources,
  };

  const validated = proposalSchema.safeParse(proposal);
  if (!validated.success) {
    return null;
  }
  // Redact before storing: review-comment text is external free-text that may
  // carry a secret a reviewer pasted (secure-subprocess-and-credentials.md).
  const redacted = await redactProposal(validated.data, "proposal");
  if (!redacted.ok) {
    return null;
  }

  return {
    id: makeTypedId("cand", clock, random),
    repositoryId,
    candidateType: "review_learning",
    payloadJson: JSON.stringify(redacted.value.proposal),
    confidence,
    revisionToken: Buffer.from(random.bytes(16)).toString("base64url"),
    createdAt: clock.now().toISOString(),
  };
}

/**
 * Propose `review_learning` candidates for review comments that recur across
 * `threshold` or more distinct pull requests. Idempotent for sequential runs:
 * dedups by recurrence fingerprint (a read of existing candidates) so repeated
 * syncs never pile up duplicate proposals. Returns the number of new candidates
 * created.
 *
 * The dedup is a read-then-write, not a DB constraint (candidate labels live in
 * `payload_json`, and the candidates table intentionally has no content-unique
 * index), so two *concurrent* `iroha sync` processes could each miss the other's
 * not-yet-committed candidate and both insert one — an accepted race, consistent
 * with v0.1 having no cross-process forge-sync lock. The worst case is a single
 * duplicate pending proposal a human dismisses once; subsequent runs dedup the
 * rest.
 */
export async function detectReviewLearnings(
  db: Database,
  repositoryId: TypedId<"repo">,
  threshold: number,
  clock: Clock,
  random: RandomSource,
): Promise<Result<number, IrohaError>> {
  const commentsResult = await listReviewCommentsByRepository(db, repositoryId);
  if (!commentsResult.ok) {
    return commentsResult;
  }
  const groups = groupByRecurrence(commentsResult.value, threshold);
  if (groups.length === 0) {
    return ok(0);
  }

  const existingResult = await listCandidatesByType(db, repositoryId, "review_learning");
  if (!existingResult.ok) {
    return existingResult;
  }
  const seen = collectExistingRecurrenceLabels(existingResult.value);

  // Build (with async redaction) outside the write transaction so the scan
  // never holds a write lock open.
  const inputs: InsertCandidateInput[] = [];
  for (const group of groups) {
    const label = recurrenceLabel(group.normalized);
    if (seen.has(label)) {
      continue;
    }
    const input = await buildCandidateInput(group, label, repositoryId, clock, random);
    if (input !== null) {
      inputs.push(input);
    }
  }
  if (inputs.length === 0) {
    return ok(0);
  }

  const written = await withTransaction(db, "write", async (tx) => {
    for (const input of inputs) {
      const inserted = await insertCandidate(tx, input);
      if (!inserted.ok) {
        return inserted;
      }
    }
    return ok(undefined);
  });
  if (!written.ok) {
    return written;
  }
  return ok(inputs.length);
}
