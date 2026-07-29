# iroha — MCP Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Checkpoint schema: `../schemas/checkpoint-v1.schema.json`

## 1. Purpose

The iroha MCP server is the stable agent-facing API shared by Claude Code and Codex. It exposes retrieval and local proposal operations, but never exposes human approval or canonical publication to an agent.

## 2. Transport and lifecycle

- Transport: stdio.
- Runtime: bundled Node.js ESM entrypoint.
- Server name: `iroha`.
- Protocol SDK baseline: `@modelcontextprotocol/sdk` 1.29.0.
- One server process per agent host configuration.
- Open the repository DB lazily after resolving an MCP root or request path.
- Write protocol logs only to stderr. Stdout is reserved for MCP frames.
- SIGINT/SIGTERM closes DB connections and flushes local events within 500ms.
- A missing/uninitialized repository returns a typed error; it does not initialize implicitly.

Plugin config launches the stdio MCP server through the installed `iroha`
binary (WP-11 Option A):

```text
iroha __mcp
```

No API key is passed as a command-line argument.

## 3. Server instructions

The first 512 characters must remain self-contained:

```text
iroha stores and retrieves approved engineering knowledge for the current Git repository. Search before making architecture or rule-sensitive changes. Create a checkpoint after meaningful implementation, decisions, validation, or discoveries. Checkpoints and proposals are local candidates, not approved team rules. Never claim a proposal is authoritative. Human approval is only available in the iroha dashboard or CLI.
```

Additional instructions may describe tool choice, but must not contain repository data or secrets.

## 4. Common response envelope

Every tool returns `structuredContent` matching one of:

```ts
interface Success<T> {
  schemaVersion: 1;
  ok: true;
  data: T;
  warnings: Warning[];
  traceId: string;
}

interface Failure {
  schemaVersion: 1;
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  traceId: string;
}
```

`content` also contains one concise text item for hosts that do not render structured content. It must not duplicate a large result body.

Error codes:

```text
NOT_INITIALIZED
REPOSITORY_NOT_FOUND
INVALID_INPUT
INVALID_SESSION_TOKEN
SESSION_EXPIRED
SCHEMA_MISMATCH
DB_BUSY
DB_UNAVAILABLE
EMBEDDING_UNAVAILABLE
FORGE_UNAVAILABLE
NOT_FOUND
CONFLICT
LIMIT_EXCEEDED
INTERNAL_ERROR
```

Stack traces, SQL, filesystem absolute paths, and secrets are never returned to the model.

## 5. Session token

Hooks create an opaque local session token and include it in agent context. Format:

```text
ist_<43 base64url characters>
```

Rules:

- generated from 256 random bits;
- only an HMAC-SHA-256 digest is stored;
- bound to repository, Agent Session, active Run, and platform;
- expires 24 hours after last use or when the Run is explicitly completed;
- never written to canonical files or normal logs;
- redacted from MCP error details;
- accepted only over the local stdio process.

Token possession allows local candidate creation, not canonical approval.

## 6. Tools

### 6.1 `search`

Purpose: retrieve approved knowledge and verified development artifacts.

Annotations: read-only, idempotent, non-destructive.

Input:

```ts
interface SearchInput {
  query: string;                    // 1..2000 chars
  repositoryPath?: string;          // repository or child path
  mode?: "hybrid" | "lexical" | "vector" | "graph";
  limit?: number;                   // default 10, max 50
  filters?: {
    entityTypes?: EntityType[];
    labels?: string[];
    statuses?: Array<"approved" | "active" | "resolved">;
    paths?: string[];
    symbols?: string[];
    issueRefs?: string[];
    from?: string;                  // RFC 3339
    to?: string;
    minimumAuthority?: number;      // 0..100, default 60
  };
  includeBody?: boolean;            // default false
}
```

Output data:

```ts
interface SearchData {
  query: string;
  effectiveMode: "hybrid" | "lexical" | "vector" | "graph";
  degradedFrom?: "hybrid" | "vector";
  results: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    body?: string;
    authority: number;
    status: string;
    score: number;
    whyRelevant: string[];
    sources: SourceRef[];
    relations: RelationPreview[];
  }>;
}
```

