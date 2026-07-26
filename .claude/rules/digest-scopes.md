---
paths:
  - "packages/core/src/dashboard/digest*.ts"
  - "packages/core/src/mcp/digest.ts"
  - "packages/storage/src/repositories/digest.ts"
  - "apps/dashboard/src/pages/Digest.tsx"
  - "packages/plugin/skills/digest/SKILL.md"
---

# The Digest: which facts belong where, and what the prose seam guarantees

The Digest is the dashboard's front page — a per-period read on how the agent and the ruleset are
doing. Four constraints shaped it, and each is easy to break by accident while adding a fact, a
section, or a tool. `docs/contracts/database.md` §16 is the full contract; this file is the part
you must hold in your head *before* editing.

## 1. The scope membership test

A fact belongs to the **team** scope if and only if it is identical for every teammate who
regenerates it from the same `.iroha/**` at the same Git HEAD. Otherwise it is **local**.

Apply the test to every fact you add. Getting it wrong makes the page lie: a "team" number that
differs per clone reads as shared truth that teammates cannot reproduce.

- **Local**: anything from `tool_events`, `checkpoints`, `session_runs`, `event_log`, or
  `review_comments` — disposable index state, per-clone by construction. Also anything derived
  from Forge sync, because it depends on who ran `iroha sync` (that is why the pending
  `review_learning` count is local, not team).
- **Team**: anything windowed by `knowledge_items.approved_at` with `status = 'approved'`. That
  timestamp travels in the canonical frontmatter and is restored on rebuild, so every clone agrees.

**A team-wide raw denial tally is not collectable** and adding one is not a matter of writing the
query. Denials exist only in each developer's local index; a shared tally needs a shared store,
which is the forbidden daemon or telemetry upload. "Where the agent stumbles across the team" is
answerable only through the systemic lens: review recurrence and ruleset adequacy.

The per-developer window preference (`local_settings` → `digest.period`) does **not** violate the
team property — that property is about the facts for a *given* window, not about everyone picking
the same window.

## 2. The hook may not write a diagnostics row — ever

A denial's Rule attribution rides on the `tool_events` insert `handleToolStarted` already performs.
Do not add a second write on the hook path for the Digest or anything else: a hook write waits on
libSQL's 2500 ms `busy_timeout` and was measured at **7932 ms on a PreToolUse denial against a
0.5 s budget** (`hooks.md` §10), after which the platform kills the hook and the Guardrail deny is
lost. The instrumentation would destroy the very output worth instrumenting, and fail-open cannot
help — a busy wait is latency, not an error.

If a new Digest fact needs data the hook does not already write, the answer is a column on a row
the hook already inserts, not a new insert.

## 3. The fact-ID seam — never give prose a number slot

`computeDigest` issues a flat `facts` list of `{ id, value, label }`. The composing agent may
reference a fact as `{{factId}}`; it has **no field to write a number into**, and the renderer
substitutes iroha's value. This is what makes a fabricated figure inexpressible rather than merely
discouraged.

When you add a rendered number, add a fact for it in the same change. The invariant runs both ways:

- a number on the page with no fact is one the prose cannot cite;
- a fact never rendered is a claim with no visible source.

`save_digest_prose` validates references against the *same* `computeDigest` result the page reads,
so validation can never accept a citation the page will not render. Keep it that way — a second,
parallel fact computation on the write path would reopen exactly the gap the seam closes.

Fact ids are derived from what the fact *is*, never from a counter or random seed: prose composed
against one page load has to still resolve on the next.

**What the seam does not prevent** is prose that contradicts a correct number — "a quiet week" over
a denial spike. That is inherent to narration and unfixable by architecture, which is why numbers
render as authoritative and prose always carries the unreviewed label. Do not remove that label.

## 4. No blended score, and no person

- **No adherence percentage.** The majority of `.claude/rules/*.md` are advisory prose with no
  machine-observable footprint, so no honest total exists. The page shows three separately sourced
  facts — enforceable stumbles, ruleset adequacy, review recurrence — and says outright that
  advisory rules are not measured. Do not blend them, and do not add a fourth signal by averaging
  the first three.
- **Frame ruleset adequacy symmetrically.** A Guardrail that names no paths cannot be enforced at
  the hook, and a malformed spec is skipped: "the setup failed the agent" is as much the story as
  "the agent broke a rule". Keep both on the page; do not build a violations wall.
- **No actor, author, email, or session-owner field may enter `DigestData`.** `get_digest_data`
  hands that payload to an agent verbatim, so anti-surveillance holds because the person data is
  absent, not because a prompt asks for restraint. A test asserts the serialized payload contains
  none of those words — if you make it fail, the fix is removing the field, not the assertion.
- Free text quoted into a fact comes only from an already-approved canonical entity's title or
  summary. Never from a prompt, a transcript, or raw tool input.

## 5. Prose is local, regenerable, and outside the approval gate

`digest_issues` is local index state. Its inputs are excluded from canonical, so prose narrating
them is not reconstructible from the committed files — writing it into `.iroha/` would break the
reconstructability charter. And it needs no approval gate: a Digest asserts no new team truth, so
it sits *outside* the candidate→approve→canonical boundary rather than bypassing it.

Losing prose on `sync --rebuild` is correct, not a gap — rerun `/iroha:digest`.

Do not add a `digest` candidate, entity, or knowledge type. That was considered and rejected: three
CHECK-constraint migrations, a canonical directory, a body template, a `$defs` entry, a Zod mirror,
and contract fixtures, all for a newsletter.

## Related

- Full contract, including the eligibility of each fact and what is out of scope:
  `docs/contracts/database.md` §16.
- Hook budgets and why the hook path writes nothing: `docs/contracts/hooks.md` §10.
- The two MCP tools: `docs/contracts/mcp.md` §6.9–6.10.
- ADR-016 (the prose composer is the developer's own agent session; iroha calls no external LLM):
  `docs/architecture.md`.
- Chart/CSP constraints if the page gains a chart: [[dashboard-shadcn-and-csp]].
- Visual identity for the editorial layout: [[brand-and-design]].
