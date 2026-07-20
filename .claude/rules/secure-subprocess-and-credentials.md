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

## 保存前のredaction/sanitizeは、未制約のfree-textフィールドを全て列挙する

WP-07(`packages/core/src/mcp/redact.ts`)のセルフレビューで再発した、冒頭の「denylistは知らないものを消せない」と同じ構造の欠陥。構造化入力(Checkpoint/Proposal等)をローカルDBへ保存する前にsecretをredactする実装で、当初は散文フィールド(title/summary/body)だけをscanし、`guard.denyCommands`(コマンド文字列)・`sources[].url`/`references[].url`(userinfoに資格情報を持てる)・`scope.symbols`・`implementation[].symbol` を素通ししていた。しかもdocstringに「これらはformat制約があるので資格情報を持てない」と**未検証の安全宣言**を書いていた(誤り — これらはenumや相対パスと違い未制約のfree-text)。

- redact/sanitize対象のスキーマを見て、**未制約のfree-textフィールドを1つ残らず列挙**する。配列要素・URL(userinfo)・ネストしたオブジェクト(guard spec等)も対象。「format制約"風"」でも、Zodのenum/正規表現/相対パスで**実際に制約されていない**限りfree-textとして扱う
- **検証していない安全性をdocstring/コメントに書かない**。「このフィールドは安全」と書くなら、そのフィールドのスキーマ制約を実際に確認した根拠を添える。未検証の安全宣言はレビュアーと将来の自分を誤誘導する
- URL等のformatを持つフィールドをredactする場合、後段のバリデーション(承認時の再検証等)を壊さない**format妥当なplaceholder**を使う(例: `https://redacted.invalid/`。`.invalid`はRFC 2606予約TLD)
- ローカルの使い捨てDBが相手でも省略しない。canonical(人間承認・Git commit)と違い保存前に**拒否**はしないが、redactを怠れば平文がat-rest storeに残る

## stderrパターンマッチはロケールに依存する

GitのようなCLIツールの人間可読なメッセージ(`fatal: not a git repository` 等)でエラー種別を判定するコードを書く場合、子プロセスの `env` に `LC_ALL=C`、`LANG=C` を設定し、`LANGUAGE` を削除する(GNU gettextは `LANGUAGE` が `LC_ALL`/`LANG` より優先されるため、削除だけでは不十分で明示的に消す必要がある)。ローカルのgitビルドがNLS非対応で翻訳を再現できない場合でも、公式ドキュメントで仕組みが確認できればそれを根拠に対応してよい(実機再現は必須ではない)。

## 関連

- パス解決の安全性は [[path-and-symlink-safety]]
- 一般的なエラーハンドリング規約は [[typescript-conventions]]
