---
name: self-review
description: Runs a structured self-review before pushing changes to security-sensitive TypeScript code in this monorepo (packages/git and similar packages doing subprocess execution, credential/secret handling, or path/symlink validation). Catches regressions where a narrow fix for one reported bug leaves the same defect class at a sibling call site, silently trades one false-negative for another, violates an invariant the code itself just declared in the same sitting, or drops platform-specific behavior when replacing an OS-native function with hand-rolled logic. Use before every `git push` touching these packages, not only after a review-bot finding. Do not use for general bug fixes outside packages/git, packages/forge*, packages/adapter-* — those aren't in this project's security-sensitive scope.
paths:
  - "packages/git/src/**/*.ts"
  - "packages/forge*/src/**/*.ts"
  - "packages/adapter-*/src/**/*.ts"
user-invocable: true
allowed-tools: Bash(grep *) Bash(pnpm lint) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm build) Agent(security-diff-reviewer)
---

# Self-review before push

このスキルは「報告された1件を直して終わり」を防ぐためのものです。反復的な修正がセキュリティを悪化させ得ることは実証研究([Security Degradation in Iterative AI Code Generation](https://arxiv.org/pdf/2506.11022), arXiv 2506.11022)でも指摘されています。原因は主に (a) ローカル最適化(1件を直すと別の場所に新しい弱点を生む)、(b) 網羅的な脅威モデリング不足です。各修正を「リスクを減らす行為」ではなく「新しいリスクを生みうる行為」として扱ってください。

以下のステップを**変更内容に応じて該当するものだけ**、pushの直前に実行してください。全ステップが常に必要なわけではありません。

## Step 1 — 変更の性質を1文で書く

「何を」「なぜ」直したかを1文で明示する。次のステップの判断基準になる。
例: 「`redactUrlLikeCredentials` の区切り文字にカンマを追加し、隣接する2つのURLが1つのマッチとして扱われる問題を直した」

## Step 2 — "これは何を新たに通すようになったか?" を問う

パターンマッチ/正規表現/除外セットを変更したら、**直した誤検知(false negative)を確認するだけでは不十分**。同じ変更が生む**新しい**false negativeを最低2〜3個、自分で考えて試す。

- 除外文字を追加した → その文字が「区切り」ではなく「正当な値の一部」として現れるケースを書いて確認したか?
- 判定条件を緩めた/厳しくした → 逆方向の入力(緩めたなら通したくない入力、厳しくしたなら通したい入力)を最低1つテストしたか?

これは「fixを検証する」のではなく「fixが何を犠牲にしたか」を能動的に探す作業です。

## Step 3 — 同じヘルパー/プリミティブの全呼び出し箇所を横断確認する

1箇所を直したら、**そのファイルだけでなくパッケージ全体**で同じヘルパーの他の使用箇所を確認する(「ローカル最適化」がグローバルな弱点を生む主因)。

```bash
# 変更した関数/正規表現/ヘルパーの全呼び出し箇所を洗い出す
grep -rn "<変更した関数名>(" src/*.ts | grep -v "\.test\.ts"
```

「厳格版」と「緩い版」の2つの関数が併存している場合、**外部呼び出し箇所が全て厳格版を使っているか**を必ず確認する。

## Step 4 — 自分が書いた不変条件(invariant)への違反を横断チェックする

docstring/コメントで「Xは絶対に使わない、なぜならY」と書いたら、**同じコミットの中で**同じファイル・同じ関数の別分岐でXを使っていないか、必ずgrepで確認する。

```bash
# 例: 「path.resolve/path.join は .. を畳むので使わない」と宣言したファイルで
grep -n "resolve(\|\.join(\|path\.join\|path\.resolve" <変更したファイル>
```

不変条件を書いた直後にその不変条件へ違反するのは、最も基本的で見落としやすいパターン。**同じ関数の別分岐**は特に見落としやすい。

## Step 5 — OSネイティブ関数を自前実装に置き換えたら、プラットフォーム差分を明示的に列挙する

`fs.realpath` のようなOSネイティブ関数を手書きロジックに置き換える(または部分的に迂回する)場合、そのネイティブ関数が暗黙に処理していた可能性のある挙動を明示的に列挙し、1つずつ「維持したか」「意図的に対象外としたか」を判定する。

チェックリストの出発点(詳細は `.claude/rules/path-and-symlink-safety.md`):
- 大文字小文字の扱い(Windowsは環境変数名・パスの大文字小文字を区別しない)
- 短縮名/エイリアス形式(Windows 8.3形式)
- ロケール依存の出力(gettext等で翻訳されるメッセージ)
- 改行・空白・エンコーディングの正規化

ローカル環境で再現できない挙動(Windows短縮名、NLS翻訳等)は、**再現できないことをそのままリスクとして記録し**、該当プラットフォームがCIマトリクスに含まれる場合は実機CIの結果を待つ。ローカルで再現できないことを「問題なし」の根拠にしない。

## Step 6 — 「除去できないか」を先に問う(denylistよりallowlist)

機密情報がエラー/ログに漏れる問題を見つけたら、**まず「その値自体を含めるのをやめられないか」を検討する**。正規表現によるredactionは本質的にdenylist(既知の悪いパターンを検知)であり、[OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)が明記する通り「trivialに迂回可能」という構造的限界を持つ。詳細は `.claude/rules/secure-subprocess-and-credentials.md`。

判断順序:
1. その値(引数の生値、パスの絶対表記等)は本当にエラーに必要か? → 不要なら**含めない**
2. 含める必要がある(デバッグに必須)なら、既知の形状を検知して除去するredaction戦略を採る
3. redaction戦略を採る場合、それが原理的に漏洩経路を塞げていないことを自覚し、コメントに限界を明記する

「もう1個パターンを追加すれば直る」という考えが3回目に出てきたら、それは戦略自体を疑うべきサインです。

## Step 7 — 独立した視点でのアドバーサリアルレビュー

自分(このスキルを呼び出したのと同じ会話の文脈)でのレビューは確証バイアスがかかる。fresh contextの `security-diff-reviewer` サブエージェント(`.claude/agents/security-diff-reviewer.md`)に、変更のあったファイルの現在の内容を渡して独立にレビューさせる。

## Step 8 — 全体検証ゲート

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` を必ず実行してから push する。個別パッケージだけでなくリポジトリ全体で実行する。

## Step 9 — 前提条件を記録する

Step 2〜5で「意図的に対象外とした」項目があれば、コミットメッセージまたはコード内コメントに明記する。次のレビューラウンドで同じ議論を繰り返さないため。

## トラブルシューティング

- **Step 8の検証(lint/typecheck/test/build)が失敗する**: pushを進めない。失敗したコマンドの出力を読み、根本原因を修正してからStep 8をやり直す。テストを通すためだけにプロダクションコードを歪めない(`~/.claude/rules/testing.md`)。
- **Step 7の`security-diff-reviewer`呼び出しが指摘ゼロで返る**: 「問題なし」と「レビューが空振りした」を区別できないため、渡したファイル内容が実際に変更後の最新版か確認する。変更ファイルを絞りすぎて関連する呼び出し元ファイルを渡し忘れていないかもチェックする。
