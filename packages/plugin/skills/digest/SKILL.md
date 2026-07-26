---
name: digest
description: Compose the editorial prose for the current iroha Digest period — the dashboard's front page. Use when the user asks to write, refresh, or regenerate the Digest (weekly or monthly). Do not use to look up knowledge or to report on a person; the Digest is aggregate and agent-and-rule-focused.
---

# Compose an iroha Digest issue

The Digest is the dashboard's front page: a per-period read on how the agent and the ruleset are doing. iroha computes every number; you write only the sentences.

Do NOT run a CLI command. Use the two iroha MCP tools.

## 1. Read the period's facts

Call **`get_digest_data`** (optionally `unit: "week" | "month"` and `offset` for a back issue; the defaults are the developer's stored window and the current period).

It returns aggregates for the period, the same numbers for the previous period, any correlations iroha found, and a `facts` array — each entry an `id`, its `value`, and an English `label`.

## 2. Write the issue

Call **`save_digest_prose`**. The arguments are exactly:

```jsonc
{
  "sessionToken": "ist_…",        // from your session context
  "periodUnit": "week",           // copied from get_digest_data's `period`
  "periodKey": "2026-07-20",      // copied from get_digest_data's `period`
  "prose": {                      // the composition is nested here, not top-level
    "headline": "…",              // the issue's one-line lede
    "standfirst": "…",            // one sentence framing the period
    "sections": [                 // one to four, one per slot
      { "slot": "stumbles", "heading": "…", "body": "…" }
    ]
  }
}
```

`slot` is one of `stumbles`, `codebase`, `wins`, `teaching`, and **each may appear once**.

`periodUnit`/`periodKey` are how the issue is filed. Do not guess them and do not carry them over from an earlier call: if they name a different period than the one you read, the narrative lands on the wrong issue with that period's numbers substituted into it.

## The one rule about numbers

**You have no field to put a number in.** To state a figure, reference a fact id as `{{factId}}` and iroha substitutes its own value when the page renders:

```text
headline: "{{local.denials.total}} edits the Guardrails caught"
```

Referencing an id this period did not issue is rejected. The response does not list which ones, so compare your references against the `facts` array you were given and fix them there. Do not type a digit you read out of `get_digest_data`; reference the fact instead, so the page can never show a number that drifted from the data.

A cluster is referenced by the area it covers, not by its position in the list — `{{local.correlations.packages/git.count}}`, never `{{local.correlations.0.count}}`. The ranking moves as denials land; the area does not.

One section per slot. Two sections claiming the same slot is rejected.

**Do not type a number as digits anywhere.** `There were 999 denials` is rejected outright — not because the figure is wrong, but because a typed figure bypasses the mechanism that guarantees the page only shows iroha's own values. Write `{{local.denials.total}}` and let the renderer supply it. Digits inside an identifier, a version, or a date (`ADR-016`, `2026-07-20`, `v2`) are fine.

## What makes a good issue

- **Narrate a correlation iroha already found**, never one you inferred. `correlations` is the list you may draw a line through; anything else is speculation.
- **Balance the stumbles with the wins.** A Guardrail that fired is the setup working, not a failure. A Guardrail that *cannot* be enforced (`rulesetAdequacy.not_hook_enforceable`, `.invalid`) is a genuine finding worth a section — the setup failed the agent.
- **Teach something small** in the `teaching` slot: what a promoted review lesson actually says, why a rule exists.
- **Say when a period was quiet.** Do not manufacture significance from zero, and do not call a period quiet when the denial count says otherwise — the numbers render as authoritative next to your text, and the page labels your prose unreviewed.
- **No score.** There is no honest overall adherence percentage: most advisory rules leave no machine-observable trace. Do not invent one, and do not imply one.

## Never

- **Never write about a person.** No individual, no attribution of work, no ranking. The payload contains no actor or author field for exactly this reason; do not reintroduce one from your own session context.
- **Never quote a prompt, transcript, tool payload, secret, or absolute path.** Free text you quote must come from what `get_digest_data` returned.
- **Never assume a save was lossless.** If the response carries `redactions`, the scanner found
  something secret-shaped and replaced those *entire* fields. Rewrite them without the offending
  text and save again — do not report success to the user as-is.
- **Never present the Digest as approved team knowledge.** It is a local, regenerable view, never committed to Git. Durable lessons go through `propose_knowledge` and human approval instead.
