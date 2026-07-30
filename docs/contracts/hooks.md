# iroha — Hook Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Normalized schema: `../schemas/normalized-event-v1.schema.json`

## 1. Purpose

Hooks provide low-latency lifecycle observation, context injection, and approved Guardrail evaluation. They are adapters around platform contracts, not the product's source of truth and not a complete security boundary.

## 2. Entrypoint

One entrypoint serves both platforms, invoked through the installed `iroha`
binary (WP-11 Option A; the native `@libsql/client`
binding cannot be inlined into a standalone plugin `.mjs`, so the plugin archive
ships no runtime `dist` and the hook shares the npm-installed binary):

```text
iroha __hook <claude|codex>
```

The process:

1. reads at most 1 MiB of UTF-8 JSON from stdin;
2. validates common and event-required platform fields;
3. uses `hook_event_name` as the event discriminator;
4. resolves the Git repository from `cwd`;
5. returns immediately with no output when outside an initialized repository;
6. executes the event use case;
7. writes exactly one platform-valid JSON object to stdout when output is needed;
8. writes no stdout for a successful side-effect-only event;
9. records redacted diagnostics locally;
10. exits 0 for success and recoverable internal failure.

Raw platform schemas are forward-compatible: known required fields are validated and unknown fields are ignored. Normalized events and persisted records are strict.

## 3. Hook configuration

### Claude Code command form

Both platforms invoke the `iroha` binary. Claude uses exec form; Codex uses a
single command string (it runs only `type: "command"` handlers):

Claude (`hooks/claude.json`):

```json
{
  "type": "command",
  "command": "iroha",
  "args": ["__hook", "claude"],
  "timeout": 1
}
```

Codex (`hooks/codex.json`):

```json
{
  "type": "command",
  "command": "iroha __hook codex",
  "timeout": 1
}
```

Each event entry sets its own timeout from section 7. No shell quoting, pipes, or lifecycle installation is required.

### Codex command form

POSIX:

```json
{
  "type": "command",
  "command": "node \"$PLUGIN_ROOT/dist/hook.mjs\" codex",
  "commandWindows": "node \"$env:PLUGIN_ROOT\\dist\\hook.mjs\" codex",
  "timeout": 1
}
```

The Windows command is a contract-test target. If Codex changes its Windows shell behavior, build-time generation may alter only this adapter command without changing core behavior.

Codex command hooks require explicit user trust. `iroha doctor` must distinguish installed, enabled, discovered, and trusted states.

## 4. Event support matrix

| Normalized kind | Claude event | Codex event | v0.1 |
|---|---|---|---:|
| `SESSION_STARTED` | `SessionStart` | `SessionStart` | P0 |
| `PROMPT_SUBMITTED` | `UserPromptSubmit` | `UserPromptSubmit` | P0 |
| `TOOL_STARTED` | `PreToolUse` | `PreToolUse` | P0 |
| `TOOL_COMPLETED` | `PostToolUse` | `PostToolUse` | P0 |
| `PERMISSION_REQUESTED` | `PermissionRequest` | `PermissionRequest` | P1 |
| `COMPACTION_STARTED` | `PreCompact` | `PreCompact` | P0 |
| `COMPACTION_COMPLETED` | `PostCompact` | `PostCompact` | P0 |
| `AGENT_STARTED` | `SubagentStart` | `SubagentStart` | P1 |
| `AGENT_STOPPED` | `SubagentStop` | `SubagentStop` | P1 |
| `TURN_STOPPED` | `Stop` | `Stop` | P0 |
| `SESSION_ENDED` | `SessionEnd` | unavailable | P0, Claude only |
| `TOOL_FAILED` | `PostToolUseFailure` | derive from `PostToolUse` response | P1 |
| `TURN_FAILED` | `StopFailure` | unavailable | Claude enhancement |
| `INSTRUCTIONS_OBSERVED` | `InstructionsLoaded` | unavailable | Claude enhancement |
| `TASK_CREATED` | `TaskCreated` | unavailable | P2 |
| `TASK_COMPLETED` | `TaskCompleted` | unavailable | P2 |

Other Claude events such as Config/CWD/File/Worktree/Elicitation are not required by v0.1. Adapters may record capability presence but must not introduce product behavior without an ADR and fixtures.

## 5. Common normalization

Input field mapping:

| Normalized | Claude | Codex |
|---|---|---|
| platform session ID | `session_id` | `session_id` |
| external turn ID | `prompt_id` when applicable | `turn_id` |
| cwd | `cwd` | `cwd` |
| model | `model` when present | `model` |
| permission mode | `permission_mode` | `permission_mode` |
| transcript locator | `transcript_path` | `transcript_path` |

`transcript_path` is not copied into the normalized persisted event. It may be retained only in an ephemeral adapter context for troubleshooting and must not be opened by P0 code.

Prompt and tool digests use repository-keyed HMAC-SHA-256, not a plain hash. This reduces trivial dictionary recovery of common prompts/commands.

## 6. Event behavior

### 6.1 SessionStart

1. validate input and resolve repository;
2. detect/repair stale active Runs as `interrupted`;
3. map platform session to Agent Session;
4. create a Run for `startup`, `resume`, `clear`, or `fork`, recording the branch and HEAD sha it starts on (a Claude `fork` begins a new session, so it creates a Run; its DB `start_source` is recorded as `startup`);
5. keep the current Run for `compact`;
6. compare canonical Git tree fingerprint and perform changed-file-only sync within budget;
7. issue/refresh the local session token;
8. build lexical/graph context from approved data;
9. return context with the token and MCP checkpoint instruction.

Do not run full rebuild, Forge sync, or remote Embedding in this Hook.

Claude output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<bounded iroha context>"
  }
}
```

Codex output uses the same shape with the Codex-supported event name.

### 6.2 UserPromptSubmit

1. create/upsert Turn;
2. use prompt text in memory for lexical retrieval;
3. persist only HMAC digest and optional redacted intent summary;
4. combine applicable approved rules, current Issue/PR, file/symbol scope, and recent Checkpoint;
5. return at most 8,000 characters.

No remote query embedding occurs in the Hook. The agent uses MCP `search`/`get_context` when deeper semantic retrieval is useful.

Output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<bounded iroha context>"
  }
}
```

iroha does not block user prompts in v0.1.

### 6.3 PreToolUse

1. normalize tool name and allowlisted targets;
2. evaluate only approved active Guardrails whose scope matches;
3. create a started Tool Event without full input;
4. deny only on a deterministic matching Guardrail;
5. return the Rule ID, title, and human-readable reason.

Deny output for both platforms:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by iroha rule rul_...: <reason>"
  }
}
```

v0.1 does not rewrite tool input and does not auto-allow PermissionRequest. An internal iroha failure is fail-open and locally logged.

### 6.4 PostToolUse

1. match the event by platform tool-use ID when available;
2. update status and duration;
3. extract repository-relative changed paths, command category, exit state, and result digest;
4. mark the Turn Checkpoint pending after a meaningful mutation/validation;
5. create inferred local relations with confidence when evidence is deterministic.

The Hook does not persist full output and normally emits no model-visible output.

### 6.5 PreCompact / PostCompact

PreCompact flushes the current Turn state and creates a dirty marker if meaningful work lacks a Checkpoint. It does not block compaction.

PostCompact records the trigger. Claude's `compact_summary` may be stored as local recovery evidence only after redaction; it is not canonical and does not become approved knowledge automatically. Codex has no summary payload requirement.

The subsequent `SessionStart` with source `compact` injects approved rules and the last structured Checkpoint.

### 6.6 Stop

A Turn **requires** a Checkpoint when at least one is true:

- a mutation tool succeeded;
- a command **failed**, or ran on a platform that cannot report failure;
- an approved Guardrail was evaluated as warning/deny;
- the agent explicitly created knowledge proposals;
- the Turn is already marked `checkpoint_state=pending`.

A Turn is **suggested** a Checkpoint, without being required one, when a command
**settled successfully** and nothing above applies. A command still `started`, or
denied by a Guardrail, does not count: it never ran.

The two command cases split because the hook cannot tell a build/test/migration
command from a read-only `curl` or `git status`; that needs the command category
§6.4 step 3 calls for, and the attempt to approximate it is documented at
`requiresCheckpoint` in `packages/core/src/hooks/dispatch.ts`. Failure is the
proxy that works without the classifier: polling succeeds, and a validation that
found something does not — so a failed command still requires a Checkpoint, which
is the case worth keeping, while a successful one only suggests. Requiring one
for *every* command was measured filling the record with near-empty entries: 15
Checkpoints across 17 Turns in one session, 11 of them recording only that
something was being waited on. Those land in the same review queue a human reads,
so a Checkpoint saying nothing happened is worse than no Checkpoint. The agent
holds the whole Turn and can see what a command was for, so the suggestion asks
it rather than forcing it.

The proxy needs failure to be observable, and §4's matrix defers Codex's
`TOOL_FAILED` to "derive from `PostToolUse` response" at P1 — so `parseCodexEvent`
reports every settled tool as succeeded. Applying the split there would read a
failed `pnpm test` as a success, so on a platform that cannot report failure every
command keeps the required path. Codex therefore keeps the noise this split
removes for Claude, until its adapter can tell the two apart.

Behavior:

1. if no Checkpoint is required or suggested, complete the Turn and return `{}`;
2. if saved, complete the Turn and return `{}`;
3. if required and `stop_hook_active=false`, return one continuation request;
4. if suggested, the Turn is still `active`, and `stop_hook_active=false`,
   complete the Turn and return the suggestion as `additionalContext` — this
   never blocks, and never repeats because the Turn is no longer active when a
   second Stop arrives;
5. if `stop_hook_active=true`, never block again; leave a dirty marker and allow stop;
6. never parse the transcript to decide.

Continuation output:

```json
{
  "decision": "block",
  "reason": "Save an iroha checkpoint with the create_checkpoint MCP tool, then finish. Include implementation, validation, decisions, and unresolved items. Do not invent work that did not occur."
}
```

Suggestion output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "This turn ran a command. If it produced something worth keeping — an implementation, a decision, a validation result, a discovery — save an iroha checkpoint with the create_checkpoint MCP tool. If it did not, finish without one."
  }
}
```

