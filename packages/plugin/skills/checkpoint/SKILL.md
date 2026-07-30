---
name: checkpoint
description: Save a structured Checkpoint of the current work as a local iroha candidate for later human approval. Use after a meaningful unit of work — a decision reached, a bug fixed, a reusable rule or pattern discovered. Do not use for trivial edits, and never treat a Checkpoint as approved knowledge (a human approves candidates in the dashboard).
---

# Save an iroha Checkpoint

Do NOT run a CLI command for this. Call the iroha MCP tool **`create_checkpoint`** exposed by the `iroha` MCP server. Provide:

- **intent** — what this unit of work was trying to achieve;
- **changes** — what actually changed (files, behavior);
- **decisions** — choices made and why, with alternatives considered;
- **unresolved** — open questions or follow-ups;
- **proposals** — reusable knowledge (decisions, rules, patterns) worth keeping.

A Checkpoint becomes a **local, pending candidate** — it is never authoritative and is excluded from retrieval until a human approves it in the iroha dashboard. Do not write raw prompts, transcripts, secrets, or credentials into a Checkpoint.

## Final check on the prose — required, and worth real effort

Write the content in the repository's `config.default_language`, then check it **before** you call the tool. You are the only check there is: of everything a Checkpoint stores, only `proposals` reaches a human, while `summary` and `unresolved` are kept as written and read back into a later session. Nothing downstream can catch prose that a native speaker would not write, and no check iroha could ship would either — deciding whether a phrase is idiomatic is not something a dictionary or a pattern set does.

Spend the effort here. Do **five separate reads, one lens each**, on every free-text field. A single combined skim does not work: while you are looking for one class you are blind to the others, and every class below has been shipped into a real Checkpoint by an agent that believed it had proofread.

1. **Does each word exist?** Check every 漢語 compound you *reached for* rather than knew. Wrong-kanji substitution produces a plausible-looking non-word, and it is invisible while composing.
2. **Is it Japanese, or English wearing Japanese?** If a sentence maps suspiciously one-to-one onto an English sentence, it is a calque. Rewrite from the meaning, not from the English.
3. **Would a person say it?** Read for collocation, particles, and rhythm — whether the verb actually takes that object, whether the sentence can be spoken. This is the lens that catches what the first two miss.
4. **Is the terminology the established one?** An invented compound where the surrounding text already has a name for the thing is the single largest source of the defects above.
5. **Is anything padding?** Stacked nouns, nominalization, and restating the previous sentence all read as machine output even when every word is correct.

Each class below is a real defect that reached a stored Checkpoint, with the wording it should have had:

| Lens | Written | Should be |
|---|---|---|
| 1 Non-word from a wrong kanji | `拑張` / `拘張` | `抑制` |
| 2 English phrasing calqued into Japanese | `権威ある確認` | `実測で確定させた` |
| 2 Fragment that is neither language | `completed クローズした` | `完了としてクローズした` |
| 3 Common word used wrongly | `束ねる実利は3点` | `束ねる利点は3点` |
| 3 Collocation that does not hold | `抑制を取り下げる` | `抑制を外す` |
| 5 Nouns stacked with no particle | `一過性 CI インフラ flake` | `CI インフラ由来の一過性の失敗` |

The habit that prevents most of it: **do not coin a 漢語 compound for something the surrounding text already names in English.** When the subject is `IgnoredVulns` or an `override`, write `ignore エントリ` or `override`. Katakana and the bare English term are both correct; an invented compound is the only option that can be wrong.
