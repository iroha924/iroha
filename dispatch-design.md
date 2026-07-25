# The iroha Dispatch — design

> Status: **design agreed, not yet implemented.** This document is the full design record for a proposed feature. It was produced by an adversarial design debate (a proposal + a skeptical reviewer) and reflects the converged outcome, including every constraint that shaped it. The tracking issue is a summary; this is the authoritative detail.

## 1. Vision

Make the iroha dashboard's **TOP page an editorial "newspaper/magazine" issue**, not a plain metrics dashboard: a per-period (default 1 week, configurable) digest of the codebase's rule-adherence, stumbles, learnings, and wins that is **enjoyable to read and educational** — something a human *wants* to open. Rich presentation is welcome, but **no money is spent** (no paid API), and **as much as possible the composition/saving happens in the background on the Claude Code side, while the dashboard just renders it beautifully.**

## 2. Core principle: the Dispatch is a **local, regenerable period view with zero canonical footprint**

The newspaper is never committed to git and is never "approved knowledge." Reasoning (this is load-bearing, not taste):

- Its headline facts come from `tool_events` / `event_log`, which are **non-canonical, disposable local index state** — `canonical-schema.md` §2 explicitly excludes tool inputs/outputs and transcripts from canonical, and a `sync --rebuild` wipes them. Pushing a view of that data into git-tracked `.iroha/**` would smuggle a **non-reconstructable** artifact into a store whose §1 charter is "everything here is reconstructible from these files + Git."
- **No approval gate.** Approval exists to promote *new team truth* into the trust boundary. A digest asserts no new truth — it is a view over already-recorded facts and already-approved knowledge. It is therefore simply *outside* the candidate→approve→canonical boundary. Dropping the gate is correct, not a loophole. (The one thing approval stood in for — unreviewed LLM prose reaching a human — is handled by the fact-ID seam §5 and an "unreviewed" label, not by a git commit.)

A new `dispatch` candidate/canonical type was explicitly **rejected**: it would add three CHECK-constraint migrations (`candidates.candidate_type`, `entities.entity_type`, `knowledge_items.knowledge_type`), a new canonical directory + body-template + `$defs` + Zod mirror + contract fixtures, and would force `approveCandidate`'s secret-scan/template validation to be loosened for a non-knowledge type — a large concept-count hit (KISS/YAGNI violation) for a newsletter.

## 3. Two scopes

**Membership test** (keeps facts from drifting between scopes): *a fact belongs to the **team** scope iff it is identical for every teammate who regenerates from the same `.iroha/**` at the same git HEAD; otherwise it is **local**.*

