---
name: iroha-review
description: |
  iroha専用のプロジェクト全体セルフレビュー。コミット済みの変更(デフォルト、mainとのmerge-base以降)を対象に、決定的チェック(lint/typecheck/test/build/secret grep)→fresh-contextの複数レビュアー(security-reviewer / spec-compliance-reviewer / adversarial-reviewer)並列起動→HIGH/CRITICAL findingをfinding-validatorで再現検証、という多段パイプラインでレビューする。PRの有無に関わらずいつでも呼べる。作業ツリーに未コミットの変更がある場合はAskUserQuestionで含めるか確認する。副作用ゼロ(コミット・push・状態書き込みをしない)、fail-open(このスキル自体はmergeをブロックしない、所見を報告するだけ)。"セルフレビューして"「レビューして」「/iroha-review」で起動。packages/git等のセキュリティ重視パッケージに絞った既存の `self-review` スキル(push直前・4パターンの回帰チェック特化)とは別物 — このスキルはリポジトリ全体・任意タイミング用。
user-invocable: true
allowed-tools: Bash(git rev-parse *) Bash(git symbolic-ref *) Bash(git show-ref *) Bash(git merge-base *) Bash(git diff *) Bash(git status *) Bash(pnpm lint) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm build) Bash(grep *) Read Grep Glob AskUserQuestion Agent(security-reviewer) Agent(spec-compliance-reviewer) Agent(adversarial-reviewer) Agent(finding-validator) ReportFindings
---

# iroha-review — プロジェクト全体セルフレビュー

`self-review`(packages/git等、push直前限定)より広く、iroha monorepo全体を対象に、いつでも呼べるレビューパイプライン。2026年7月時点の知見(specialist agentごとの独立レビュー→per-finding adjudicationによる誤検知抑制が最有効)と、`~/.claude/rules/code-review-triage.md`(再現による検証)を踏まえて設計している。

## 方針

- **対象はデフォルトでコミット済みの変更のみ**。未コミットの変更があれば必ずユーザーに確認する(勝手に含めない/勝手に除外しない)。
- **副作用ゼロ**。`.mumei`のような状態ファイルを作らず、コミットもpushもしない。所見を報告して終わる。
- **fail-open**。このスキル自体が「マージしてよいか」を判定するものではない。所見のseverityと検証結果を提示し、対応するかどうかはユーザーが決める。
- **fresh-context原則**。各レビュアーAgentは今回の会話の文脈(なぜこの変更をしたか)を持たない状態で呼ぶ。同じ文脈でレビューすると確証バイアスがかかるため(`.claude/agents/security-diff-reviewer.md`と同じ理由)。
- 自動修正はしない。所見を報告した後、直すかどうか・どう直すかはユーザーの指示を待つ。

## Step 1 — 対象diffを確定する

```bash
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository"; exit 0; }

base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
if [ -z "$base" ]; then
  git show-ref --verify --quiet refs/heads/main && base="main"
fi
if [ -z "$base" ]; then
  git show-ref --verify --quiet refs/heads/master && base="master"
fi
if [ -z "$base" ]; then
  echo "base refを解決できません。mainまたはmasterブランチが必要です。"
  exit 0
fi

merge_base="$(git merge-base "$base" HEAD 2>/dev/null)"
committed_files="$(git diff --name-only "$merge_base"..HEAD)"
uncommitted_status="$(git status --porcelain)"
```

- `committed_files` が空なら「`$base` との差分なし、レビュー対象がありません」と報告して終了する。
- `uncommitted_status` が非空なら、**AskUserQuestion** で確認する:「コミットしていない変更(一覧を提示)もレビュー対象に含めますか?」
  - 含める→対象diffは `git diff "$merge_base"` (working tree込み、two-dotではなくone-dot)
  - 含めない→対象diffは `git diff "$merge_base"..HEAD` (コミット済みのみ)
- 変更ファイル一覧と対象diffのサイズ(行数)を最初に報告し、レビューのスコープを明示する。

## Step 2 — 決定的チェック(ground truth、LLM判断不要)

対象範囲に応じて、リポジトリルートから実行する(`CLAUDE.md`の「Required verification for every change」と同じスイート):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

いずれかが失敗したら、それ自体を**確定した(検証不要な)finding**として扱う — 失敗したコマンドの出力をそのまま所見に含める。これは推測ではなく実行結果なので、finding-validatorでの再検証は不要。

追加で、変更ファイルに対して軽量なsecretパターンgrepを実行する(専用スキャナは前提にしない):

```bash
grep -nE "AKIA[0-9A-Z]{16}|gh[ps]_[A-Za-z0-9]{36,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|(api[_-]?key|secret|password|token)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}[\"']" $(echo "$committed_files")
```