### 6.7 SessionEnd and interruption

Claude `SessionEnd` closes the Run: it updates Run status, records the HEAD sha the Run ended on, and, if the Run's most recent Turn is still `active`, transitions that Turn to `interrupted` in the same transaction — a Turn open when its Run closes never reached its own Stop, so it did not complete. Stale Run repair at the next `SessionStart` closes that Turn the same way. Only the most recent Turn is repaired; an earlier Turn left open by consecutive `UserPromptSubmit` events with no `Stop` between them is not. `SessionEnd` performs no Embedding, canonical write, or summary generation. The configured budget remains 1.5 seconds.

Codex has no `SessionEnd`. Abrupt exit and user interruption are recovered at the next `SessionStart` by stale active Run detection. Therefore correctness never depends on an end Hook.

## 7. Time budgets

| Event | Hook timeout | Internal target | Remote calls |
|---|---:|---:|---:|
| SessionStart | 3.0s | p95 1.0s | forbidden |
| UserPromptSubmit | 1.5s | p95 300ms | forbidden |
| PreToolUse | 0.5s | p95 100ms | forbidden |
| PostToolUse | 0.75s | p95 200ms | forbidden |
| Pre/PostCompact | 1.0s | p95 300ms | forbidden |
| Stop | 2.0s | p95 300ms | forbidden |
| SubagentStart/Stop | 1.0s | p95 300ms | forbidden |
| Claude SessionEnd | 1.5s | p95 200ms | forbidden |

On timeout or DB busy, preserve agent progress and record diagnostics when possible. A Guardrail whose evaluation times out does not deny; CI is required for hard enforcement.

Repository resolution runs `git` under a per-event cap (half the hook timeout above), not the shared 10s default, so a hung `git` fails open within budget instead of being killed by the platform. The CLI, `iroha doctor`, and the dashboard keep the 10s default (a slow mount there should wait, not fail).

## 8. Tool target extraction

Adapters pass raw input to a platform-specific extractor that returns only:

```ts
interface ToolTarget {
  kind: "file" | "path" | "command" | "mcp" | "other";
  value: string;
  operation?: "read" | "write" | "delete" | "execute" | "unknown";
}
```

Rules:

- paths become repository-relative after symlink-safe realpath checks;
- shell commands are classified, not stored verbatim by default;
- MCP arguments are allowlisted per known server/tool; otherwise only tool name and digest are retained;
- `apply_patch` content is not stored;
- hosted tools not observed by Codex hooks are not inferred as completed.

## 9. Context output format

Human- and agent-readable context:

```text
[iroha]
session_token: ist_...
session: ses_...
run: run_...

Applicable approved knowledge:
- rul_... Rule title — short summary (why: path src/payments/**)
- dec_... Decision title — short summary (source: PR #123)

Recent checkpoint:
- chk_... partial — short summary
  unresolved: ...

Use the iroha MCP search tool for full sources. Create a checkpoint after meaningful work.
Write checkpoint and proposal content in Japanese (config.default_language), whatever language this session is in.
Before saving, check that Japanese in separate reads — non-words, calques, unnatural collocation, invented terminology, padding — and fix what a native speaker would not write (see the `checkpoint` skill).
[/iroha]
```

IDs and provenance must remain visible. Do not phrase retrieved text as a higher-priority system command. Context states repository facts and approved conventions.

The content-language line names `config.default_language` rendered as a language name (`ja` → Japanese, `en` → English). It is the only place the agent learns which language a Checkpoint or Proposal must be written in, so it is emitted on every SessionStart rather than only when the value is non-default (#164). It governs candidate `title`/`summary`/`body` only — the canonical section headings are contract constants and stay English.

The prose-check line that follows it is emitted **per locale** and is absent for `en`. A Checkpoint's `summary` and `unresolved` are stored with no approval step and are read back by a later session (§6.4 `get_session_state`), so the write is the last point at which unnatural prose can be caught, and only the agent re-reading it can judge that — a shipped check cannot (a morphological dictionary is 8-18x the whole published package, and no pattern set decides whether a phrase is idiomatic). It is `ja`-only because the class that motivated it, wrong-kanji substitution inside a 漢語 compound, yields a non-word with no English analogue; a new locale must decide explicitly rather than inherit. The same requirement is repeated in the `create_checkpoint`/`propose_knowledge` tool descriptions, which an agent reads at call time, and the full procedure is in the `checkpoint` skill.

## 10. Privacy and logging

Never persist or log:

- `prompt`;
- `last_assistant_message`;
- transcript content/path;
- complete `tool_input` or `tool_response`;
- session token plaintext;
- secrets or credentials.

Local structured logs include event kind, adapter, duration, outcome, IDs, and stable error code. Debug mode may show sanitized field names and sizes, never values from blocked fields.

These logs are the `event_log` table. **The Hook path deliberately writes no row to it.** The INSERT waits on libSQL's `busy_timeout` (2500 ms) whenever another process holds the write lock — measured at 2655 ms on a Stop against a concurrent writer, versus a §7 budget of 2.0 s, and 7932 ms on a PreToolUse denial against a budget of 0.5 s. The platform kills the hook at its deadline, so a diagnostics row would destroy exactly the outputs worth diagnosing: a Guardrail deny and a Stop continuation. Fail-open does not save it either, since a busy wait is latency rather than an error. Hook activity remains observable through the Turn/Run/Tool Event records the handlers already write, where a denial is `tool_events.phase = 'denied'`.

`event_log` is written by the other producers — MCP tool calls, dashboard API mutations and failures, and canonical/Forge sync. `adapter` therefore holds the source identifier of whichever producer wrote the row (the tool name for MCP, the matched route pattern for an API request), always a value fixed in this repository, never one derived from a prompt, a tool input, or a request path.

## 11. Contract fixtures

For each P0 event and platform, keep:

- minimum valid input;
- realistic full input;
- future unknown fields;
- missing required field;
- malformed JSON;
- 1 MiB boundary;
- path with spaces/Japanese characters;
- secret-bearing tool input;
- expected normalized event;
- expected platform output.

Fixtures contain synthetic IDs and paths only. CI validates official baseline versions with end-to-end smoke sessions in addition to static fixtures.

## 12. Official source notes

- Claude supports exec-form command Hooks and the current rich event set. `SessionEnd` has a 1.5-second default and can be configured within a bounded overall budget.
- Codex executes command handlers, requires trust for non-managed/plugin Hooks, and has no SessionEnd event.
- Both platforms explicitly treat transcript format as unstable for Hook consumers.
- Codex limits individual model-visible Hook output to roughly 2,500 tokens; iroha's own 8,000-character limit stays below that in normal Japanese/English payloads.

Sources: [Claude Hooks](https://code.claude.com/docs/en/hooks), [Codex Hooks](https://learn.chatgpt.com/docs/hooks).

