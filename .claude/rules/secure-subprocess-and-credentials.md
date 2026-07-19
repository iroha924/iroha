---
paths:
  - "packages/*/src/**/*.ts"
---

# Subprocess execution and credential handling

WP-02(`packages/git`)のCodexレビュー6ラウンドで得た知見。子プロセス実行・資格情報が絡むコード(`packages/git`、将来の `packages/forge*`、`packages/adapter-*` 等)を書く/直すときは必ず適用する。

## 環境変数: denylistではなくallowlistを優先する

`{...process.env}` をコピーして危険な変数を `delete` する方式(denylist)は、**知らない変数は絶対に消せない**という構造的な欠陥を持つ。実際にこのセッションでは `GIT_DIR` 系 → `GIT_TRACE` 系 → `GIT_CEILING_DIRECTORIES` → `GIT_REDIRECT_*` と、5ラウンドかけて1つずつ後から発見した。

- 新しいsubprocessラッパーを書くときは、**空の環境から必要な変数だけをコピーする**allowlist方式を優先する(`PATH`、`HOME`、`TEMP`/`TMPDIR` 等、実際に必要なものだけ)
- 既存の `packages/git/src/run-git.ts` のようにdenylistで書かれている箇所を触るときは、新しい変数を1つ追加するだけで満足せず、allowlistへの置き換えを検討する
- **事実**(Node.js公式ドキュメント): Windows上で `child_process` の `env` オプションに大文字小文字違いの同名キーが複数含まれる場合、辞書順で最初にマッチしたものが使われる。これは「自分が渡したオブジェクト内の重複」を解決する話であり、**親プロセスの環境変数を小文字で `delete` し忘れると、そのまま子プロセスに漏れる**(Windowsの環境変数は大文字小文字を区別しないため)。denylistで環境変数を消す実装は、大文字小文字を無視した比較で `delete` すること

## エラーメッセージに生の値を含めない(redactionしない)

**事実**(OWASP Logging Cheat Sheet、CWE-209): パスワード・トークン・接続文字列は「ログに出す前に」除去・マスク・ハッシュ化すべきものであり、後from filtering(収集してから正規表現で除去する)は推奨されるアプローチではない。**事実**(execaのドキュメント確認済み): Node.jsで最も広く使われるsubprocessラッパーであるexecaは、redaction機能を意図的に持たない — エラーメッセージ・`verbose`モードは引数をそのまま含み、機密値の判定を呼び出し側に完全に委ねている。

このプロジェクトでは正規表現ベースのredaction(`credential-redaction.ts`)を6ラウンドかけて磨いたが、それでも「URL形式ですらない秘密値」を原理的に検出できないという天井にぶつかった。**推奨**: 新しいsubprocessラッパー/エラー構築コードでは、

1. まず「この値は本当にエラーに必要か?」を問う。不要なら**含めない**(サブコマンド名・引数の個数・exit code・signalだけを残す)
2. どうしても含める必要がある場合のみ、既知の形状(URL等)のredactionを検討する。ただしこれはdenylistであり、原理的に迂回可能なことをコメントに明記する
3. `error.cause` に生の例外オブジェクト(`ExecFileException`等)をそのまま渡さない。`.message`/`.cmd` に呼び出しコマンド全体が含まれることがある(Node.js確認済み)。redact済みの内容だけを持つ合成Errorに置き換える

## stderrパターンマッチはロケールに依存する

GitのようなCLIツールの人間可読なメッセージ(`fatal: not a git repository` 等)でエラー種別を判定するコードを書く場合、子プロセスの `env` に `LC_ALL=C`、`LANG=C` を設定し、`LANGUAGE` を削除する(GNU gettextは `LANGUAGE` が `LC_ALL`/`LANG` より優先されるため、削除だけでは不十分で明示的に消す必要がある)。ローカルのgitビルドがNLS非対応で翻訳を再現できない場合でも、公式ドキュメントで仕組みが確認できればそれを根拠に対応してよい(実機再現は必須ではない)。

## 関連

- パス解決の安全性は [[path-and-symlink-safety]]
- 一般的なエラーハンドリング規約は [[typescript-conventions]]