`SourceRef` and `RelationPreview` are MCP *output* shapes — the server constructs
them, they are never parsed from a request — so they intentionally have no
`schemas/*.json` JSON Schema mirror:

```ts
interface SourceRef {
  // contracts/canonical.md §5 source kinds
  type:
    | "session" | "checkpoint" | "issue" | "pull_request" | "review"
    | "commit" | "file" | "symbol" | "document" | "url";
  ref: string;
  path?: string;
  lineStart?: number;
}

interface RelationPreview {
  relationType: RelationType;              // contracts/canonical.md §5 relation types
  direction: "outgoing" | "incoming";
  entityId: string;
  title: string;
}
```

`includeBody=true` is capped at 10 results and 30,000 output characters.

### 6.2 `get_context`

Purpose: create a bounded context pack for the current task.

Annotations: read-only, idempotent.

Input:

```ts
interface GetContextInput {
  sessionToken: string;
  query?: string;                   // max 2000 chars
  activeIssueRefs?: string[];
  paths?: string[];
  symbols?: string[];
  maxItems?: number;                // default 12, max 20
  maxCharacters?: number;           // default 8000, max 16000
}
```

Output data:

```ts
interface ContextData {
  sessionId: string;
  runId: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    whyRelevant: string;
    sourceLabel: string;
  }>;
  unresolved: string[];
  truncated: boolean;
}
```

Ordering follows `contracts/database.md` context-pack priority. Pending candidates are excluded.

### 6.3 `get_active_rules`

Purpose: return approved Rules/Guardrails applicable to targets.

Annotations: read-only, idempotent.

Input:

```ts
interface GetActiveRulesInput {
  repositoryPath?: string;
  paths?: string[];
  symbols?: string[];
  toolName?: string;
  commandCategory?: string;
  includeAdvisory?: boolean;        // default true
  includeGuardrails?: boolean;      // default true
}
```

Output distinguishes `advisory` from `guardrail`, includes the source ID, scope, severity, and explanation. Raw guard specs are returned only when requested by the local Hook adapter, not by default model output.

### 6.4 `get_session_state`

Purpose: inspect the caller's current local session state.

Annotations: read-only, idempotent.

Input requires only `sessionToken`.

Output includes Session/Run/Turn IDs, branch, start SHA, last Checkpoint summary, pending Checkpoint status, unresolved items, and known Issue/PR refs. It excludes raw prompt/tool contents.

### 6.5 `get_relations`

Purpose: retrieve a bounded graph around one or more entities.

Annotations: read-only, idempotent.

Input:

```ts
interface GetRelationsInput {
  entityIds: string[];              // 1..20
  relationTypes?: RelationType[];
  direction?: "outgoing" | "incoming" | "both";
  depth?: number;                   // default 1, max 4
  maxEdges?: number;                // default 100, max 200
}
```

Output contains deduplicated nodes and edges plus `truncated`.

### 6.6 `create_checkpoint`

Purpose: save structured progress and optionally create knowledge candidates.

Annotations: local-write, idempotent by `idempotencyKey`, non-canonical.

Input must validate against `checkpoint-v1.schema.json`.

Transaction:

1. validate and authenticate session token;
2. secret-scan/redact allowed fields;
3. resolve or create Turn association;
4. insert entity and Checkpoint;
5. create candidates from `proposals`;
6. create explicit reference relations;
7. set Turn `checkpoint_state=saved`;
8. commit;
9. return existing result if the same idempotency key is retried.

Output data:

```ts
interface CreateCheckpointData {
  checkpointId: string;
  sessionId: string;
  runId: string;
  turnId?: string;
  candidateIds: string[];
  redactions: Array<{ field: string; reason: string }>;
  deduplicated: boolean;
}
```

Step 6 is resolve-only: a `references[]` entry whose `ref` names an existing
entity becomes a `checkpoint RELATED_TO entity` edge (`source_kind = inferred`);
a `ref` that resolves to no known entity is recorded on the checkpoint but not
linked. The tool never invents placeholder entities (§6.8). A proposal's
`relations[]` are not edges here — they materialize as canonical relations when
the candidate is approved.

