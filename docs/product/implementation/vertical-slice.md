# iroha — First Vertical Slice

> Status: Implementation Baseline v1  
> Updated: 2026-07-18

## 1. Goal

Prove the complete product loop without Forge or Embedding network dependencies:

```text
init -> agent start -> approved retrieval -> tool observation -> checkpoint
     -> human review -> canonical publish -> DB rebuild -> second agent retrieval
```

The slice is complete only when both Claude Code and Codex pass the same normalized behavior contract.

## 2. Fixture repository

Create `tests/fixtures/repo-basic/` with:

```text
repo-basic/
├── AGENTS.md
├── CLAUDE.md
├── package.json
├── src/
│   ├── payments/service.ts
│   └── generated/client.ts
└── tests/
    └── payments.test.ts
```

Fixture rules:

- `src/generated/**` must not be edited directly;
- payment changes require `pnpm test payments`;
- architecture uses a repository pattern;
- synthetic Issue reference: `GH-42`.

All Git authors, URLs, IDs, and timestamps are synthetic and deterministic.

## 3. Acceptance flow

### Step A: initialization

Command:

```bash
iroha init --scan
```

Expected:

- `.iroha/schema-version`, `.iroha/config.yaml`, `.iroha/.gitignore`, taxonomy created;
- local DB created at the resolved Git path;
- migration v1 applied;
- source docs become local Rule/Decision candidates, not canonical documents;
- second run makes no destructive changes;
- `iroha doctor --json` reports FTS/vector capabilities and platform state.

### Step B: session start and retrieval

Feed Claude and Codex `SessionStart` fixtures.

Expected:

- Agent Session and Run created;
- session token returned;
- approved fixture Rule about generated files appears in context;
- pending candidate does not appear as authoritative context;
- same normalized event semantics on both platforms.

### Step C: prompt and tool lifecycle

Submit a prompt referencing `GH-42` and `src/payments/service.ts`, then simulate a successful edit and test command.

Expected:

- Turn created with HMAC prompt digest only;
- tool targets are repository-relative;
- no patch/command output stored in full;
- Turn becomes `checkpoint_state=pending`;
- related Rule/Decision context is returned within limit.

### Step D: Checkpoint

Call MCP `create_checkpoint` with:

- outcome `completed`;
- one implementation item;
- one passing validation;
- one Decision proposal;
- Issue and file references;
- no unresolved items.

Expected:

- one Checkpoint entity;
- one pending Decision Candidate;
- relations Session/Issue/File/Checkpoint/Candidate created;
- retry with same idempotency key returns the same IDs;
- Stop does not request a second Checkpoint.

### Step E: human approval

Launch dashboard, edit the candidate rationale, and approve.

Expected:

- canonical diff preview valid;
- file created under `.iroha/decisions/dec_<ULID>.md`;
- frontmatter/body round-trip passes;
- approval audit appended;
- knowledge entity authority becomes 100;
- browser cannot choose arbitrary output path;
- candidate is no longer in pending queue.

### Step F: rebuild and teammate simulation

Copy only Git-tracked repository data to a clean worktree, then:

```bash
iroha sync --rebuild
iroha search "なぜrepository patternを使うの？" --json
```

Expected:

- DB is rebuilt from `.iroha/` and Git;
- approved Decision is returned via FTS-only Japanese query;
- provenance points to canonical file and Issue/Session references;
- no local Candidate, token, prompt, or Tool Event is transferred;
- Claude and Codex MCP search return the same entity ID.

## 4. Guardrail flow

Add an approved fixture Guardrail for `src/generated/**` and simulate a write.

Expected PreToolUse response:

- deterministic deny;
- Rule ID and reason included;
- Tool Event marked denied;
- no full patch persisted;
- an unrelated file write is allowed;
- internal evaluation error fails open and produces a doctor warning;
- CI fixture independently enforces the generated-file rule.

## 5. Interruption flow

Create an active Run and pending Turn, then terminate without Stop/SessionEnd.

On next SessionStart:

- previous Run becomes interrupted;
- new Run is created for resume;
- last saved Checkpoint and unresolved items are injected;
- no summary is fabricated from transcript;
- Session identity remains stable.

## 6. Required assertions

Privacy assertions inspect:

- `.iroha/**/*`;
- every DB text column;
- structured logs;
- MCP responses;
- dashboard API responses;
- built plugin archive.

They fail when seeded secret markers, raw prompt text, raw patch text, absolute fixture paths, or session token plaintext appear outside explicitly ephemeral in-memory test values.

## 7. Performance budgets

With 10,000 generated search entities on Tier 1 CI reference hardware:

- SessionStart context p95 <= 1,000ms;
- UserPromptSubmit lexical retrieval p95 <= 300ms;
- PreToolUse Guardrail p95 <= 100ms;
- DB rebuild excluding Embedding <= 30s;
- dashboard initial API response <= 500ms;
- dashboard usable render <= 2s.

Performance tests report hardware and dataset seed. They are regression gates after a stable baseline is recorded.

## 8. Slice completion artifact

The implementation must produce:

- passing test report;
- packaged Claude and Codex plugin archives;
- generated schema documentation/checksums;
- a synthetic `.iroha/` example;
- a screen capture or screenshots of Review Queue and Work Graph;
- a Checkpoint describing what was implemented and what remains.