- **Local scope — "How my sessions went"** (from this developer's local `event_log` / `tool_events` / `checkpoints`; never shared):
  - my guardrail denials, attributed to the rule that fired;
  - my checkpoint outcomes;
  - iroha-computed correlations (see §5);
  - an "you might be missing a rule" hint from **unpromoted** recurring review feedback (caveated as *derived from your local forge sync*, because `review_comments` are per-clone and depend on who ran `iroha sync`).
- **Team scope — "This week in the codebase"** (from **canonical + git only**, so every teammate regenerates the *same facts* locally — no committed newsletter):
  - approved-knowledge-by-type counts for the period;
  - guardrail **ruleset** changes (which `knowledge_items` have `enforcement='guardrail'` and what changed);
  - **promoted** `review_learning`s;
  - knowledge-growth deltas.

**Honest correction (differs slightly from the initial intuition of "see team-wide stumbles"):** a raw *team-wide guardrail-denial tally is uncollectable in v0.1* — denials live only in each developer's local index and there is no shared telemetry store (that would require the forbidden daemon / telemetry upload). So "where Claude stumbles **across the team**" is answerable only through the **systemic** lens: review-recurrence + ruleset-adequacy (canonical, shareable). Raw denials are a **local**-scope signal ("how *my* sessions went"). Both are honest; they answer different questions.

## 4. The team-newspaper decision (owner's call, resolved)

Team facts are identical for all, but prose is composed per clone, so two teammates' team-newspaper *text* would differ. The owner chose: **identical facts + locally-flavored prose. The newspaper text is never committed to git (zero footprint); each developer's Claude composes the prose locally from the same shared facts.** This keeps all the invariant-cleanliness of §2 — no LLM-authored text ever enters git — and gives each developer a fresh read. (The rejected alternative — one committed identical editorial text — would have re-opened the canonical/git tension for the prose specifically.)

## 5. Numbers vs prose — the fact-ID seam

- **iroha computes the numbers *and* pre-computed correlations deterministically.** The correlation is the editorial connective tissue, e.g. `{kind: 'denial_cluster', paths: ['packages/git'], count}` intersected with a review recurrence on the same paths → a candidate-rule link. The agent must **narrate a correlation iroha already found**, never invent the link.
- **Claude Code composes only the prose, bound to iroha-issued fact-IDs.** `get_dispatch_data` hands the agent fact-IDs with values; the agent returns prose referencing those IDs; the **renderer interpolates iroha's numbers**, never the agent's. The agent literally has no number slot to get wrong.
- **iroha never calls an external LLM.** The composer is the developer's own Claude Code session (their existing subscription), at design time. This respects the "no external LLM call without a new ADR" invariant and costs nothing. Record this non-violation explicitly (a short ADR) so a reviewer doesn't misread "iroha generates editorial prose."
- **Residual, accepted:** the seam prevents *fabricated* numbers but cannot stop prose that *contradicts* correct numbers ("a quiet week" over a denial spike) — inherent to LLM narration, unfixable by architecture. Mitigation: numbers self-render as authoritative; prose is visibly marked **"auto-composed, unreviewed."**
- **No single "compliance %".** Prior research established there is no honest total adherence score: the majority of `.claude/rules/*.md` are prose with no machine-observable footprint. The Dispatch presents **three separately-sourced facts** — enforceable-stumbles, ruleset-adequacy, review-recurrence — and never manufactures a blended score.

## 6. Trigger (no daemon)

The Hono dashboard server cannot make Claude Code write prose, so composition only happens inside a Claude Code session. Reframed honestly (and it gets better):

- **Numbers are always current** — computed on page load from the DB (like `getOverview`, but period-windowed). The TOP page is numerically live regardless of whether any agent ran.
- **Prose is opportunistic** — a human-run `/iroha:dispatch` skill composes it on demand. `/loop` is the owner's personal cadence, **not** a shipped "weekly" promise.
- **The degraded state is first-class** — if there is no prose row for a `(scope, period)`, render iroha's numbers with **template copy** (a headline templated from the facts). The newspaper is **never blank**. (Mirrors the repo's own "embedding failure degrades to lexical search" invariant.)

## 7. Storage

- **Local `dispatch_issues` table** (forward migration `002_*.sql`; a local *index* schema, not canonical): roughly `(repository_id, scope, period_start, period_end, prose_json, composed_at)`. Disposable, regenerable, never git.
- Prose is run through the existing `redactProposal`-style **secret scan before storing** (at-rest defense-in-depth per `secure-subprocess-and-credentials.md`), even though the aggregates-only input should carry no secrets.
- **Period preference lives in the local `local_settings` table** (`migrations/001_initial.sql`), key `dispatch.period` — **never `config.yaml`**, which rejects unknown keys and is git-shared canonical (`canonical-schema.md` §9 mandates local overrides go git-internal). A per-developer window preference does **not** break team-scope "identical-for-all" — that property is about the *facts given a window*, not about everyone choosing the same window.

## 8. Anti-surveillance — enforced at the schema level, not just intended

This feature sits on a product red line encoded in six places (`background.md` §7.8, `requirements.md` FR-107/FR-108, `design.md` ADR-012/ADR-014, `dashboard-api.md` §6, `CLAUDE.md`). Enforcement is structural:

- The `get_dispatch_data` payload has **no field named or typed as actor / user / author / email / session-owner** anywhere. The agent physically never receives person data, so it *cannot* narrate per-person even if asked.
- Any **free text quoted into a fact comes only from already-approved canonical entities** (a rule's title, a review-learning's generalized lesson) — never from raw tool input / prompt / transcript. The "no raw content" invariant holds even in the prose *input*.
- `save_dispatch_prose` is validated to reference **only issued fact-IDs**, and is stored redacted.
- Aggregate and **agent-and-rule-focused**, never per-person; no leaderboard. Reframe the metric symmetrically: "the setup failed the agent" (surface `not_hook_enforceable` / `invalid` guardrails and constantly-firing rules as **ruleset adequacy**) is as much the story as "the agent broke a rule." Balance wins and stumbles; avoid a red "violations wall."

## 9. `get_dispatch_data(scope, period)` — aggregates-only fact shape

Local (this developer's DB, windowed by local `occurred_at`):

- `local.stumbles.byRule[]` = `{ ruleId, ruleTitle, count }` (title from the approved canonical rule)
- `local.checkpoints.byOutcome` = `{ completed, partial, blocked, no_change }`
- `local.sessions.count` (raw count, no actor)
- `local.correlations[]` = e.g. `{ kind: 'denial_cluster', paths: [...], count }`
- `local.rulesetHints[]` = unpromoted-recurrence "you might be missing a rule", caveated local-forge-derived

Team (canonical + git, windowed by `approved_at` / commit time → identical for all):

- `team.knowledge.approvedInPeriod.byType` = counts across the 7 canonical types
- `team.rules.guardrailsChanged[]` = `{ ruleId, title }`
- `team.reviewLearnings.promoted[]` = `{ id, title, generalizedLearning }`
- `team.knowledge.growthByType` = `{ value, priorValue, delta }` (prior window computed on demand from timestamps — **no snapshot table**; local trends reset on `sync --rebuild`, which is surfaced)

Period semantics: **anchored calendar periods, not a rolling window** (back-issues need a stable identity, e.g. "week of 2026-07-20"); default 1 week, configurable. Boundaries computed in the user's local timezone, queried as UTC instants (`dashboard-api.md` §8: values UTC, display local).

## 10. Phasing

- **Phase 0 — the substance (ships standalone, usable on its own):**
  - **Prerequisite: denial→rule attribution.** Start populating the currently-unused `event_log` on a guardrail denial (`event_type='guardrail_denied'`, `error_code=<ruleId>`) — **no migration needed** (`event_log` already has the columns; it is the natural home the prior research identified). Without this the local hero metric is an unattributed count with no lesson.
  - Period-windowed deterministic read model: `GET /api/v1/dispatch?scope=&period=`, extending `overview.ts`/`getOverviewCounts` (today cumulative) over `event_log`/`tool_events` denials, `candidates.created_at`, review recurrence (`forge-review-learning.ts` is the exact deterministic-recurrence template to reuse), dirty markers, knowledge growth.
  - Editorial TOP page with brand typography, **template copy**, always-current numbers, and the degraded state. This alone is "fun + educational" at ~10% of the risk and is independently useful analytics.
- **Phase 1 — trends** vs the prior period (computed on demand from `occurred_at`; no snapshot table; trends reset on rebuild, surfaced).
- **Phase 2 — the editorial prose (the owner's explicit goal; sequenced after the number base for correctness, not "optional polish"):** `get_dispatch_data` (aggregates only) → `/iroha:dispatch` skill → agent prose bound to fact-IDs → `save_dispatch_prose` → local `dispatch_issues`. Correlations (§5) enable connective-tissue prose. Sequencing is a **correctness dependency**: the fact-ID seam and numbers-authoritative rendering only work if the number-owning deterministic base already exists.
- No later ADR is required for an external LLM — there is none.

## 11. Dashboard rendering (~80% reuse; brand-editorial)

- **New TOP "Dispatch" page**: masthead + editorial eyebrow + a `sumi`-ink top rule + display-face headings + the three-circle motif as section markers + sparkline trends + a **back-issues archive**.
- Sections: a hero, "This week's stumbles" (local) / "This week in the codebase" (team), new advice candidates, wins, and short "did you know" teaching callouts.
- **CSP**: charts use `<Cell fill="var(--chart-N)">` with a color-less `ChartConfig` so shadcn's `ChartStyle` injects no `<style>` (strict `style-src 'self'`); any new chart type must be verified by the e2e CSP test, not just unit tests (`dashboard-shadcn-and-csp.md`). Brand: matcha for the positive/approve axis, persimmon for danger — but tonal, never a blame wall.
- **API**: one new aggregate read endpoint (`GET /api/v1/dispatch`); the advice-candidate queue reuses the existing `GET /api/v1/candidates` + `ReviewQueue`/`ReviewDetail` UI unchanged.

## 12. Reuse vs new

- **Reuse:** the candidate→approve→canonical spine (for the *lessons* — durable advice files through the existing `insight`/`review_learning` path, which is person-less and already canonical), the Review Queue UI, `get_active_rules`/guardrail enforcement (the loop back into the agent), the `overview.ts` read pattern, the `forge-review-learning.ts` recurrence template, and the brand tokens.
- **New:** `event_log` activation for adherence events + denial rule-attribution; the period-windowed dispatch read model + `GET /api/v1/dispatch`; the local `dispatch_issues` table (migration 002); the `get_dispatch_data` / `save_dispatch_prose` MCP tools (with the aggregates-only + fact-ID Zod constraints); the `/iroha:dispatch` skill; the Dispatch TOP page.

## 13. Honest limits and risks

- **Advisory-prose adherence is not machine-measurable** — the majority of `.claude/rules/*.md` (think-before-coding, diminishing-returns, KISS, …) have no observable metadata footprint. Show "N/A — not machine-observable", never a fabricated score.
- **Team-wide raw stumbles are uncollectable** without a daemon/upload (forbidden) → the team scope shows systemic canonical signals only.
- **Agent prose quality varies and can contradict the numbers** → numbers authoritative + an "unreviewed" label.
- **Trends reset on `sync --rebuild`** (disposable history) → surfaced.
- **"Missing rules" is team-identical only for *promoted* learnings**; the unpromoted-recurrence hint is local (per-clone forge state).

## 14. Prior art (validates the direction)

- **arXiv 2607.13091** ("Self-Improving AI Coding Agents Through Accumulated Behavioral Rules") is essentially iroha's `detectReviewLearnings` + candidate-approve loop described academically — and it explicitly **lacks an operational dashboard**, the exact gap the Dispatch fills.
- **agentlytics** (github.com/f/agentlytics) is a local-first agent-analytics dashboard, but tracks usage/cost/streaks — not rule adherence, guardrails, or advice (and ships the gamified "streaks" that iroha's NFR-008 forbids).
- Enterprise governance tools (Galileo, Maxim, Braintrust, Bedrock Guardrails, knostic) are cloud-hosted, manager-facing, inference-layer — the opposite of iroha's local-first + git-shared-lessons + candidate-approve + agent-focused model.
- **iroha's differentiated position:** local-first + git-shared *lessons* (never the newsletter) + candidate-approve (advice is never auto-applied) + agent-and-rule-focused (not surveillance) + closes the loop back into its own `.iroha/` rules and hook enforcement. No surveyed tool combines these.

## 15. Related iroha work

- Depends on / pairs with the compliance-measurement work in issue **#122** (wire up `event_log`) — the Dispatch is the editorial *presentation* layer over that data foundation; the denial→rule attribution in §10 Phase 0 is shared with it.
- Uses the deterministic-recurrence advice pattern from `detectReviewLearnings` (WP-12).