### 6.7 `propose_knowledge`

Purpose: create or update one pending candidate outside a Checkpoint.

Annotations: local-write, idempotent, non-canonical.

`proposal.body` must already satisfy the canonical body template for `proposal.type` (`canonical.md` §7): a first H1 equal to `title`, plus that type's required H2 sections. A body that does not is rejected with `INVALID_INPUT`, and the message names the missing sections. The same check runs again at approval; running it here as well is what keeps a candidate from entering the queue in a state no reviewer can approve and no agent is still present to fix. `create_checkpoint` applies the identical check to each entry of `proposals`, prefixing the message with `proposals[<index>]`.

The H1 is compared as rendered text with both sides trimmed, so inline Markdown in a title (for example `` `code` ``) must be backslash-escaped in the heading to match.

Input:

```ts
interface ProposeKnowledgeInput {
  sessionToken: string;
  idempotencyKey: string;
  proposal: KnowledgeProposal;
  sourceCheckpointId?: string;
  supersedesCandidateId?: string;
}
```

Output data:

```ts
interface ProposeKnowledgeData {
  candidateId: string;
  redactions: Array<{ field: string; reason: string }>;
  deduplicated: boolean;              // true only on an idempotency-key retry
  duplicateCandidateIds: string[];    // same-type candidates sharing this title
}
```

The operation never writes `.iroha/`. When `supersedesCandidateId` is given, that
candidate is transitioned `pending` → `superseded` in the same write transaction
as the new candidate insert. The target **must be `pending`**: superseding an
`approved` candidate is a human-review action (dashboard/CLI, with an approval
audit row and the canonical supersession edit), not one an agent may take through
this token-only boundary (design.md §9) — an `approved`, `rejected`, `superseded`,
or non-existent target fails the whole operation (`INVALID_INPUT`). A likely
duplicate (an existing same-type candidate whose title matches, normalized)
returns a `likely_duplicate` warning and its IDs in `duplicateCandidateIds`; it
does not silently merge — the new candidate is always created.

### 6.8 `link_entities`

Purpose: create a local inferred relation for review and retrieval.

Annotations: local-write, idempotent, non-canonical unless later approved as part of a canonical document.

Input:

```ts
interface LinkEntitiesInput {
  sessionToken: string;
  idempotencyKey: string;
  fromEntityId: string;
  relationType: RelationType;
  toEntityId: string;
  evidence: string;                 // 1..1000 chars
  confidence: number;               // 0..1
}
```

Self-relations are rejected except `RELATED_TO`. Unknown entity IDs are rejected; tools do not invent placeholder entities.

### 6.9 `get_digest_data`

Purpose: return one Digest period's aggregate facts so an agent can compose the period's prose.

Annotations: read-only, idempotent.

Input:

```ts
interface GetDigestDataInput {
  unit?: "week" | "month";          // default: the stored `digest.period`
  offset?: number;                  // integer 0..520; 0 is the current period
}
```

No session token, matching the other read-only tools: it exposes aggregate counts already
derivable from the tools an agent has, and requiring a token would stop the composing skill from
running outside a live Run.

The response carries the period's identity, the aggregates, the same aggregates for the previous
period, any correlations iroha computed, the composed prose if the period already has one, and a
flat `facts` array of `{ id, value, label }`.

**Aggregates only, and person-less by construction.** The payload has no field named or typed as
actor, author, email, or session owner anywhere in it, so per-person narration is not something
the agent could produce — the data never arrives. Free text in a fact is either an
already-approved canonical entity's title or summary, or a repository-relative path a Guardrail
denied (realpath-resolved and repository-confined before storage, which §8 permits persisting).
Never a prompt, a transcript, a raw tool payload, or an absolute path.

### 6.10 `save_digest_prose`

Purpose: store the composed prose for one Digest period.

Annotations: local-write, idempotent, non-canonical and never committed to Git.

Input:

