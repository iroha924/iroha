# Japanese prose: read it back before you save it

`distributable-language.md` decides *which* language a record is written in. This decides whether the
Japanese you wrote is actually Japanese.

Before calling `create_checkpoint` or `propose_knowledge` with Japanese content, re-read every
Japanese field you drafted — `summary`, `objective`, `unresolved[]`, `implementation[].change`,
`validation[].note`, and a proposal's `title`/`summary`/`body` — and fix what the checks below catch.
Do this as a separate pass, not while composing.

## Why a re-read, and not a validator

A generated non-word survives because it was never looked at, not because the word was unknown.
Reading and generating are different operations: shown `拑張` and asked "is this a word?", the answer
is no; the defect was that nothing asked.

No deterministic check substitutes for this. A rare-kanji filter is the obvious idea and it fails:
one session produced both `拑張` and `拘張` for the same intended `抑制`, and `拘` is jōyō, so the
filter passes half the same error. A morphological dictionary catches both non-words but nothing in
the calque and collocation classes below, which are the larger share.

## What to look for

- **Words that do not exist.** Wrong-kanji substitution inside a 漢語 compound is the failure mode:
  `拑張` / `拘張` where `抑制` was meant. Suspect any compound you reached for rather than knew.
- **Calques of an English phrase.** `権威ある確認` is "authoritative confirmation" transliterated, not
  Japanese; `実測で確定させた` says it. Ask whether a Japanese speaker would say the phrase, not
  whether it maps cleanly back to English.
- **Fragments that are neither language.** `completed クローズした` is not a clause. A bare English
  participle cannot take `した`.
- **Common words used wrongly.** `束ねる実利は3点` (`実利` → `利点`); `抑制を取り下げる` (a suppression
  entry is `外す` or `解除する`; `取り下げる` is for an application or a claim).
- **Noun pileups.** `一過性 CI インフラ flake` stacks four nouns with no particle. Break it into a
  clause.

## The habit that prevents most of it

Do not coin a 漢語 compound for a concept the surrounding text already names in English. When the
subject is `IgnoredVulns` or an `override`, write `ignore エントリ` or `override` — reaching for an
invented 熟語 is what puts a wrong kanji in reach. Katakana and the bare English term are both
correct here; a coined compound is the only option that can be wrong.

## Why this cannot wait for dashboard review

Only `proposals[]` becomes a candidate a human approves. A checkpoint's `summary` and `unresolved[]`
are stored with no review step at all, and both reach a later session's agent: `get_session_state`
returns the last Checkpoint's `summary` and `unresolved`, and `get_context` returns its `unresolved`.
Prose that is wrong there propagates without anyone seeing it, so the only place to catch it is
before the write.

## Related

- Which language a given record uses: [[distributable-language]].
- Terseness applies to these fields too: `~/.claude/CLAUDE.md`「出力の量」.