マッチがあれば確定findingとして扱う(誤検知もあり得るので、ヒットした行を提示しユーザー/後続レビュアーが判断できるようにする)。

## Step 3 — レビュアーを並列起動(fresh context)

各レビュアーには **diffそのものと変更ファイルパスのみ**を渡す。なぜこの変更をしたか、どんな会話があったかは渡さない(fresh-context原則)。

```text
Agent(security-reviewer, prompt: "<diff> <changed files>")
Agent(spec-compliance-reviewer, prompt: "<diff> <changed files>")
Agent(adversarial-reviewer, prompt: "<diff> <changed files>")
```

3体は独立した観点(セキュリティ / 仕様・invariant準拠 / 正当性・edge case)なので、並列に起動してよい(1メッセージで3つのAgent呼び出し)。

## Step 4 — HIGH/CRITICAL findingの検証(adjudication)

Step 3で集めたcandidate findingのうち、severityがHIGH/CRITICALのものは1件ずつ `finding-validator` に独立検証させる。MEDIUM/LOW はスキップしてよい(2026年時点のプラクティスでも、全件検証は費用対効果が低く、severityの高いものに絞るのが標準)。

```text
Agent(finding-validator, prompt: "<finding 1件分: file, line, failure scenario>")
```

`finding-validator` の判定:
- `valid` → `ReportFindings` に `verdict: CONFIRMED` で含める
- `invalid` → 落とす(理由を最終報告の「除外した所見」に一言残す — cyclic false positiveの再発防止のため)
- `unsure` → `verdict: PLAUSIBLE` で含め、「検証できなかった」ことを明記する

MEDIUM/LOWで検証をスキップしたものは `verdict` を付けずに(またはPLAUSIBLEとして)含める。

## Step 5 — 報告

`ReportFindings` ツールを1回呼び、severityが高い順に整列した最終所見リストを渡す(空配列なら「所見なし」)。`level` は複数エージェント+検証パスを回しているため通常 `"high"`。

`ReportFindings` の出力に加えて、会話内で以下を明示する:

1. レビュー対象(コミット済みのみ/未コミット込み、diff行数、base ref)。
2. Step 2の決定的チェック結果(全部通ったか、何が落ちたか)。
3. **カバーされていない範囲**(例: 「Windows固有の挙動はこの環境では検証できていない」「semgrep/osv-scanner等の専用ツールは未導入のため、パターンgrepのみ」)。分からないことを分かったふりで済ませない(`~/.claude/CLAUDE.md`の評価誠実性原則)。
4. このスキルは何も変更していないこと(コミットなし、push なし)。

## やらないこと

- コミット・push・PR作成はしない。
- `.mumei`のような状態ファイルを作らない。
- 所見を自動修正しない(次のアクションはユーザーの指示を待つ)。
- severityの高い所見を検証なしで確定扱いにしない(Step 4は必須、スキップしない)。
- 何も見つからなかった時に、それらしい所見を作らない(空配列を正直に報告する)。

## トラブルシューティング

- **「not a git repository」で終了する** — カレントディレクトリがgit管理下にない。irohaリポジトリのルート(または配下)で実行する。
- **「base refを解決できません」で終了する** — `origin/HEAD`・`main`・`master`のいずれも見つからない。ローカルにmainブランチを作るか、`git remote set-head origin -a`でorigin/HEADを設定してから再実行する。
- **「差分なし」で即終了する** — 現在のHEADがbase ref(通常main)と同じか、それより古い。レビューしたい変更が別ブランチ/未push状態でコミットされているか確認する。
- **decision-log.mdやschemas/との食い違いをspec-compliance-reviewerが指摘したが、どちらが正しいか分からない** — 勝手にどちらかを採用せず、矛盾の内容をそのままユーザーに提示する(`~/.claude/rules/investigate-before-asking.md`)。
- **finding-validatorが`unsure`を連発する** — 検証に必要なツール(特定OS依存の挙動、外部サービスへのアクセス等)がこの環境にない可能性が高い。`unsure`のまま報告し、どのツール/環境があれば検証できるかを併記する。

## 使用例

呼び出し: 「セルフレビューして」「/iroha-review」「このブランチの変更をレビューして」

典型的な出力の骨格:

```
対象: main との merge-base 以降のコミット済み変更(未コミットの変更2件は含めるか確認 → 含めない選択)
diff: 8 files changed, +640/-12

Step 2 決定的チェック: lint OK / typecheck OK / test OK(83 passed) / build OK / secretパターン: 検出なし

[ReportFindings の出力: 所見1件(MEDIUM, verdict: CONFIRMED) または「所見なし」]

カバーされていない範囲: Windows固有の改行/パス挙動はこの環境(macOS)では検証していません。

このスキルは何も変更していません(コミット・push なし)。
```