```ts
interface SaveDigestProseInput {
  sessionToken: string;
  /** Echoed from the `period` in the `get_digest_data` response this was composed against. */
  periodUnit: "week" | "month";
  periodKey: string;
  prose: {
    headline: string;               // 1..200
    standfirst: string;             // 1..500
    sections: {                     // 1..4
      slot: "stumbles" | "codebase" | "wins" | "teaching";
      heading: string;              // 1..120
      body: string;                 // 1..2000
    }[];
  };
}
```

**There is no field for a number.** To state a figure the prose references a fact id as
`{{factId}}`, and the renderer substitutes iroha's own value — so a fabricated figure is not
expressible. A reference to an id the period did not issue is rejected as `INVALID_INPUT`. The
offending ids are **not** returned: §4 strips `details` from every failure envelope, and echoing
them into the message would put agent-supplied text (which can be secret-shaped) into an error. The
agent already holds the issued list from `get_digest_data` and re-checks its references against it.
An id that later disappears renders as an em dash, not a stale number.

**The period is named, not derived.** `periodUnit`/`periodKey` come from the `get_digest_data`
response. An offset would be relative to "now", so a dropped or stale one silently files the
composition under a period it does not describe — and reference validation cannot catch that,
because the period-independent ids exist in every period's fact table. A key no period of that unit
produces is rejected.

Gates, in order: session token, the named period, fact references, then a secret scan of every
free-text field before the write. The shape is enforced by the tool's own input schema, which the
dispatcher strict-parses before the handler runs (§8), so it is not re-checked here.

**Redaction is reported.** A finding replaces the whole field, so the response carries
`redactions[]` and the call raises a `field_redacted` warning (§6.6 does the same for a Checkpoint):
a bare success would tell the agent a section saved when nothing of it survived.

Recomposing a period overwrites its previous issue — the numbers are recomputed on every read, so
an older narration of the same period is stale rather than history.

What the seam cannot prevent is prose that contradicts a correct number; the dashboard therefore
renders numbers as authoritative and labels the prose unreviewed.

## 7. Knowledge proposal contract

```ts
interface KnowledgeProposal {
  type:
    | "decision"
    | "rule"
    | "concept"
    | "insight"
    | "incident"
    | "pattern"
    | "review_learning";
  title: string;                    // 1..160
  summary: string;                  // 1..1000
  body: string;                     // Markdown, 1..20000
  confidence?: number;              // 0..1
  labels: string[];
  scope: {
    paths: string[];
    symbols: string[];
    languages?: string[];
  };
  enforcement?: "advisory" | "guardrail";
  guard?: GuardSpec;
  sources: SourceRef[];
  relations?: RelationInput[];
}
```

A `guardrail` proposal without a machine-evaluable guard spec is invalid. A proposed guard spec remains inactive until human approval.

## 8. Input limits and privacy

- Requests larger than 256 KiB are rejected.
- Unknown fields are rejected.
- Repository paths must resolve within the Git worktree after realpath normalization.
- Absolute paths are converted to repository-relative paths before persistence.
- Tool commands in Checkpoints remain local and undergo secret redaction.
- Prompt/transcript content is not accepted by any MCP tool field.
- Text sent to an Embedding provider is recorded by content hash and category, not plaintext log.
- Results may include approved canonical body text because the user explicitly chose retrieval; they never include local raw events.

## 9. Concurrency

- Read tools may run concurrently.
- Local write tools use short DB transactions and a repository write mutex.
- The idempotency key has a unique index scoped to repository and operation.
- A 2.5-second busy timeout is followed by `DB_BUSY` with `retryable=true`.
- MCP retries must not duplicate Checkpoints, candidates, or relations.

## 10. Approval boundary

The following operations are intentionally absent:

- approve/reject candidate;
- edit canonical documents;
- activate Guardrail;
- change retention/privacy policy;
- delete/export repository data.

These are human-facing CLI/Dashboard operations with separate anti-CSRF and confirmation contracts.

## 11. Contract tests

Required fixtures:

- valid request/response for every tool;
- every required-field omission;
- unknown field rejection;
- size and list limits;
- expired/wrong-repository session token;
- idempotent retry;
- DB busy and schema mismatch;
- Embedding unavailable fallback;
- secret redaction;
- path traversal and symlink escape;
- pending candidate exclusion;
- no approval tool in `tools/list`.

